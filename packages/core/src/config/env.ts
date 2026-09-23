import { z } from 'zod'
import { readIntegrationSecret } from './integration-secrets'

/**
 * Fixed application database role, shared by the cluster init script and
 * migration 0001_audit_immutability.sql (spec §11).
 */
export const APP_DB_ROLE = 'docflow_app'

const postgresFields = {
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
}

/**
 * Read configuration from the environment and validate at startup so missing
 * values fail immediately rather than on first use.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // loadEnv builds connection strings from these parts. Avoid duplicate URLs
  // that would eventually drift from the password.
  ...postgresFields,
  APP_DB_PASSWORD: z.string().min(1),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),

  QUEUE_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_OCR: z.coerce.number().int().positive().optional(),
  QUEUE_CONCURRENCY_EXTRACT: z.coerce.number().int().positive().optional(),

  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().positive(),
  MINIO_USE_SSL: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  MINIO_ROOT_USER: z.string().min(1),
  MINIO_ROOT_PASSWORD: z.string().min(1),
  MINIO_BUCKET: z.string().min(1),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(1).max(604800).default(900),
  // Browser-visible storage URL. Signatures cover Host, so an internal
  // http://minio:9000 URL cannot be signed for browser use.
  MINIO_PUBLIC_URL: z.string().url().default('http://localhost:9000'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').optional(),
  JWT_EXPIRES_IN: z.string().default('8h'),
  // Session-cookie Secure flag. Keep it independent from NODE_ENV because
  // browsers silently discard Secure cookies received over plain HTTP.
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // ─── OCR (spec 6.2) ───────────────────────────────────────────────────────
  // mock is deterministic and uses the PDF text layer through PDF.js;
  // google uses Google Cloud Vision.
  OCR_PROVIDER: z.enum(['mock', 'google', 'openrouter']).default('mock'),
  OCR_MODEL: z.string().trim().min(1).default('qwen/qwen3-vl-32b-instruct'),
  // Service-account key path, required when OCR_PROVIDER=google.
  GOOGLE_VISION_KEY_FILE: z.string().optional(),
  INTEGRATION_KEY_FILE: z.string().min(1).optional(),
  // PDF rasterization DPI before external OCR (GCV recommends 150–300).
  OCR_RENDER_DPI: z.coerce.number().int().min(72).max(600).default(200),
  OCR_LANGUAGE_HINTS: z.string().default('ru,en'),

  // ─── LLM (spec 6.3, 6.4) ─────────────────────────────────────────────────
  // mock is deterministic for the demo dataset; openai_compatible accepts any
  // OpenAI-compatible endpoint.
  LLM_PROVIDER: z.enum(['mock', 'openai_compatible']).default('mock'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY_FILE: z.string().min(1).optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_REASONING_EFFORT: z
    .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  LLM_RESPONSE_FORMAT: z.enum(['json_object', 'json_schema']).default('json_object'),

  // ─── Export (spec 6.8) ────────────────────────────────────────────────────
  EXPORT_DEFAULT_DESTINATION: z.enum(['file_json', 'google_sheets']).default('file_json'),
  // Service-account key, required for Google Sheets export.
  GOOGLE_SHEETS_KEY_FILE: z.string().trim().min(1).optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  GOOGLE_SHEETS_SHEET_NAME: z.string().trim().min(1).max(100).default('Documents'),

  // ─── Secondary source (spec 6.1, 6.9) ─────────────────────────────────────
  // none enables UI upload only; local_folder scans a full watched-folder
  // snapshot; google_drive uses a Drive folder with a changes API cursor.
  SOURCE_PROVIDER: z.enum(['none', 'local_folder', 'google_drive']).default('none'),
  SOURCE_SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  LOCAL_SOURCE_DIR: z.string().optional(),
  GOOGLE_DRIVE_KEY_FILE: z.string().optional(),
  GOOGLE_DRIVE_FOLDER_ID: z.string().optional(),

  // ─── Retention and deletion (spec 6.9, §11) ───────────────────────────────
  // Days after deactivation before permanent document deletion.
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  // TTL for storage objects not referenced by any document.
  ORPHAN_TTL_HOURS: z.coerce.number().int().positive().default(24),
  RETENTION_INTERVAL_SECONDS: z.coerce.number().int().positive().default(3600),

  API_PORT: z.coerce.number().int().positive().default(3001),
})

export type Env = z.infer<typeof envSchema> & {
  /** Application connection using a role without UPDATE/DELETE on audit_events. */
  DATABASE_URL: string
  LLM_API_KEY?: string
}

