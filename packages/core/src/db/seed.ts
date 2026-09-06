import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { hashPassword } from '../auth/password'
import { loadEnv } from '../config/env'
import * as schema from './schema'
import { users } from './schema'
import { seedSchemas } from './schemas'

/**
 * Seed the required two users (spec 3.1) and four document-type schemas (spec 6.4).
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL })
  const db = drizzle(pool, { schema })

  try {
    const seedUsers = [
      {
        login: env.SEED_OPERATOR_LOGIN,
        passwordHash: await hashPassword(env.SEED_OPERATOR_PASSWORD),
        role: 'operator' as const,
      },
      {
        login: env.SEED_ADMIN_LOGIN,
        passwordHash: await hashPassword(env.SEED_ADMIN_PASSWORD),
        role: 'admin' as const,
      },
    ]

    // Update password and role from configuration on conflict so a persisted
    // volume survives hash-format or SEED_*_PASSWORD changes without breaking login.
    for (const user of seedUsers) {
      const [saved] = await db
        .insert(users)
        .values(user)
        .onConflictDoUpdate({
          target: users.login,
          set: { passwordHash: user.passwordHash, role: user.role },
        })
        .returning({ login: users.login, role: users.role })

      console.log(`User ${saved.login} (${saved.role}) updated`)
    }

    await seedSchemas(db)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
