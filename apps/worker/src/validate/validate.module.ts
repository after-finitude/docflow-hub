import { Module } from '@nestjs/common'
import { ValidateProcessor } from './validate.processor'

@Module({
  providers: [ValidateProcessor],
})
export class ValidateModule {}
