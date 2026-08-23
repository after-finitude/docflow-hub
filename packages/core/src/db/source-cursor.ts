import { eq } from 'drizzle-orm'
import type { Database } from './db.module'
import { sourceCursors } from './schema'

/**
 * Source sync state (spec 6.1). Store the cursor in the database so clearing or
 * recreating the queue does not force a full source reread.
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
