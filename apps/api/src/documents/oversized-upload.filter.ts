import {
  Catch,
  Logger,
  PayloadTooLargeException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common'
import type { AcceptedMimeType } from '@docflow/shared'
import type { Response } from 'express'
import { DocumentsService } from './documents.service'
import type { UploadRequest } from './uploaded-document'

/** Multer retains its memory limit; only refusal metadata reaches the database. */
@Catch(PayloadTooLargeException)
export class OversizedUploadFilter implements ExceptionFilter {
  private readonly logger = new Logger(OversizedUploadFilter.name)
  constructor(private readonly documents: DocumentsService) {}

  async catch(error: PayloadTooLargeException, host: ArgumentsHost): Promise<void> {
    const request = host.switchToHttp().getRequest<UploadRequest>()
    const response = host.switchToHttp().getResponse<Response>()
    const file = request.uploadMetadata
    if (!file || !request.user) {
      response.status(413).json(error.getResponse())
      return
    }
    try {
      const document = await this.documents.rejectOversized(
        {
          filename: file.originalname.slice(0, 1024),
          mimeType: file.mimetype as AcceptedMimeType,
          sizeBytes: null,
        },
        request.user,
        {
          ip: request.ip,
          userAgent: request.get('user-agent'),
          correlationId: request.correlationId,
        },
      )
      response
        .status(413)
        .json({ statusCode: 413, message: document.statusReason, documentId: document.id })
    } catch (cause) {
      this.logger.error('Could not record an oversized upload', cause)
      response
        .status(500)
        .json({ message: 'File exceeds 25 MB; the rejection could not be recorded' })
    }
  }
}
