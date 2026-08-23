import {
  EXTERNAL_RULE_IDS,
  FORCE_REVIEW_RULE_IDS,
  INVOICE_NUMBER_UNIQUE_RULE,
  decideRouting,
  scoreConfidence,
  validateDocument,
  type RoutingDecision,
  type ValidationField,
  type ValidationIssueResult,
} from '@docflow/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, inArray, isNull, ne, notInArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { ENV } from '../config/config.module'
import type { Env } from '../config/env'
import { writeAudit } from '../db/audit'
import { DB, type Database } from '../db/db.module'
import { documents, fields, validationIssues } from '../db/schema'
import { getActiveSchema } from '../db/schemas'

export interface ValidationRunOptions {
  correlationId?: string
  /** Revalidation initiator: system pipeline or operator field edit. */
  actorId?: string
  actorType?: 'system' | 'user'
  /**
   * Allow automatic approval. True for the pipeline (spec 6.7), false for an
   * operator edit so fixing the last issue does not approve without a click.
   */
  autoApprove?: boolean
}

export interface ValidationOutcome {
  status: 'approved' | 'needs_review'
  decision: RoutingDecision
  issues: ValidationIssueResult[]
}

/**
 * Validation, confidence recalculation, and routing (spec 6.6, 6.7).
 *
 * Lives in core because both the post-extraction worker and synchronous API
 * field edits call it.
 */
