import { ConfigModule, DbModule, QueueModule, StorageModule } from '@docflow/core'
import { Module } from '@nestjs/common'
import { QueueRegistryService } from './queue-registry.service'

@Module({
  imports: [ConfigModule, DbModule, StorageModule, QueueModule],
  providers: [QueueRegistryService],
})
export class AppModule {}
