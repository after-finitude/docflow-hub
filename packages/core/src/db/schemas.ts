import {
  schemaFieldsSchema,
  thresholdsSchema,
  type DocumentType,
  type FieldSpec,
  type SchemaThresholds,
} from '@docflow/shared'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db.module'
import { documentSchemas } from './schema'

export interface ActiveSchema {
  id: string
  documentType: DocumentType
  version: number
  fields: FieldSpec[]
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

  return {
    id: row.id,
    documentType: row.documentType,
    version: row.version,
    fields: schemaFieldsSchema.parse(row.jsonSchema).fields,
    thresholds: thresholdsSchema.parse(row.thresholds),
  }
}
