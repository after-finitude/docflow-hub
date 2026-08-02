import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { hashPassword } from '../auth/password'
import { loadEnv } from '../config/env'
import { users } from './schema'

/**
 * Seed обязательного объёма (ТЗ 3.1): ровно два пользователя.
 * Регистрация и управление пользователями в объём не входят.
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
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('Seed не выполнен:', error)
  process.exit(1)
})
