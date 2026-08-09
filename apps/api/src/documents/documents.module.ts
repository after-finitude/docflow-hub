import { Module } from '@nestjs/common'
import { DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { PageRenderService } from './page-render.service'

@Module({
  controllers: [DocumentsController],
  providers: [DocumentsService, PageRenderService],
})
export class DocumentsModule {}
