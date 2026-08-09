import { Module } from '@nestjs/common'
import { ClassifyProcessor } from './classify.processor'

@Module({
  providers: [ClassifyProcessor],
})
export class ClassifyModule {}
