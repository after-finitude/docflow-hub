import { Body, Controller, Get, Put } from '@nestjs/common'
import { exportSettingsSchema, type ExportSettings, type SessionUser } from '@docflow/shared'
import { CurrentUser, Origin, Roles, type RequestContext } from '../auth/decorators'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { ExportService } from './export.service'

@Controller('settings/export')
@Roles('admin')
export class ExportSettingsController {
  constructor(private readonly exports: ExportService) {}

  @Get()
  settings() {
    return this.exports.settings()
  }

  @Put()
  update(
    @Body(new ZodValidationPipe(exportSettingsSchema)) settings: ExportSettings,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ) {
    return this.exports.updateSettings(settings, user, origin)
  }
}
