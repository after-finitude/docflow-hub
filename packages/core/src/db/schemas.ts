import {
  schemaFieldsSchema,
  thresholdsSchema,
  schemaConfigurationSchema,
  CLASSIFIABLE_DOCUMENT_TYPES,
  type DocumentType,
  type DocumentSchemaDto,
  type SchemaConfiguration,
} from '@docflow/shared'
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Database } from './db.module'
import { documentSchemas, documents, fields } from './schema'
import { writeAudit } from './audit'
import { single } from './rows'
import { EXPORT_MAPPINGS } from '../export/mappings'
import { DEFAULT_THRESHOLDS, SEED_SCHEMAS } from './seed-schemas'
import { SEED_RULES } from './seed-rules'

export type ActiveSchema = DocumentSchemaDto

export function schemaDto(row: typeof documentSchemas.$inferSelect): DocumentSchemaDto {
  const definition = schemaFieldsSchema.parse(row.jsonSchema)
  return {
    id: row.id,
    documentType: row.documentType,
    version: row.version,
    ...definition,
    thresholds: thresholdsSchema.parse(row.thresholds),
    exportMapping: row.exportMapping,
    isActive: row.isActive,
  }
}

export async function getActiveSchema(db: Database, documentType: DocumentType) {
  const [row] = await db
    .select()
    .from(documentSchemas)
    .where(and(eq(documentSchemas.documentType, documentType), eq(documentSchemas.isActive, true)))
    .limit(1)
  return row ? schemaDto(row) : null
}

export async function getSchemaVersion(db: Database, id: string) {
  const [row] = await db.select().from(documentSchemas).where(eq(documentSchemas.id, id)).limit(1)
  if (!row) throw new Error(`Schema version ${id} not found`)
  return schemaDto(row)
}

/**
 * Legacy fields are the source of truth. By default the caller holds the document
 * lock and a stale document-level binding is repaired; reads outside the lock pass
 * `backfill: false` and write nothing.
 */
export async function getDocumentSchema(
  db: Database,
  document: Pick<
    typeof documents.$inferSelect,
    'id' | 'schemaVersionId' | 'extractionSchemaVersionId' | 'documentType'
  >,
  { backfill = true } = {},
) {
  const rows = await db
    .selectDistinct({ id: fields.schemaVersionId })
    .from(fields)
    .where(and(eq(fields.documentId, document.id), isNotNull(fields.schemaVersionId)))
  if (rows.length > 1) throw new Error(`Document ${document.id} has mixed schema versions`)
  const schema = rows[0]?.id
    ? await getSchemaVersion(db, rows[0].id)
    : document.schemaVersionId
      ? await getSchemaVersion(db, document.schemaVersionId)
      : document.extractionSchemaVersionId
        ? await getSchemaVersion(db, document.extractionSchemaVersionId)
        : document.documentType && document.documentType !== 'unknown'
          ? await getActiveSchema(db, document.documentType)
          : null
  if (
    backfill &&
    schema &&
    schema.id !== document.schemaVersionId &&
    (rows[0]?.id || document.extractionSchemaVersionId)
  ) {
    await db
      .update(documents)
      .set({ schemaVersionId: schema.id })
      .where(eq(documents.id, document.id))
  }
  return schema
}

