import { Module } from '@nestjs/common'
import { ExtractProcessor } from './extract.processor'

@Module({
  providers: [ExtractProcessor],
})
export class ExtractModule {}
