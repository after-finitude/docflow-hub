/**
 * The row of a statement that must return exactly one: `insert/update … returning`
 * on an existing row, or an aggregate. An empty result is a bug; fail here with
 * its name instead of a TypeError on first use.
 */
export function single<T>(rows: T[], what: string): T {
  const [row] = rows
  if (row === undefined) throw new Error(`Expected a row from ${what}, got none`)
  return row
}