/** Pin before calling the provider; retries keep this selection. Caller holds the row lock. */
export async function selectExtractionSchema(
  db: Database,
  document: typeof documents.$inferSelect,
  correlationId: string | undefined,
  selected?: DocumentSchemaDto,
) {
  const schema =
    selected ??
    (document.extractionSchemaVersionId
      ? await getSchemaVersion(db, document.extractionSchemaVersionId)
      : document.documentType && document.documentType !== 'unknown'
        ? await getActiveSchema(db, document.documentType)
        : null)
  if (!schema) throw new Error(`No extraction schema for document ${document.id}`)
  const previous = await getDocumentSchema(db, {
    ...document,
    extractionSchemaVersionId: schema.id,
  })
  const changedType = previous && previous.documentType !== schema.documentType
  // Changing type starts a different form. Never relabel values from the old type.
  if (changedType) await db.delete(fields).where(eq(fields.documentId, document.id))
  await db
    .update(documents)
    .set({
      extractionSchemaVersionId: schema.id,
      schemaVersionId: !previous || changedType ? schema.id : previous.id,
    })
    .where(eq(documents.id, document.id))
  if (document.extractionSchemaVersionId !== schema.id) {
    await writeAudit(db, {
      correlationId,
      actorType: 'system',
      action: 'document.schema_selected',
      objectType: 'document',
      objectId: document.id,
      before: { schemaId: previous?.id ?? null, schemaVersion: previous?.version ?? null },
      after: {
        schemaId: schema.id,
        schemaVersion: schema.version,
        documentType: schema.documentType,
        processingRevision: document.processingRevision,
        changedType: Boolean(changedType),
      },
      result: 'success',
    })
  }
  return schema
}

/** Every writer (seed and API) takes the same per-type transaction lock. */
export async function lockSchemaType(db: Database, type: DocumentType) {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`docflow-schema:${type}`}, 0))`,
  )
}

/** Caller holds lockSchemaType; definitions are immutable after insertion. */
export async function createSchemaVersion(
  db: Database,
  type: DocumentType,
  config: SchemaConfiguration,
  seedFingerprint?: string,
) {
  const [latest] = await db
    .select({ version: documentSchemas.version })
    .from(documentSchemas)
    .where(eq(documentSchemas.documentType, type))
    .orderBy(desc(documentSchemas.version))
    .limit(1)
  await db
    .update(documentSchemas)
    .set({ isActive: false })
    .where(and(eq(documentSchemas.documentType, type), eq(documentSchemas.isActive, true)))
  const created = single(
    await db
      .insert(documentSchemas)
      .values({
        documentType: type,
        version: (latest?.version ?? 0) + 1,
        jsonSchema: { fields: config.fields, rules: config.rules },
        thresholds: config.thresholds,
        exportMapping: config.exportMapping,
        seedFingerprint,
      })
      .returning(),
    'schema version insert',
  )
  return schemaDto(created)
}

/** A deployment never reapplies an unchanged seed over administrator changes. */
export async function seedSchemas(db: Database) {
  for (const type of CLASSIFIABLE_DOCUMENT_TYPES) {
    const definition = {
      fields: SEED_SCHEMAS[type],
      rules: SEED_RULES[type],
      exportMapping: EXPORT_MAPPINGS[type],
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
    await db.transaction(async (tx) => {
      await lockSchemaType(tx, type)
      const [seeded] = await tx
        .select()
        .from(documentSchemas)
        .where(
          and(eq(documentSchemas.documentType, type), isNotNull(documentSchemas.seedFingerprint)),
        )
        .orderBy(desc(documentSchemas.version))
        .limit(1)
      if (seeded?.seedFingerprint === fingerprint) return
      const active = await getActiveSchema(tx, type)
      if (!seeded) {
        // Upgrade existing installations without changing historical definitions.
        const rows = await tx
          .select()
          .from(documentSchemas)
          .where(eq(documentSchemas.documentType, type))
          .orderBy(desc(documentSchemas.version))
        const matching = rows.find(
          (row) =>
            isDeepStrictEqual(row.jsonSchema, {
              fields: definition.fields,
              rules: definition.rules,
            }) && isDeepStrictEqual(row.exportMapping, definition.exportMapping),
        )
        if (matching) {
          await tx
            .update(documentSchemas)
            .set({ seedFingerprint: fingerprint })
            .where(eq(documentSchemas.id, matching.id))
          return
        }
      }
      const config = schemaConfigurationSchema.parse({
        ...definition,
        thresholds: active?.thresholds ?? DEFAULT_THRESHOLDS,
      })
      const created = await createSchemaVersion(tx, type, config, fingerprint)
      await writeAudit(tx, {
        actorType: 'system',
        action: 'schema.seeded',
        objectType: 'document_schema',
        objectId: created.id,
        before: active,
        after: created,
        result: 'success',
      })
    })
  }
}
