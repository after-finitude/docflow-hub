import { Module } from '@nestjs/common'
import { PreprocessProcessor } from './preprocess.processor'

@Module({
  providers: [PreprocessProcessor],
})
export class PreprocessModule {}
