import { CLASSIFIABLE_DOCUMENT_TYPES } from '@docflow/shared'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { hashPassword } from '../auth/password'
import { loadEnv } from '../config/env'
import { documentSchemas, users } from './schema'
import { SEED_RULES } from './seed-rules'
import { DEFAULT_THRESHOLDS, SEED_SCHEMAS } from './seed-schemas'

/**
 * Seed the required two users (spec 3.1) and four document-type schemas (spec 6.4).
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL })
  const db = drizzle(pool)

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

    // Keep every persisted schema version in the current language without
    // overwriting thresholds managed by an administrator through the API.
    for (const documentType of CLASSIFIABLE_DOCUMENT_TYPES) {
      const jsonSchema = { fields: SEED_SCHEMAS[documentType], rules: SEED_RULES[documentType] }
      const [existing] = await db
        .select({ id: documentSchemas.id })
        .from(documentSchemas)
        .where(and(eq(documentSchemas.documentType, documentType), eq(documentSchemas.version, 1)))
        .limit(1)

      if (existing) {
        await db
          .update(documentSchemas)
          .set({ jsonSchema })
          .where(eq(documentSchemas.documentType, documentType))
        console.log(`Schemas for ${documentType} updated`)
      } else {
        await db.insert(documentSchemas).values({
          documentType,
          version: 1,
          jsonSchema,
          thresholds: DEFAULT_THRESHOLDS,
          isActive: true,
        })
        console.log(`Schema ${documentType} v1 created`)
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error)
  process.exit(1)
})
