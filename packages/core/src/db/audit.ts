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
 * Append an audit record. The application role has no UPDATE/DELETE permission
 * (spec §11), so never store data here that may need removal; see AuthService.
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
