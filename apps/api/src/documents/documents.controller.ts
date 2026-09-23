import {
  ACCEPTED_MIME_TYPES,
  reviewMetricsQuerySchema,
  oversizedUploadRequestSchema,
  type OversizedUploadRequest,
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
  Header,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
  UseFilters,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { Response } from 'express'
import { ENV, type Env } from '@docflow/core'
import { Inject } from '@nestjs/common'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { CurrentUser, Origin, Roles, type RequestContext } from '../auth/decorators'
import { DocumentFilesService } from './document-files.service'
import { DocumentLifecycleService } from './document-lifecycle.service'
import { DocumentQueryService } from './document-query.service'
import { ExportService } from '../export/export.service'
import { PageRenderService } from './page-render.service'
import { OversizedUploadFilter } from './oversized-upload.filter'
import type { MulterFileFilter, UploadedDocument, UploadRequest } from './uploaded-document'

/**
 * File ingest limits (spec 6.1), shared by upload and original replacement.
 * Nest returns 413 above the limit; the filter rejects unsupported types before
 * storage writes or LLM calls.
 */
const UPLOAD_INTERCEPTOR_OPTIONS = {
  // Busboy fires the limit at equality; allow the inclusive 25 MB boundary.
  limits: { fileSize: UPLOAD_MAX_BYTES + 1 },
  fileFilter: ((request, file, callback) => {
    ;(request as UploadRequest).uploadMetadata = {
      originalname: file.originalname,
      mimetype: file.mimetype,
    }
    if ((ACCEPTED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      callback(null, true)
      return
    }
    callback(
      new BadRequestException(`Type ${file.mimetype} is unsupported. Use PDF, JPEG, or PNG`),
      false,
    )
  }) satisfies MulterFileFilter,
}

@Controller('documents')
@UseFilters(OversizedUploadFilter)
export class DocumentsController {
  constructor(
    private readonly queries: DocumentQueryService,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly files: DocumentFilesService,
    private readonly pageRender: PageRenderService,
    private readonly exports: ExportService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('review-metrics')
  @Roles('admin')
  async reviewMetrics(
    @Query(new ZodValidationPipe(reviewMetricsQuerySchema)) query: { since?: string },
  ) {
    return {
      review: await this.queries.reviewMetrics(query.since),
      providers: {
        ocr: this.env.OCR_PROVIDER ?? 'mock',
        ocrModel: this.env.OCR_PROVIDER === 'openrouter' ? this.env.OCR_MODEL : null,
        llm: this.env.LLM_PROVIDER ?? 'mock',
        model: this.env.LLM_MODEL ?? null,
      },
      concurrency: {
        default: this.env.QUEUE_CONCURRENCY_DEFAULT ?? 4,
        ocr: this.env.QUEUE_CONCURRENCY_OCR ?? this.env.QUEUE_CONCURRENCY_DEFAULT ?? 4,
        extraction: this.env.QUEUE_CONCURRENCY_EXTRACT ?? this.env.QUEUE_CONCURRENCY_DEFAULT ?? 4,
      },
    }
  }

  @Post(':id/review-opened')
  openReview(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<void> {
    return this.lifecycle.openReview(id, user, origin)
  }

  @Post('oversized')
  rejectOversized(
    @Body(new ZodValidationPipe(oversizedUploadRequestSchema)) body: OversizedUploadRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentListItem> {
    return this.files.rejectOversized(body, user, origin)
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', UPLOAD_INTERCEPTOR_OPTIONS))
  async upload(
    @UploadedFile() file: UploadedDocument | undefined,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentListItem> {
    if (!file) throw new BadRequestException('No file provided')
    return this.files.upload(file, user, origin)
  }

  /**
   * Original replacement (spec §10). Reuse the upload filter and limit.
   */
  @Post(':id/file')
  @UseInterceptors(FileInterceptor('file', UPLOAD_INTERCEPTOR_OPTIONS))
  async replaceFile(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedDocument | undefined,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentListItem> {
    if (!file) throw new BadRequestException('No file provided')
    return this.files.replaceFile(id, file, user, origin)
  }

  @Get()
  list(
    @Query(new ZodValidationPipe(documentListQuerySchema)) query: DocumentListQuery,
  ): Promise<DocumentListPage> {
    return this.queries.list(query)
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentDetail> {
    return this.queries.findOne(id)
  }

  @Get(':id/pages')
  pages(@Param('id', ParseUUIDPipe) id: string): Promise<DocumentPage[]> {
    return this.queries.pages(id)
  }

  /**
   * The response is streamed, so passthrough is unsafe: Nest would end the
   * response when the method returns while the stream is still writing,
   * causing ERR_STREAM_WRITE_AFTER_END and potentially terminating the process.
   */
  @Get(':id/thumbnail')
  async thumbnail(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const stream = await this.files.thumbnail(id)
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=300')
    // If storage reading fails after headers are sent, no valid error status
    // remains; terminate the connection.
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  /** Return the original through a short-lived signed URL (spec §8, §11). */
  @Get(':id/file')
  async file(@Param('id', ParseUUIDPipe) id: string): Promise<SignedFileLink> {
    return {
      url: await this.files.signedFileUrl(id),
      expiresInSeconds: this.env.SIGNED_URL_TTL_SECONDS,
    }
  }

  /** Document page rendered as PNG for the viewer (spec 5.2). */
  @Get(':id/pages/:page/image')
  async pageImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('page', ParseIntPipe) page: number,
    @Query('width') width: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const location = await this.files.fileLocation(id)
    // Cap width so clients cannot request arbitrarily expensive renders.
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

  /** Operator value edit: synchronously revalidate the document (spec 5.2, §9). */
  @Patch(':id/fields/:name')
  updateField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(updateFieldRequestSchema)) body: UpdateFieldRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.lifecycle.updateField(id, name, body.value, user, origin)
  }

  @Post(':id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.lifecycle.approve(id, user, origin)
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rejectRequestSchema)) body: RejectRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.lifecycle.reject(id, body, user, origin)
  }

  /** Manual type change restarting extraction with the new schema (spec 6.3). */
  @Post(':id/type')
  changeType(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(changeTypeRequestSchema)) body: ChangeTypeRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.lifecycle.changeType(id, body.type, user, origin)
  }

  /** Export an approved document, idempotent by export_key (spec 6.8, §9). */
  @Post(':id/export')
  exportDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(exportRequestSchema)) body: ExportRequest,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<ExportDto> {
    return this.exports.export(id, body, user, origin)
  }

  @Get(':id/exports/:exportId/file')
  @Header('Cache-Control', 'private, no-store')
  async downloadExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
  ): Promise<StreamableFile> {
    return new StreamableFile(await this.exports.downloadJson(id, exportId), {
      type: 'application/json',
      disposition: `attachment; filename="docflow-${id}.json"`,
    })
  }

  @Post(':id/reprocess')
  reprocess(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentDetail> {
    return this.lifecycle.reprocess(id, user, origin)
  }
}
