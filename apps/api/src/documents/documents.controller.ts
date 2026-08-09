import {
  ACCEPTED_MIME_TYPES,
  UPLOAD_MAX_BYTES,
  changeTypeRequestSchema,
  documentListQuerySchema,
  type ChangeTypeRequest,
  type DocumentDetail,
  type DocumentListItem,
  type DocumentListPage,
  type DocumentListQuery,
  type DocumentPage,
  type SessionUser,
  type SignedFileLink,
} from '@docflow/shared'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { ENV, type Env } from '@docflow/core'
import { Inject } from '@nestjs/common'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentUser, Origin, type RequestContext } from '../auth/decorators'
import { DocumentsService } from './documents.service'
import type { MulterFileFilter, UploadedDocument } from './uploaded-document'

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      // Превышение лимита Nest сам превращает в 413, неподдерживаемый тип
      // отсекается фильтром ниже — до записи в хранилище и до вызова LLM (ТЗ 6.1).
      limits: { fileSize: UPLOAD_MAX_BYTES },
      fileFilter: ((_request, file, callback) => {
        if ((ACCEPTED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
          callback(null, true)
          return
        }
        callback(
          new BadRequestException(
            `Тип ${file.mimetype} не поддерживается. Допустимы PDF, JPEG и PNG`,
          ),
          false,
        )
      }) satisfies MulterFileFilter,
    }),
  )
  async upload(
    @UploadedFile() file: UploadedDocument | undefined,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentListItem> {
    if (!file) throw new BadRequestException('Файл не передан')
    return this.documents.upload(file, user, origin)
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(documentListQuerySchema)) query: DocumentListQuery,
  ): Promise<DocumentListPage> {
    return this.documents.list(query)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentDetail> {
    return this.documents.findOne(id)
  }

  @Get(':id/pages')
  pages(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentPage[]> {
    return this.documents.pages(id)
  }

  @Get(':id/thumbnail')
  async thumbnail(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const stream = await this.documents.thumbnail(id)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=300')
    stream.pipe(res)
  }

  /** Оригинал выдаётся подписанной ссылкой с ограниченным сроком (ТЗ §8, §11). */
  @Get(':id/file')
  async file(@Param('id', ParseUUIDPipe) id: string): Promise<SignedFileLink> {
    return {
      url: await this.documents.signedFileUrl(id),
      expiresInSeconds: this.env.SIGNED_URL_TTL_SECONDS,
    }
  }

  /** Ручная смена типа с перезапуском извлечения по новой схеме (ТЗ 6.3). */
  @Post(':id/type')
  changeType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(changeTypeRequestSchema)) body: ChangeTypeRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.documents.changeType(id, body.type, user, origin)
  }

  @Post(':id/reprocess')
  reprocess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.documents.reprocess(id, user, origin)
  }
}
