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
 * Активная версия схемы типа. jsonb проходит через zod: повреждённая схема
 * в БД должна падать здесь с внятной ошибкой, а не глубоко в pipeline.
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
