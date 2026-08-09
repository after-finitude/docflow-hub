import {
  ConfigModule,
  DbModule,
  EventsModule,
  IngestModule,
  QueueModule,
  StorageModule,
  ValidationModule,
} from '@docflow/core'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthModule } from './auth/auth.module'
import { JwtAuthGuard } from './auth/jwt-auth.guard'
import { RolesGuard } from './auth/roles.guard'
import { DocumentsModule } from './documents/documents.module'
import { EventsController } from './events/events.controller'
import { HealthController } from './health/health.controller'
import { RunsModule } from './runs/runs.module'
import { SchemasModule } from './schemas/schemas.module'

@Module({
  imports: [
    ConfigModule,
    DbModule,
    StorageModule,
    QueueModule,
    EventsModule,
    ValidationModule,
    IngestModule,
    AuthModule,
    DocumentsModule,
    SchemasModule,
    RunsModule,
  ],
  controllers: [HealthController, EventsController],
  providers: [
    // Аутентификация обязательна на всех эндпоинтах, кроме помеченных
    // @Public (ТЗ 3.1); проверка роли — вторым слоем.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
