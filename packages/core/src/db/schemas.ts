import {
  schemaFieldsSchema,
  thresholdsSchema,
  type DocumentType,
  type FieldSpec,
  type SchemaThresholds,
  type ValidationRule,
} from '@docflow/shared'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db.module'
import { documentSchemas } from './schema'

export interface ActiveSchema {
  id: string
  documentType: DocumentType
  version: number
  fields: FieldSpec[]
  rules: ValidationRule[]
  thresholds: SchemaThresholds
}

/**
 * Active type-schema version. Validate jsonb with Zod so a corrupt database
 * schema fails clearly here instead of deep in the pipeline.
 */
export async function getActiveSchema(
  db: Database,
  documentType: DocumentType,
): Promise<ActiveSchema | null> {
  const [row] = await db
    .select()
    .from(documentSchemas)
    .where(and(eq(documentSchemas.documentType, documentType), eq(documentSchemas.isActive, true)))
    .limit(1)

  if (!row) return null

  const definition = schemaFieldsSchema.parse(row.jsonSchema)
  return {
    id: row.id,
    documentType: row.documentType,
    version: row.version,
    fields: definition.fields,
    rules: definition.rules,
    thresholds: thresholdsSchema.parse(row.thresholds),
  }
}
