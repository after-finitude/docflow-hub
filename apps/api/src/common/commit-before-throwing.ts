import type { Database } from '@docflow/core'
import { HttpException } from '@nestjs/common'

/**
 * Run `work` in a transaction and throw the HttpException it returns only after
 * commit, so writes made before the refusal (refreshed validation issues, a
 * status change) persist. Throwing inside the transaction would roll them back.
 */
export async function commitBeforeThrowing<T>(
  db: Database,
  work: (tx: Database) => Promise<T | HttpException>,
): Promise<T> {
  const result = await db.transaction(work)
  if (result instanceof HttpException) throw result
  return result
}
