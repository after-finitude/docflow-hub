import { Global, Module, type DynamicModule } from '@nestjs/common'
import { loadEnv, type Env } from './env'

export const ENV = Symbol('ENV')

@Global()
@Module({})
export class ConfigModule {
  static forService(service: 'api' | 'worker'): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: ENV, useFactory: (): Env => loadEnv(process.env, service) }],
      exports: [ENV],
    }
  }
}
