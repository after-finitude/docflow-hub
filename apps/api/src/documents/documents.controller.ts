import {
  ACCEPTED_MIME_TYPES,
  UPLOAD_MAX_BYTES,
  changeTypeRequestSchema,
  documentListQuerySchema,
  rejectRequestSchema,
  updateFieldRequestSchema,
  exportRequestSchema,
  type ChangeTypeRequest,
  type ExportDto,
  type ExportRequest,
  type RejectRequest,
  type UpdateFieldRequest,
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
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
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
import { ExportService } from '../export/export.service'
import { PageRenderService } from './page-render.service'
import type { MulterFileFilter, UploadedDocument } from './uploaded-document'

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly pageRender: PageRenderService,
    private readonly exports: ExportService,
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

  /** Страница документа в PNG для просмотрщика (ТЗ 5.2). */
  @Get(':id/pages/:page/image')
  async pageImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('page', ParseIntPipe) page: number,
    @Query('width') width: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const location = await this.documents.fileLocation(id)
    // Ширина ограничена: запрос произвольного размера — это управляемая
    // клиентом нагрузка на рендер.
    const targetWidth = Math.min(Math.max(Number(width) || 1200, 120), 2400)
    const png = await this.pageRender.render(
      location.storageKey,
      location.mimeType,
      page,
      targetWidth,
    )

    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=600')
    res.send(png)
  }

  /** Правка значения оператором: синхронно перевалидирует документ (ТЗ 5.2, §9). */
  @Patch(':id/fields/:name')
  updateField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(updateFieldRequestSchema)) body: UpdateFieldRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.documents.updateField(id, name, body.value, user, origin)
  }

  @Post(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.documents.approve(id, user, origin)
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectRequestSchema)) body: RejectRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.documents.reject(id, body, user, origin)
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

  /** Экспорт подтверждённого документа; идемпотентен по export_key (ТЗ 6.8, §9). */
  @Post(':id/export')
  exportDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(exportRequestSchema)) body: ExportRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<ExportDto> {
    return this.exports.export(id, body, user, origin)
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
