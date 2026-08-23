import type { BoundingBox, ConfidenceSignals, OcrBlock } from '@docflow/shared'
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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

/**
 * Data model from spec §7. PostgreSQL 18 uuidv7() IDs are time-sortable.
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
    // The required scope has one organization; retain a multi-tenant seam
    // without implementing isolation (spec §7 note).
    tenantId: uuid('tenant_id').notNull(),

    sourceType: sourceTypeEnum('source_type').notNull(),
    sourcePath: text('source_path'),
    sourceMessageId: text('source_message_id'),

    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),

    // Object-storage references; the database does not contain file data (spec 6.1).
    storageKey: text('storage_key').notNull(),
    thumbnailKey: text('thumbnail_key'),

    documentType: documentTypeEnum('document_type'),
    typeConfidence: real('type_confidence'),
    pageCount: integer('page_count'),

    // Accept checksum duplicates, link them to the original, and do not export twice (spec §10).
    duplicateOfId: uuid('duplicate_of_id').references((): AnyPgColumn => documents.id),

    status: documentStatusEnum('status').notNull().default('received'),
    statusReason: text('status_reason'),
    versionNumber: integer('version_number').notNull().default(1),
    // Previous version. Source paths could derive this for synced files, but UI
    // uploads lack one and operator replacements must stay linked.
    previousVersionId: uuid('previous_version_id').references((): AnyPgColumn => documents.id, {
      onDelete: 'set null',
    }),
    isActive: boolean('is_active').notNull().default(true),
    // Deactivation time after source removal or replacement. Retention starts
    // here, not at ingest, to avoid immediately deleting old but newly inactive files.
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    index('documents_status_idx').on(t.status),
    index('documents_checksum_idx').on(t.checksum),
    index('documents_received_at_idx').on(t.receivedAt),
    index('documents_type_idx').on(t.documentType),
    // Finding the current version by source path is a hot sync path.
    index('documents_source_path_idx').on(t.sourceType, t.sourcePath),
  ],
)

/**
 * Source sync state (spec 6.1, second source). Store the cursor in the database
 * so it survives queue clearing.
 */
export const sourceCursors = pgTable(
  'source_cursors',
  {
    id: id(),
    source: text('source').notNull(),
    cursor: text('cursor'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [uniqueIndex('source_cursors_source_key').on(t.source)],
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
    // Routing thresholds from spec 6.7, managed through the administrator API.
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
    // Store confidence inputs so revalidation recalculates instead of stacking penalties.
    confidenceSignals: jsonb('confidence_signals').$type<ConfidenceSignals>(),

    sourcePage: integer('source_page'),
    sourceBbox: jsonb('source_bbox').$type<BoundingBox>(),
    // A field without a source cannot have confidence above 0.6 (spec §9).
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

// Use documentExports because CommonJS reserves `exports` in module scope.
export const documentExports = pgTable(
  'exports',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    destination: text('destination').notNull(),
    // Export idempotency (spec §9): the same key cannot create a second object.
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
 * Dead-letter queue for exhausted jobs (spec 6.10, second stage). Stores job
 * input and full error text for the Execution Log and manual retry.
 */
export const deadLetters = pgTable(
  'dead_letters',
  {
    id: id(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => workflowRuns.id, { onDelete: 'cascade' }),
    step: workflowStepEnum('step').notNull(),
    queue: text('queue').notNull(),
    jobId: text('job_id'),
    payload: jsonb('payload'),
    errorCode: text('error_code').notNull(),
    errorMessage: text('error_message').notNull(),
    stack: text('stack'),
    attempts: integer('attempts').notNull().default(0),
    failedAt: timestamp('failed_at', { withTimezone: true }).notNull().defaultNow(),
    retriedAt: timestamp('retried_at', { withTimezone: true }),
    retriedBy: text('retried_by'),
  },
  (t) => [
    index('dead_letters_document_idx').on(t.documentId),
    index('dead_letters_run_idx').on(t.runId),
    index('dead_letters_failed_at_idx').on(t.failedAt),
  ],
)

/**
 * Audit log protected by database roles. The application has no UPDATE/DELETE
 * permission on this table (spec §11, migration 0001).
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
    // Address and client distinguish ordinary failed logins from brute force.
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
