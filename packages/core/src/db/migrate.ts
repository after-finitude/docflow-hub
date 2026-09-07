import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { join } from 'node:path'
import { Pool } from 'pg'
import { loadMigrationEnv } from '../config/env'

/**
 * Run migrations as the owner role; the application role intentionally lacks
 * DDL permissions (spec §11).
 */
async function main(): Promise<void> {
  const env = loadMigrationEnv()
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL })
  try {
    await migrate(drizzle(pool), { migrationsFolder: join(__dirname, '../../drizzle') })
    console.log('Migrations applied')
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error)
  process.exit(1)
})
