import { Module } from '@nestjs/common'
import { ExportModule } from '../export/export.module'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { PageRenderService } from './page-render.service'

@Module({
  imports: [ExportModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, PageRenderService],
})
export class DocumentsModule {}
