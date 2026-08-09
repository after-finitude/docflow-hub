import { eq } from 'drizzle-orm'
import type { Database } from './db.module'
import { sourceCursors } from './schema'

/**
 * Состояние синхронизации источника (ТЗ 6.1). Курсор живёт в БД: очередь
 * можно очистить или пересоздать, а точка чтения источника переживать это
 * обязана — иначе следующий проход перечитает папку целиком.
 */

export async function readCursor(db: Database, source: string): Promise<string | null> {
  const [row] = await db
    .select({ cursor: sourceCursors.cursor })
    .from(sourceCursors)
    .where(eq(sourceCursors.source, source))
    .limit(1)
  return row?.cursor ?? null
}

export async function writeCursor(
  db: Database,
  source: string,
  cursor: string | null,
  lastError: string | null = null,
): Promise<void> {
  await db
    .insert(sourceCursors)
    .values({ source, cursor, lastSyncAt: new Date(), lastError })
    .onConflictDoUpdate({
      target: sourceCursors.source,
      set: { cursor, lastSyncAt: new Date(), lastError },
    })
}
