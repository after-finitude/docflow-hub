import {
  runListQuerySchema,
  type RunListItem,
  type RunListPage,
  type RunListQuery,
  type SessionUser,
} from '@docflow/shared'
import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common'
import { CurrentUser, Origin, type RequestContext } from '../auth/decorators'
import { ZodValidationPipe } from '../common/zod-validation.pipe'
import { RunsService } from './runs.service'

/** Журнал выполнения этапов, экран Execution Log (ТЗ 5.3, §8). */
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(runListQuerySchema)) query: RunListQuery,
  ): Promise<RunListPage> {
    return this.runs.list(query)
  }

  @Post(':id/retry')
  retry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<RunListItem> {
    return this.runs.retry(id, user, origin)
  }

  /** Отказ от автоматической обработки: документ уходит оператору (ТЗ 5.3). */
  @Post(':id/manual')
  toManual(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<RunListItem> {
    return this.runs.toManual(id, user, origin)
  }
}
