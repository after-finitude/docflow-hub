import {
  EXTERNAL_RULE_IDS,
  INVOICE_NUMBER_UNIQUE_RULE,
  decideRouting,
  scoreConfidence,
  validateDocument,
  type RoutingDecision,
  type ValidationField,
  type ValidationIssueResult,
} from '@docflow/shared'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, eq, ne, notInArray } from 'drizzle-orm'
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
  /** Кто инициировал перевалидацию: система (pipeline) или оператор (правка поля). */
  actorId?: string
  actorType?: 'system' | 'user'
  /**
   * Разрешать автоматический перевод в approved. Истина для pipeline (ТЗ 6.7),
   * ложь при правке поля оператором: исправив последнюю ошибку, оператор не
   * должен обнаружить документ уже подтверждённым — Approve нажимает он сам.
   */
  autoApprove?: boolean
}

export interface ValidationOutcome {
  status: 'approved' | 'needs_review'
  decision: RoutingDecision
  issues: ValidationIssueResult[]
}

/**
 * Прогон валидации, пересчёт уверенности и маршрутизация (ТЗ 6.6, 6.7).
 *
 * Живёт в core, потому что вызывается из двух процессов: воркером после
 * извлечения и API синхронно при правке поля оператором.
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

    if (!document) throw new Error(`Документ ${documentId} не найден`)

    if (!document.documentType || document.documentType === 'unknown') {
      // Тип не определён — валидировать нечего, нужен ручной выбор типа.
      return {
        status: 'needs_review',
        decision: {
          auto: false,
          blockingCount: 0,
          warningCount: 0,
          lowConfidenceFields: [],
          reasons: ['Тип документа не определён'],
        },
        issues: [],
      }
    }

    const schema = await getActiveSchema(this.db, document.documentType)
    if (!schema) throw new Error(`Нет активной схемы для типа ${document.documentType}`)

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

    const decision = decideRouting(
      validationFields.map((field) => ({
        name: field.name,
        label: field.label,
        isCritical: field.isCritical,
        confidence: confidenceByField.get(field.name) ?? null,
      })),
      issues.map((issue) => ({ severity: issue.severity, resolved: false })),
      schema.thresholds,
    )

    // Документ проходит автоматически только при отсутствии blocking и всех
    // критичных полях выше порога (ТЗ 6.7).
    const autoApprove = options.autoApprove ?? true
    const status = decision.auto && autoApprove ? 'approved' : 'needs_review'

    // Экспортированный документ не откатывается назад перевалидацией.
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

    // Решение фиксируется вместе с версией схемы и правил — воспроизводимо (ТЗ 6.7).
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
      `Документ ${documentId}: ${status} (blocking ${decision.blockingCount}, warning ${decision.warningCount})`,
    )
    return { status, decision, issues }
  }

  /**
   * Единственная разрешённая cross-document проверка: уникальность
   * invoice_number в рамках поставщика (ТЗ §9, исключение).
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
          // normalized_value — jsonb; #>> '{}' достаёт скалярное значение как текст.
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
      message: `Инвойс с номером ${number} от поставщика «${supplier}» уже есть в системе: ${duplicate.filename}`,
      expected: 'уникальный номер в рамках поставщика',
      actual: number,
    }
  }

  /** Проблемы движка заменяются целиком; чужие (например, от классификации) не трогаются. */
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
   * Пересчёт уверенности с учётом результата валидации (ТЗ 6.7). Считается
   * из сохранённых сигналов, поэтому повторный прогон даёт тот же результат.
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
        // Поле без сохранённых сигналов (например, заполненное вручную до
        // появления расчёта): уверенность оставляем как есть.
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
