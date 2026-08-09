import { Global, Module } from '@nestjs/common'
import { ValidationRunnerService } from './validation-runner.service'

@Global()
@Module({
  providers: [ValidationRunnerService],
  exports: [ValidationRunnerService],
})
export class ValidationModule {}
