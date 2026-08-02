import { BullModule } from '@nestjs/bullmq'
import { Global, Module } from '@nestjs/common'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'
import { ALL_QUEUES, defaultJobOptionsFor } from './queues'

// Динамические модули очередей нужны и в imports, и в exports: без реэкспорта
// @InjectQueue не разрешится в модулях-потребителях.
const queueModules = ALL_QUEUES.map((name) =>
  BullModule.registerQueue({ name, defaultJobOptions: defaultJobOptionsFor(name) }),
)

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        connection: { host: env.REDIS_HOST, port: env.REDIS_PORT },
      }),
    }),
    ...queueModules,
  ],
  exports: [BullModule, ...queueModules],
})
export class QueueModule {}
