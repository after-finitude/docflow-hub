import {
  DB,
  documents,
  auditEvents,
  fields,
  getDocumentSchema,
  type ActiveSchema,
  pages,
  validationIssues,
  workflowRuns,
  type Database,
} from '@docflow/core'
import {
  canPerform,
  type DocumentDetail,
  type DocumentListItem,
  type DocumentListPage,
  type DocumentListQuery,
  type DocumentPage,
  type FieldDto,
  type IssueDto,
  type WorkflowState,
  type WorkflowStep,
} from '@docflow/shared'
import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { and, desc, eq, exists, gte, inArray, isNull, lte, not, sql, type SQL } from 'drizzle-orm'
import type { SelectResultFields } from 'drizzle-orm/query-builders/select.types'
import { ExportService } from '../export/export.service'

/**
 * Document reference in an outer query. Qualify the table explicitly: inside
 * SQL templates Drizzle emits unqualified columns, so `documents.id` would
 * become `"id"` and resolve to the subquery's own column. The join would silently
 * become `document_id = id`, leaving issue counts and the current stage empty.
 */
const documentRef = sql`${sql.identifier('documents')}.${sql.identifier('id')}`

/** Fields computed by subqueries; empty before stages 4–5, but the response shape is final. */
const listColumns = {
  id: documents.id,
  originalFilename: documents.originalFilename,
  mimeType: documents.mimeType,
  sizeBytes: documents.sizeBytes,
  hasOriginal: sql<boolean>`${documents.storageKey} is not null`.as('has_original'),
  sourceType: documents.sourceType,
  documentType: documents.documentType,
  typeConfidence: documents.typeConfidence,
  status: documents.status,
  statusReason: documents.statusReason,
  thumbnailKey: documents.thumbnailKey,
  duplicateOfId: documents.duplicateOfId,
  versionNumber: documents.versionNumber,
  previousVersionId: documents.previousVersionId,
  isActive: documents.isActive,
  receivedAt: documents.receivedAt,
  minCriticalConfidence: sql<number | null>`(
    select min(${fields.confidence}) from ${fields}
    where ${fields.documentId} = ${documentRef} and ${fields.isCritical}
  )`.as('min_critical_confidence'),
  blockingIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documentRef}
      and ${validationIssues.severity} = 'blocking'
      and ${validationIssues.resolvedAt} is null
  )`.as('blocking_issues'),
  warningIssues: sql<number>`(
    select count(*)::int from ${validationIssues}
    where ${validationIssues.documentId} = ${documentRef}
      and ${validationIssues.severity} = 'warning'
      and ${validationIssues.resolvedAt} is null
  )`.as('warning_issues'),
  currentStep: sql<WorkflowStep | null>`(
    select ${workflowRuns.step} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documentRef}
    order by ${workflowRuns.startedAt} desc nulls last limit 1
  )`.as('current_step'),
  currentStepState: sql<WorkflowState | null>`(
    select ${workflowRuns.state} from ${workflowRuns}
    where ${workflowRuns.documentId} = ${documentRef}
    order by ${workflowRuns.startedAt} desc nulls last limit 1
  )`.as('current_step_state'),
}

type ListRow = SelectResultFields<typeof listColumns>

/** Reads: inbox list, document detail, OCR pages and review metrics. */
@Injectable()
export class DocumentQueryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly exports: ExportService,
  ) {}

  async reviewMetrics(since?: string) {
    const [result] = await this.db
      .select({
        approvals: sql<number>`count(*)::int`,
        measured: sql<number>`count(${auditEvents.after}->>'reviewDurationMs')::int`,
        medianMs: sql<
          number | null
        >`percentile_cont(0.5) within group (order by (${auditEvents.after}->>'reviewDurationMs')::double precision)`,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'document.approved'),
          since ? gte(auditEvents.createdAt, new Date(since)) : undefined,
        ),
      )
    return { ...result, missingOpening: result.approvals - result.measured }
  }

  async list(query: DocumentListQuery): Promise<DocumentListPage> {
    const conditions: SQL[] = []
    if (query.status?.length) conditions.push(inArray(documents.status, query.status))
    if (query.type?.length) conditions.push(inArray(documents.documentType, query.type))
    if (query.source?.length) conditions.push(inArray(documents.sourceType, query.source))
    if (query.receivedFrom) conditions.push(gte(documents.receivedAt, new Date(query.receivedFrom)))
    if (query.receivedTo) conditions.push(lte(documents.receivedAt, new Date(query.receivedTo)))

    if (query.hasBlocking !== undefined) {
      const hasBlocking = exists(
        this.db
          .select({ one: sql`1` })
          .from(validationIssues)
          .where(
            and(
              eq(validationIssues.documentId, documents.id),
              eq(validationIssues.severity, 'blocking'),
              isNull(validationIssues.resolvedAt),
            ),
          ),
      )
      conditions.push(query.hasBlocking ? hasBlocking : not(hasBlocking))
    }

    const where = conditions.length ? and(...conditions) : undefined

    const rows = await this.db
      .select(listColumns)
      .from(documents)
      .where(where)
      .orderBy(desc(documents.receivedAt))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)

    const [counted] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(documents)
      .where(where)

    return {
      items: rows.map((row) => this.toListItem(row)),
      total: counted?.total ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    }
  }

  /**
   * Detail for GET and polling. One read-only snapshot keeps fields, issues and
   * canApprove consistent without a row lock, so polling never blocks the worker
   * or an operator decision on the same document.
   */
  async findOne(id: string): Promise<DocumentDetail> {
    return this.db.transaction((db) => this.readDetail(db, id, { locked: false }), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
  }

  /** `locked`: the caller holds the document lock, so a stale schema binding is repaired. */
  async readDetail(
    db: Database,
    id: string,
    { locked }: { locked: boolean },
  ): Promise<DocumentDetail> {
    const [row] = await db
      .select({
        ...listColumns,
        checksum: documents.checksum,
        sourcePath: documents.sourcePath,
        processedAt: documents.processedAt,
        pageCount: documents.pageCount,
        schemaVersionId: documents.schemaVersionId,
        extractionSchemaVersionId: documents.extractionSchemaVersionId,
      })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)

    if (!row) throw new NotFoundException('Document not found')

    const base = this.toListItem(row)
    const schema = await getDocumentSchema(db, row, { backfill: locked })

    const loadedFields = await this.loadFields(id, schema, db)
    return {
      ...base,
      checksum: row.checksum,
      sourcePath: row.sourcePath,
      processedAt: row.processedAt ? row.processedAt.toISOString() : null,
      pageCount: row.pageCount,
      fields: loadedFields,
      schemaVersionId: schema?.id ?? null,
      schemaVersion: schema?.version ?? null,
      issues: await this.loadIssues(id, db),
      thresholds: schema?.thresholds ?? null,
      exports: await this.exports.listForDocument(id, db),
      // Any unresolved blocking issue disables approval (spec §9).
      canApprove:
        canPerform('approve', base.status) &&
        schema !== null &&
        base.documentType === schema.documentType &&
        base.blockingIssues === 0 &&
        schema.fields
          .filter((spec) => spec.required)
          .every((spec) =>
            loadedFields.some(
              (field) => field.name === spec.name && field.normalizedValue !== null,
            ),
          ),
    }
  }

  private async loadFields(
    documentId: string,
    schema: ActiveSchema | null,
    db: Database,
  ): Promise<FieldDto[]> {
    const rows = await db
      .select()
      .from(fields)
      .where(eq(fields.documentId, documentId))
      .orderBy(fields.name)
    if (rows.length === 0) return []

    const specs = new Map((schema?.fields ?? []).map((spec) => [spec.name, spec]))

    return rows.map((row) => ({
      name: row.name,
      label: specs.get(row.name)?.label ?? row.name,
      valueType: row.valueType,
      rawValue: row.rawValue,
      normalizedValue: row.normalizedValue,
      confidence: row.confidence,
      confidenceReason: row.confidenceReason,
      sourcePage: row.sourcePage,
      sourceBbox: row.sourceBbox,
      sourceFound: row.sourceFound,
      isCritical: row.isCritical,
      isRequired: specs.get(row.name)?.required ?? false,
      isEdited: row.isEdited,
    }))
  }

  private async loadIssues(documentId: string, db: Database): Promise<IssueDto[]> {
    const rows = await db
      .select()
      .from(validationIssues)
      .where(eq(validationIssues.documentId, documentId))
      .orderBy(desc(validationIssues.severity), validationIssues.createdAt)

    return rows.map((row) => ({
      id: row.id,
      fieldName: row.fieldName,
      ruleId: row.ruleId,
      severity: row.severity,
      message: row.message,
      expected: row.expected,
      actual: row.actual,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    }))
  }

  /** Per-page OCR result: text, coordinate blocks, and confidence (spec 6.2, §8). */
  async pages(id: string): Promise<DocumentPage[]> {
    const [exists_] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1)
    if (!exists_) throw new NotFoundException('Document not found')

    const rows = await this.db
      .select({
        pageNumber: pages.pageNumber,
        text: pages.ocrText,
        confidence: pages.ocrConfidence,
        width: pages.width,
        height: pages.height,
        blocks: pages.blocks,
      })
      .from(pages)
      .where(eq(pages.documentId, id))
      .orderBy(pages.pageNumber)

    return rows.map((row) => ({ ...row, blocks: row.blocks ?? [] }))
  }

  private toListItem(value: ListRow): DocumentListItem {
    return {
      id: value.id,
      originalFilename: value.originalFilename,
      mimeType: value.mimeType,
      sizeBytes: value.sizeBytes === null ? null : Number(value.sizeBytes),
      hasOriginal: value.hasOriginal,
      sourceType: value.sourceType,
      documentType: value.documentType,
      typeConfidence: value.typeConfidence,
      status: value.status,
      statusReason: value.statusReason,
      minCriticalConfidence: value.minCriticalConfidence,
      blockingIssues: value.blockingIssues,
      warningIssues: value.warningIssues,
      hasThumbnail: Boolean(value.thumbnailKey),
      duplicateOfId: value.duplicateOfId,
      versionNumber: value.versionNumber,
      previousVersionId: value.previousVersionId,
      isActive: value.isActive,
      currentStep: value.currentStep,
      currentStepState: value.currentStepState,
      receivedAt: value.receivedAt.toISOString(),
    }
  }
}