function postgresUrl(
  user: string,
  password: string,
  env: z.infer<z.ZodObject<typeof postgresFields>>,
): string {
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
  return `postgres://${credentials}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`
}

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  service: 'api' | 'worker' = 'worker',
): Env {
  const parsed = envSchema.safeParse(
    Object.fromEntries(Object.entries(source).filter(([, value]) => value !== '')),
  )
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }

  const env = parsed.data
  if (source.LLM_API_KEY)
    throw new Error(
      'Store LLM_API_KEY in an encrypted LLM_API_KEY_FILE; plaintext environment credentials are not supported',
    )
  if (
    (env.LLM_API_KEY_FILE ||
      env.GOOGLE_VISION_KEY_FILE ||
      env.GOOGLE_SHEETS_KEY_FILE ||
      env.GOOGLE_DRIVE_KEY_FILE) &&
    !env.INTEGRATION_KEY_FILE
  ) {
    throw new Error('Encrypted integration credentials require a separate INTEGRATION_KEY_FILE')
  }
  if (service === 'worker' && env.OCR_PROVIDER === 'google' && !env.GOOGLE_VISION_KEY_FILE) {
    throw new Error('OCR_PROVIDER=google requires GOOGLE_VISION_KEY_FILE')
  }
  if (
    service === 'worker' &&
    env.OCR_PROVIDER === 'openrouter' &&
    (!env.LLM_BASE_URL || !env.LLM_API_KEY_FILE)
  )
    throw new Error('OCR_PROVIDER=openrouter requires LLM_BASE_URL and LLM_API_KEY_FILE')
  if (
    service === 'worker' &&
    env.LLM_PROVIDER === 'openai_compatible' &&
    (!env.LLM_BASE_URL || !env.LLM_API_KEY_FILE || !env.LLM_MODEL)
  ) {
    throw new Error(
      'LLM_PROVIDER=openai_compatible requires LLM_BASE_URL, LLM_API_KEY_FILE, and LLM_MODEL',
    )
  }
  if (
    (env.EXPORT_DEFAULT_DESTINATION === 'google_sheets' ||
      env.GOOGLE_SHEETS_KEY_FILE ||
      env.GOOGLE_SHEETS_SPREADSHEET_ID) &&
    (!env.GOOGLE_SHEETS_KEY_FILE || !env.GOOGLE_SHEETS_SPREADSHEET_ID)
  ) {
    throw new Error(
      'Google Sheets export requires GOOGLE_SHEETS_KEY_FILE and GOOGLE_SHEETS_SPREADSHEET_ID',
    )
  }
  if (service === 'worker' && env.SOURCE_PROVIDER === 'local_folder' && !env.LOCAL_SOURCE_DIR) {
    throw new Error('SOURCE_PROVIDER=local_folder requires LOCAL_SOURCE_DIR')
  }
  if (
    service === 'worker' &&
    env.SOURCE_PROVIDER === 'google_drive' &&
    (!env.GOOGLE_DRIVE_KEY_FILE || !env.GOOGLE_DRIVE_FOLDER_ID)
  ) {
    throw new Error(
      'SOURCE_PROVIDER=google_drive requires GOOGLE_DRIVE_KEY_FILE and GOOGLE_DRIVE_FOLDER_ID',
    )
  }
  return {
    ...env,
    DATABASE_URL: postgresUrl(APP_DB_ROLE, env.APP_DB_PASSWORD, env),
    LLM_API_KEY: env.LLM_API_KEY_FILE
      ? readIntegrationSecret(env.LLM_API_KEY_FILE, env.INTEGRATION_KEY_FILE!).trim()
      : undefined,
  }
}

/** Only migration/seed entrypoints load owner and seed credentials. */
export function loadMigrationEnv(source: NodeJS.ProcessEnv = process.env) {
  const env = z
    .object({
      ...postgresFields,
      POSTGRES_USER: z.string().min(1),
      POSTGRES_PASSWORD: z.string().min(1),
      SEED_OPERATOR_LOGIN: z.string().default('operator'),
      SEED_OPERATOR_PASSWORD: z.string().default('operator_password'),
      SEED_ADMIN_LOGIN: z.string().default('admin'),
      SEED_ADMIN_PASSWORD: z.string().default('admin_password'),
    })
    .parse(source)
  return {
    ...env,
    MIGRATION_DATABASE_URL: postgresUrl(env.POSTGRES_USER, env.POSTGRES_PASSWORD, env),
  }
}
