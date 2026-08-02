import type { ActorType } from '@docflow/shared'
import type { Database } from './db.module'
import { auditEvents } from './schema'

export interface AuditEntry {
  correlationId?: string
  actorType: ActorType
  actorId?: string
  action: string
  objectType: string
  objectId?: string
  before?: unknown
  after?: unknown
  result: 'success' | 'failure'
  ip?: string
  userAgent?: string
}

/**
 * Запись в журнал. Таблица только на добавление: роль приложения не имеет
 * UPDATE/DELETE (ТЗ §11), поэтому изменить или удалить запись отсюда нельзя.
 * Из этого же следует, что в журнал нельзя писать то, что потом придётся
 * вычищать, — см. осторожность с логином в AuthService.
 */
export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    correlationId: entry.correlationId ?? null,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    result: entry.result,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
  })
}
