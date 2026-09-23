import { OversizedUploadFilter } from './oversized-upload.filter'
import { Module } from '@nestjs/common'
import { ExportModule } from '../export/export.module'
import { DocumentsController } from './documents.controller'
import { DocumentFilesService } from './document-files.service'
import { DocumentLifecycleService } from './document-lifecycle.service'
import { DocumentQueryService } from './document-query.service'
import { PageRenderService } from './page-render.service'

@Module({
  imports: [ExportModule],
  controllers: [DocumentsController],
  providers: [
    DocumentQueryService,
    DocumentLifecycleService,
    DocumentFilesService,
    PageRenderService,
    OversizedUploadFilter,
  ],
})
export class DocumentsModule {}
