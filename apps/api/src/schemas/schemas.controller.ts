import { DB, documentSchemas, getActiveSchema, writeAudit, type Database } from '@docflow/core'
import {
  CLASSIFIABLE_DOCUMENT_TYPES,
  schemaFieldsSchema,
  thresholdsSchema,
  type ClassifiableDocumentType,
  type DocumentSchemaDto,
  type SchemaThresholds,
  type SessionUser,
} from '@docflow/shared'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Put,
} from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { CurrentUser, Origin, Roles, type RequestContext } from '../auth/decorators'
import { ZodValidationPipe } from '../common/zod-validation.pipe'

@Controller('schemas')
export class SchemasController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Активные схемы всех типов (ТЗ §8). */
  @Get()
  async list(): Promise<DocumentSchemaDto[]> {
    const rows = await this.db
      .select()
      .from(documentSchemas)
      .where(eq(documentSchemas.isActive, true))

    return rows.map((row) => ({
      id: row.id,
      documentType: row.documentType,
      version: row.version,
      fields: schemaFieldsSchema.parse(row.jsonSchema).fields,
      thresholds: thresholdsSchema.parse(row.thresholds),
      isActive: row.isActive,
    }))
  }

  /**
   * Настройка порогов (ТЗ 6.7, §8): только администратор. Создаётся новая
   * версия схемы, а не правка текущей: принятые решения фиксируются вместе
   * с версией правил и должны оставаться воспроизводимыми.
   */
  @Put(':type/thresholds')
  @Roles('admin')
  async updateThresholds(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(thresholdsSchema)) thresholds: SchemaThresholds,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentSchemaDto> {
    if (!(CLASSIFIABLE_DOCUMENT_TYPES as readonly string[]).includes(type)) {
      throw new BadRequestException(`Неизвестный тип документа: ${type}`)
    }
    const documentType = type as ClassifiableDocumentType

    const active = await getActiveSchema(this.db, documentType)
    if (!active) throw new NotFoundException(`Нет активной схемы для типа ${type}`)

    const [created] = await this.db.transaction(async (tx) => {
      await tx
        .update(documentSchemas)
        .set({ isActive: false })
        .where(eq(documentSchemas.id, active.id))
      return tx
        .insert(documentSchemas)
        .values({
          documentType,
          version: active.version + 1,
          jsonSchema: { fields: active.fields },
          thresholds,
          isActive: true,
        })
        .returning()
    })

    await writeAudit(this.db, {
      correlationId: origin.correlationId,
      actorType: 'user',
      actorId: user.id,
      action: 'schema.thresholds_updated',
      objectType: 'document_schema',
      objectId: created.id,
      before: { version: active.version, thresholds: active.thresholds },
      after: { version: created.version, thresholds },
      result: 'success',
      ip: origin.ip,
      userAgent: origin.userAgent,
    })

    return {
      id: created.id,
      documentType: created.documentType,
      version: created.version,
      fields: active.fields,
      thresholds,
      isActive: true,
    }
  }
}
