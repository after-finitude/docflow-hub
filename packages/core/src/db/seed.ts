import { CLASSIFIABLE_DOCUMENT_TYPES } from '@docflow/shared'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { hashPassword } from '../auth/password'
import { loadEnv } from '../config/env'
import { documentSchemas, users } from './schema'
import { DEFAULT_THRESHOLDS, SEED_SCHEMAS } from './seed-schemas'

/**
 * Seed обязательного объёма: два пользователя (ТЗ 3.1) и схемы четырёх
 * типов документов (ТЗ 6.4).
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

    // Пароль и роль приводятся к значениям из конфигурации, а не пропускаются
    // при конфликте: иначе на томе, переживившем смену формата хэша или правку
    // SEED_*_PASSWORD, вход отказывал бы без единого следа в журнале.
    for (const user of seedUsers) {
      const [saved] = await db
        .insert(users)
        .values(user)
        .onConflictDoUpdate({
          target: users.login,
          set: { passwordHash: user.passwordHash, role: user.role },
        })
        .returning({ login: users.login, role: users.role })

      console.log(`Пользователь ${saved.login} (${saved.role}) актуализирован`)
    }

    // Версия 1 каждой схемы приводится к коду; пороги при апдейте не трогаются —
    // их правит администратор через API, и seed не должен их откатывать.
    for (const documentType of CLASSIFIABLE_DOCUMENT_TYPES) {
      const jsonSchema = { fields: SEED_SCHEMAS[documentType] }
      const [existing] = await db
        .select({ id: documentSchemas.id })
        .from(documentSchemas)
        .where(and(eq(documentSchemas.documentType, documentType), eq(documentSchemas.version, 1)))
        .limit(1)

      if (existing) {
        await db
          .update(documentSchemas)
          .set({ jsonSchema })
          .where(eq(documentSchemas.id, existing.id))
        console.log(`Схема ${documentType} v1 актуализирована`)
      } else {
        await db.insert(documentSchemas).values({
          documentType,
          version: 1,
          jsonSchema,
          thresholds: DEFAULT_THRESHOLDS,
          isActive: true,
        })
        console.log(`Схема ${documentType} v1 создана`)
      }
    }
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Seed не выполнен:', error)
  process.exit(1)
})
