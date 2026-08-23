import { defineConfig } from 'drizzle-kit'
import { loadEnv } from './src/config/env'

// Build the connection string from POSTGRES_* with the same runtime code. Only
// drizzle-kit commands that reach a live database need it; generate works without it.
const url = process.env.POSTGRES_HOST ? loadEnv().MIGRATION_DATABASE_URL : ''

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
})
