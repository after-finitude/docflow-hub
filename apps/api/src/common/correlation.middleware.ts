import type { NextFunction, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { AuthenticatedRequest } from '../auth/decorators'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Сквозной идентификатор запроса: связывает записи журнала и — начиная
 * с этапа 3 — шаги обработки документа в WorkflowRun.
 *
 * Обычная express-функция, а не Nest-middleware: подключается через app.use
 * и не зависит от синтаксиса маршрутов, который менялся вместе с Express 5.
 */
export function correlationMiddleware(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.get('x-correlation-id')
  // Колонка correlation_id имеет тип uuid, поэтому произвольную строку
  // из заголовка принять нельзя — иначе вставка в журнал упадёт.
  request.correlationId = incoming && UUID_PATTERN.test(incoming) ? incoming : randomUUID()
  response.setHeader('x-correlation-id', request.correlationId)
  next()
}
