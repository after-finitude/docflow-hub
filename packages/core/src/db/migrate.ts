import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { join } from 'node:path'
import { Pool } from 'pg'
import { loadEnv } from '../config/env'

/**
 * Миграции выполняются под ролью-владельцем: роль приложения намеренно
 * не имеет прав на DDL (ТЗ §11).
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL })
  try {
    await migrate(drizzle(pool), { migrationsFolder: join(__dirname, '../../drizzle') })
    console.log('Миграции применены')
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Миграции не применены:', error)
  process.exit(1)
})
