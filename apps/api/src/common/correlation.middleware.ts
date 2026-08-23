import type { NextFunction, Response } from 'express'
import { randomUUID } from 'node:crypto'
import type { AuthenticatedRequest } from '../auth/decorators'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * End-to-end request ID linking audit entries and, from stage 3 onward,
 * document processing steps in WorkflowRun.
 *
 * A plain Express function registered with app.use, independent of route
 * syntax that changed with Express 5.
 */
export function correlationMiddleware(
  request: AuthenticatedRequest,
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.get('x-correlation-id')
  // correlation_id is a UUID column, so reject arbitrary header values that
  // would make audit inserts fail.
  request.correlationId = incoming && UUID_PATTERN.test(incoming) ? incoming : randomUUID()
  response.setHeader('x-correlation-id', request.correlationId)
  next()
}
