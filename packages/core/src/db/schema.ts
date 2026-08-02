import type { BoundingBox, OcrBlock } from '@docflow/shared'
import {
  ACTOR_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  EXPORT_STATUSES,
  ISSUE_SEVERITIES,
  SOURCE_TYPES,
  USER_ROLES,
  VALUE_TYPES,
  WORKFLOW_STATES,
  WORKFLOW_STEPS,
} from '@docflow/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Модель данных по ТЗ §7.
 * Идентификаторы — uuidv7() из PostgreSQL 18: сортируемость по времени.
 */

export const userRoleEnum = pgEnum('user_role', USER_ROLES)
export const documentStatusEnum = pgEnum('document_status', DOCUMENT_STATUSES)
export const documentTypeEnum = pgEnum('document_type', DOCUMENT_TYPES)
export const sourceTypeEnum = pgEnum('source_type', SOURCE_TYPES)
export const valueTypeEnum = pgEnum('value_type', VALUE_TYPES)
export const issueSeverityEnum = pgEnum('issue_severity', ISSUE_SEVERITIES)
export const workflowStepEnum = pgEnum('workflow_step', WORKFLOW_STEPS)
export const workflowStateEnum = pgEnum('workflow_state', WORKFLOW_STATES)
export const exportStatusEnum = pgEnum('export_status', EXPORT_STATUSES)
export const actorTypeEnum = pgEnum('actor_type', ACTOR_TYPES)

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`)

export const users = pgTable(
  'users',
  {
    id: id(),
    login: text('login').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: userRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_login_key').on(t.login)],
)

export const documents = pgTable(
  'documents',
  {
    id: id(),
    // Одна организация в обязательном объёме; задел на multi-tenant без
    // реализации изоляции (ТЗ §7, примечание).
    tenantId: uuid('tenant_id').notNull(),

    sourceType: sourceTypeEnum('source_type').notNull(),
    sourcePath: text('source_path'),
    sourceMessageId: text('source_message_id'),

    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),

    // Ссылки на объектное хранилище: в БД сам файл не лежит (ТЗ 6.1).
    storageKey: text('storage_key').notNull(),
    thumbnailKey: text('thumbnail_key'),

    documentType: documentTypeEnum('document_type'),
    typeConfidence: real('type_confidence'),

    status: documentStatusEnum('status').notNull().default('received'),
    statusReason: text('status_reason'),
    versionNumber: integer('version_number').notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('documents_status_idx').on(t.status),
    index('documents_checksum_idx').on(t.checksum),
    index('documents_received_at_idx').on(t.receivedAt),
    index('documents_type_idx').on(t.documentType),
  ],
)

export const pages = pgTable(
  'pages',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    ocrText: text('ocr_text'),
    ocrConfidence: real('ocr_confidence'),
    width: integer('width'),
    height: integer('height'),
    blocks: jsonb('blocks').$type<OcrBlock[]>(),
  },
  (t) => [uniqueIndex('pages_document_page_key').on(t.documentId, t.pageNumber)],
)

export const documentSchemas = pgTable(
  'document_schemas',
  {
    id: id(),
    documentType: documentTypeEnum('document_type').notNull(),
    version: integer('version').notNull(),
    jsonSchema: jsonb('json_schema').notNull(),
    // Пороги маршрутизации, ТЗ 6.7: меняются через API администратора.
    thresholds: jsonb('thresholds').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('document_schemas_type_version_key').on(t.documentType, t.version)],
)

export const fields = pgTable(
  'fields',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    schemaVersionId: uuid('schema_version_id').references(() => documentSchemas.id),
    name: text('name').notNull(),

    rawValue: text('raw_value'),
    normalizedValue: jsonb('normalized_value'),
    valueType: valueTypeEnum('value_type').notNull(),

    confidence: real('confidence'),
    confidenceReason: text('confidence_reason'),

    sourcePage: integer('source_page'),
    sourceBbox: jsonb('source_bbox').$type<BoundingBox>(),
    // Поле без найденного источника не может иметь confidence > 0.6 (ТЗ §9).
    sourceFound: boolean('source_found').notNull().default(false),

    isCritical: boolean('is_critical').notNull().default(false),
    isEdited: boolean('is_edited').notNull().default(false),
  },
  (t) => [uniqueIndex('fields_document_name_key').on(t.documentId, t.name)],
)

export const validationIssues = pgTable(
  'validation_issues',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    fieldName: text('field_name'),
    ruleId: text('rule_id').notNull(),
    severity: issueSeverityEnum('severity').notNull(),
    message: text('message').notNull(),
    expected: text('expected'),
    actual: text('actual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('validation_issues_document_idx').on(t.documentId),
    index('validation_issues_severity_idx').on(t.severity),
  ],
)

// Имя documentExports, а не exports: CommonJS резервирует `exports`
// в области видимости модуля. Таблица в БД называется exports.
export const documentExports = pgTable(
  'exports',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(),
    // Идемпотентность выгрузки, ТЗ §9: повторный запрос с тем же ключом
    // не создаёт второй объект.
    exportKey: text('export_key').notNull(),
    status: exportStatusEnum('status').notNull().default('pending'),
    payloadRef: text('payload_ref'),
    errorCode: text('error_code'),
    attempts: integer('attempts').notNull().default(0),
    exportedAt: timestamp('exported_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('exports_export_key_key').on(t.exportKey),
    index('exports_document_idx').on(t.documentId),
  ],
)

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    step: workflowStepEnum('step').notNull(),
    state: workflowStateEnum('state').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    correlationId: uuid('correlation_id').notNull(),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('workflow_runs_document_idx').on(t.documentId),
    index('workflow_runs_correlation_idx').on(t.correlationId),
    index('workflow_runs_state_idx').on(t.state),
  ],
)

/**
 * Журнал действий. Защищён от изменения на уровне ролей БД: роль приложения
 * не имеет UPDATE/DELETE на эту таблицу (ТЗ §11, миграция 0001).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .default(sql`uuidv7()`),
    correlationId: uuid('correlation_id'),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    result: text('result').notNull(),
    // Без адреса и клиента журнал аутентификации бесполезен: неудачные входы
    // невозможно отличить от перебора с одного адреса.
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_events_object_idx').on(t.objectType, t.objectId),
    index('audit_events_correlation_idx').on(t.correlationId),
    index('audit_events_created_at_idx').on(t.createdAt),
  ],
)
