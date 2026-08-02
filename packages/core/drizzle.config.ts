import { defineConfig } from 'drizzle-kit'
import { loadEnv } from './src/config/env'

// Строка подключения собирается из POSTGRES_* тем же кодом, что и в рантайме:
// готового URL в окружении нет. Нужна только командам drizzle-kit, которые
// обращаются к живой БД (push, studio); generate работает и без неё.
const url = process.env.POSTGRES_HOST ? loadEnv().MIGRATION_DATABASE_URL : ''

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
})
