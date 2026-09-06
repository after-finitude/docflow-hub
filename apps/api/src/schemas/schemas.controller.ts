import {
  DB,
  documentSchemas,
  getActiveSchema,
  lockSchemaType,
  createSchemaVersion,
  schemaDto,
  writeAudit,
  type Database,
} from '@docflow/core'
import {
  CLASSIFIABLE_DOCUMENT_TYPES,
  thresholdsSchema,
  schemaConfigurationSchema,
  type ClassifiableDocumentType,
  type DocumentSchemaDto,
  type SchemaConfiguration,
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
import { eq, desc } from 'drizzle-orm'
import { CurrentUser, Origin, Roles, type RequestContext } from '../auth/decorators'
import { ZodValidationPipe } from '../common/zod-validation.pipe'

@Controller('schemas')
export class SchemasController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async list(): Promise<DocumentSchemaDto[]> {
    const rows = await this.db
      .select()
      .from(documentSchemas)
      .where(eq(documentSchemas.isActive, true))
    return rows.map(schemaDto)
  }

  @Get(':type/versions')
  async versions(@Param('type') type: string): Promise<DocumentSchemaDto[]> {
    const rows = await this.db
      .select()
      .from(documentSchemas)
      .where(eq(documentSchemas.documentType, this.documentType(type)))
      .orderBy(desc(documentSchemas.version))
    return rows.map(schemaDto)
  }

  @Put(':type')
  @Roles('admin')
  async update(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(schemaConfigurationSchema)) configuration: SchemaConfiguration,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentSchemaDto> {
    return this.save(type, configuration, user, origin)
  }

  /** Keep the existing thresholds endpoint; merge against the locked latest version. */
  @Put(':type/thresholds')
  @Roles('admin')
  async updateThresholds(
    @Param('type') type: string,
    @Body(new ZodValidationPipe(thresholdsSchema)) thresholds: SchemaThresholds,
    @CurrentUser() user: SessionUser,
    @Origin() origin: RequestContext,
  ): Promise<DocumentSchemaDto> {
    return this.save(type, { thresholds }, user, origin)
  }

  private documentType(type: string): ClassifiableDocumentType {
    if (!(CLASSIFIABLE_DOCUMENT_TYPES as readonly string[]).includes(type))
      throw new BadRequestException(`Unknown document type: ${type}`)
    return type as ClassifiableDocumentType
  }

  private async save(
    type: string,
    patch: SchemaConfiguration | { thresholds: SchemaThresholds },
    user: SessionUser,
    origin: RequestContext,
  ) {
    const documentType = this.documentType(type)
    return this.db.transaction(async (tx) => {
      await lockSchemaType(tx, documentType)
      const active = await getActiveSchema(tx, documentType)
      if (!active) throw new NotFoundException(`No active schema for type ${type}`)
      const parsed = schemaConfigurationSchema.safeParse({
        fields: active.fields,
        rules: active.rules,
        exportMapping: active.exportMapping,
        ...patch,
      })
      if (!parsed.success) throw new BadRequestException(parsed.error.issues)
      const created = await createSchemaVersion(tx, documentType, parsed.data)
      await writeAudit(tx, {
        correlationId: origin.correlationId,
        actorType: 'user',
        actorId: user.id,
        action: 'fields' in patch ? 'schema.updated' : 'schema.thresholds_updated',
        objectType: 'document_schema',
        objectId: created.id,
        before: active,
        after: created,
        result: 'success',
        ip: origin.ip,
        userAgent: origin.userAgent,
      })
      return created
    })
  }
}
