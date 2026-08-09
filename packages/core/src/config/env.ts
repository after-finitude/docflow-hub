import { z } from 'zod'

/**
 * Роль приложения в БД. Зафиксирована: то же имя в init-скрипте кластера
 * и в миграции 0001_audit_immutability.sql (ТЗ §11).
 */
export const APP_DB_ROLE = 'docflow_app'

/**
 * Конфигурация читается из окружения и валидируется при старте:
 * приложение падает сразу, а не на первом обращении к недостающей переменной.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Строки подключения собираются из этих частей — см. loadEnv. Готовых URL
  // в окружении нет намеренно: пароль в двух местах рано или поздно разъедется.
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
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
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Адрес, по которому хранилище доступно браузеру. Подпись ссылки покрывает
  // заголовок Host, поэтому подписывать внутренним адресом контейнера нельзя:
  // ссылка на http://minio:9000 из браузера не открывается.
  MINIO_PUBLIC_URL: z.string().url().default('http://localhost:9000'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET должен быть не короче 32 символов'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  // Флаг Secure у session-cookie. Отдельная переменная, а не производная от
  // NODE_ENV: браузер отбрасывает Secure-cookie, пришедшую по обычному HTTP,
  // и вход ломается молча — сервер отвечает 200, а сессии нет.
  COOKIE_SECURE: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),

  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  LOGIN_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

  // ─── OCR (ТЗ 6.2) ─────────────────────────────────────────────────────────
  // mock — детерминированный провайдер без внешних вызовов (текстовый слой PDF
  // через mupdf); google — Google Cloud Vision.
  OCR_PROVIDER: z.enum(['mock', 'google']).default('mock'),
  // Путь к ключу service account; обязателен при OCR_PROVIDER=google.
  GOOGLE_VISION_KEY_FILE: z.string().optional(),
  // DPI растеризации страниц PDF перед внешним OCR (GCV рекомендует 150–300).
  OCR_RENDER_DPI: z.coerce.number().int().min(72).max(600).default(200),
  OCR_LANGUAGE_HINTS: z.string().default('ru,en'),

  // ─── LLM (ТЗ 6.3, 6.4) ────────────────────────────────────────────────────
  // mock — детерминированный провайдер под формат демо-набора; openai_compatible —
  // любой OpenAI-совместимый endpoint (DeepSeek, OpenAI и т.п.).
  LLM_PROVIDER: z.enum(['mock', 'openai_compatible']).default('mock'),
  LLM_BASE_URL: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  // ─── Экспорт (ТЗ 6.8) ─────────────────────────────────────────────────────
  EXPORT_DEFAULT_DESTINATION: z.enum(['file_json', 'google_sheets']).default('file_json'),
  // Ключ service account; обязателен при экспорте в Google Sheets.
  GOOGLE_SHEETS_KEY_FILE: z.string().optional(),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().optional(),
  GOOGLE_SHEETS_SHEET_NAME: z.string().default('Documents'),

  SEED_OPERATOR_LOGIN: z.string().default('operator'),
  SEED_OPERATOR_PASSWORD: z.string().default('operator_password'),
  SEED_ADMIN_LOGIN: z.string().default('admin'),
  SEED_ADMIN_PASSWORD: z.string().default('admin_password'),

  API_PORT: z.coerce.number().int().positive().default(3001),
})

export type Env = z.infer<typeof envSchema> & {
  /** Подключение приложения: роль без UPDATE/DELETE на audit_events. */
  DATABASE_URL: string
  /** Подключение владельца схемы: миграции и seed. */
  MIGRATION_DATABASE_URL: string
}

function postgresUrl(user: string, password: string, env: z.infer<typeof envSchema>): string {
  const credentials = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`
  return `postgres://${credentials}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n')
    throw new Error(`Некорректная конфигурация окружения:\n${details}`)
  }

  const env = parsed.data
  if (env.OCR_PROVIDER === 'google' && !env.GOOGLE_VISION_KEY_FILE) {
    throw new Error('OCR_PROVIDER=google требует GOOGLE_VISION_KEY_FILE')
  }
  if (
    env.LLM_PROVIDER === 'openai_compatible' &&
    (!env.LLM_BASE_URL || !env.LLM_API_KEY || !env.LLM_MODEL)
  ) {
    throw new Error('LLM_PROVIDER=openai_compatible требует LLM_BASE_URL, LLM_API_KEY и LLM_MODEL')
  }
  if (
    env.EXPORT_DEFAULT_DESTINATION === 'google_sheets' &&
    (!env.GOOGLE_SHEETS_KEY_FILE || !env.GOOGLE_SHEETS_SPREADSHEET_ID)
  ) {
    throw new Error(
      'Экспорт в Google Sheets требует GOOGLE_SHEETS_KEY_FILE и GOOGLE_SHEETS_SPREADSHEET_ID',
    )
  }
  return {
    ...env,
    DATABASE_URL: postgresUrl(APP_DB_ROLE, env.APP_DB_PASSWORD, env),
    MIGRATION_DATABASE_URL: postgresUrl(env.POSTGRES_USER, env.POSTGRES_PASSWORD, env),
  }
}