@Injectable()
export class ValidationRunnerService {
  private readonly logger = new Logger(ValidationRunnerService.name)

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async run(documentId: string, options: ValidationRunOptions = {}): Promise<ValidationOutcome> {
    const [document] = await this.db
      .select({
        id: documents.id,
        documentType: documents.documentType,
        status: documents.status,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1)

    if (!document) throw new Error(`Document ${documentId} not found`)

    if (!document.documentType || document.documentType === 'unknown') {
      // No known type means nothing can be validated; require manual selection.
      return {
        status: 'needs_review',
        decision: {
          auto: false,
          blockingCount: 0,
          warningCount: 0,
          lowConfidenceFields: [],
          reasons: ['Document type is unknown'],
        },
        issues: [],
      }
    }

    const schema = await getActiveSchema(this.db, document.documentType)
    if (!schema) throw new Error(`No active schema for type ${document.documentType}`)

    const fieldRows = await this.db.select().from(fields).where(eq(fields.documentId, documentId))
    const specs = new Map(schema.fields.map((spec) => [spec.name, spec]))

    const validationFields: ValidationField[] = fieldRows.map((row) => ({
      name: row.name,
      label: specs.get(row.name)?.label ?? row.name,
      valueType: row.valueType,
      rawValue: row.rawValue,
      normalizedValue: row.normalizedValue,
      isRequired: specs.get(row.name)?.required ?? false,
      isCritical: row.isCritical,
    }))

    const issues = validateDocument(validationFields, schema.rules, {
      today: new Date().toISOString().slice(0, 10),
    })

    const uniqueness = await this.checkInvoiceNumberUniqueness(
      documentId,
      document.documentType,
      fieldRows,
    )
    if (uniqueness) issues.push(uniqueness)

    await this.replaceIssues(documentId, issues)
    const confidenceByField = await this.recomputeConfidence(fieldRows, issues)

    // External issues, such as suspected multiple documents, also affect routing.
    const externalIssues = await this.db
      .select({ ruleId: validationIssues.ruleId, severity: validationIssues.severity })
      .from(validationIssues)
      .where(
        and(
          eq(validationIssues.documentId, documentId),
          inArray(validationIssues.ruleId, [...EXTERNAL_RULE_IDS]),
          isNull(validationIssues.resolvedAt),
        ),
      )

    const routingIssues = [
      ...issues.map((issue) => ({
        severity: issue.severity,
        resolved: false,
        forcesReview: FORCE_REVIEW_RULE_IDS.includes(issue.ruleId),
      })),
      ...externalIssues.map((issue) => ({
        severity: issue.severity,
        resolved: false,
        forcesReview: FORCE_REVIEW_RULE_IDS.includes(issue.ruleId),
      })),
    ]

    const decision = decideRouting(
      validationFields.map((field) => ({
        name: field.name,
        label: field.label,
        isCritical: field.isCritical,
        confidence: confidenceByField.get(field.name) ?? null,
      })),
      routingIssues,
      schema.thresholds,
    )

    // Automatic approval requires no blocking issues and every critical field
    // above its threshold (spec 6.7).
    const autoApprove = options.autoApprove ?? true
    const status = decision.auto && autoApprove ? 'approved' : 'needs_review'

    // Revalidation never moves an exported document backward.
    if (document.status !== 'exported') {
      await this.db
        .update(documents)
        .set({
          status,
          statusReason: decision.reasons.length ? decision.reasons.join('; ') : null,
          processedAt: new Date(),
        })
        .where(eq(documents.id, documentId))
    }

    // Record the decision with schema and rule versions for reproducibility (spec 6.7).
    await writeAudit(this.db, {
      correlationId: options.correlationId,
      actorType: options.actorType ?? 'system',
      actorId: options.actorId,
      action: 'document.routed',
      objectType: 'document',
      objectId: documentId,
      after: {
        status,
        auto: decision.auto && autoApprove,
        autoApproveAllowed: autoApprove,
        schemaId: schema.id,
        schemaVersion: schema.version,
        ruleIds: schema.rules.map((rule) => rule.id),
        thresholds: schema.thresholds,
        blockingCount: decision.blockingCount,
        warningCount: decision.warningCount,
        lowConfidenceFields: decision.lowConfidenceFields,
      },
      result: 'success',
    })

    this.logger.log(
      `Document ${documentId}: ${status} (blocking ${decision.blockingCount}, warning ${decision.warningCount})`,
    )
    return { status, decision, issues }
  }

  /**
   * The only allowed cross-document check: invoice_number uniqueness per supplier
   * (spec §9 exception).
   */
  private async checkInvoiceNumberUniqueness(
    documentId: string,
    documentType: string,
    fieldRows: Array<{ name: string; normalizedValue: unknown }>,
  ): Promise<ValidationIssueResult | null> {
    if (documentType !== 'invoice') return null

    const number = fieldRows.find((row) => row.name === 'invoice_number')?.normalizedValue
    const supplier = fieldRows.find((row) => row.name === 'supplier_name')?.normalizedValue
    if (typeof number !== 'string' || typeof supplier !== 'string') return null

    const numberField = alias(fields, 'f_number')
    const supplierField = alias(fields, 'f_supplier')

    const [duplicate] = await this.db
      .select({ id: documents.id, filename: documents.originalFilename })
      .from(documents)
      .innerJoin(
        numberField,
        and(eq(numberField.documentId, documents.id), eq(numberField.name, 'invoice_number')),
      )
      .innerJoin(
        supplierField,
        and(eq(supplierField.documentId, documents.id), eq(supplierField.name, 'supplier_name')),
      )
      .where(
        and(
          ne(documents.id, documentId),
          eq(documents.isActive, true),
          ne(documents.status, 'rejected'),
          // normalized_value is jsonb; #>> '{}' extracts its scalar as text.
          sql`${numberField.normalizedValue} #>> '{}' = ${number}`,
          sql`${supplierField.normalizedValue} #>> '{}' = ${supplier}`,
        ),
      )
      .limit(1)

    if (!duplicate) return null

    return {
      ruleId: INVOICE_NUMBER_UNIQUE_RULE,
      fieldName: 'invoice_number',
      severity: 'blocking',
      message: `Invoice ${number} from supplier “${supplier}” already exists: ${duplicate.filename}`,
      expected: 'a unique number for this supplier',
      actual: number,
    }
  }

  /** Replace engine issues completely while preserving external issues. */
  private async replaceIssues(documentId: string, issues: ValidationIssueResult[]): Promise<void> {
    await this.db
      .delete(validationIssues)
      .where(
        and(
          eq(validationIssues.documentId, documentId),
          notInArray(validationIssues.ruleId, [...EXTERNAL_RULE_IDS]),
        ),
      )

    if (issues.length > 0) {
      await this.db.insert(validationIssues).values(
        issues.map((issue) => ({
          documentId,
          fieldName: issue.fieldName,
          ruleId: issue.ruleId,
          severity: issue.severity,
          message: issue.message,
          expected: issue.expected,
          actual: issue.actual,
        })),
      )
    }
  }

  /**
   * Recalculate confidence from validation results (spec 6.7) and stored signals
   * so reruns produce the same value.
   */
  private async recomputeConfidence(
    fieldRows: Array<{
      id: string
      name: string
      confidence: number | null
      confidenceSignals: unknown
    }>,
    issues: ValidationIssueResult[],
  ): Promise<Map<string, number | null>> {
    const failed = new Set(
      issues
        .filter((issue) => issue.severity !== 'info' && issue.fieldName)
        .map((issue) => issue.fieldName!),
    )

    const result = new Map<string, number | null>()
    for (const row of fieldRows) {
      const signals = row.confidenceSignals as Parameters<typeof scoreConfidence>[0] | null
      if (!signals) {
        // Preserve confidence for a field without stored signals, such as one
        // filled manually before scoring existed.
        result.set(row.name, row.confidence)
        continue
      }

      const score = scoreConfidence({ ...signals, failedValidation: failed.has(row.name) })
      result.set(row.name, score.confidence)
      await this.db
        .update(fields)
        .set({
          confidence: score.confidence,
          confidenceReason: score.reasons.length ? score.reasons.join('; ') : null,
        })
        .where(eq(fields.id, row.id))
    }
    return result
  }
}
