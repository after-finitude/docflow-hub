import type { SchemaThresholds } from '../contracts/schema'
import type { IssueSeverity } from '../enums'

/**
 * Post-validation routing (spec 6.7). Automatic approval requires no blocking
 * issues and every critical field above threshold. The pure function produces
 * a reproducible decision logged with the rule version.
 */

export interface RoutingField {
  name: string
  label: string
  isCritical: boolean
  confidence: number | null
  sourceFound: boolean
}

export interface RoutingIssue {
  severity: IssueSeverity
  resolved: boolean
  /**
   * Issue requires an operator regardless of severity, such as suspected
   * multiple documents in one file (spec 6.3).
   */
  forcesReview?: boolean
}

export interface RoutingDecision {
  /** true when the document can pass without an operator. */
  auto: boolean
  blockingCount: number
  warningCount: number
  /** Critical fields below threshold with actual values for the log. */
  lowConfidenceFields: Array<{ name: string; confidence: number | null }>
  /** Human-readable reasons for review routing. */
  reasons: string[]
}

export function decideRouting(
  fields: RoutingField[],
  issues: RoutingIssue[],
  thresholds: SchemaThresholds,
): RoutingDecision {
  const unresolved = issues.filter((issue) => !issue.resolved)
  const blockingCount = unresolved.filter((issue) => issue.severity === 'blocking').length
  const warningCount = unresolved.filter((issue) => issue.severity === 'warning').length

  // A critical field without a value fails the threshold; absence cannot justify approval.
  const lowConfidenceFields = fields
    .filter((field) => field.isCritical)
    .filter(
      (field) => field.confidence === null || field.confidence < thresholds.criticalFieldConfidence,
    )
    .map((field) => ({ name: field.name, confidence: field.confidence }))

  const forcedReview = unresolved.some((issue) => issue.forcesReview === true)
  const unsourced = fields.filter((field) => field.isCritical && !field.sourceFound)

  const reasons: string[] = []
  if (blockingCount > 0) {
    reasons.push(`Blocking issues: ${blockingCount}`)
  }
  if (forcedReview) {
    reasons.push('Document requires manual review')
  }
  if (unsourced.length > 0) {
    reasons.push(
      `Critical fields without a source: ${unsourced.map((field) => field.label).join(', ')}`,
    )
  }
  if (lowConfidenceFields.length > 0) {
    const names = fields
      .filter((field) => lowConfidenceFields.some((low) => low.name === field.name))
      .map((field) => field.label)
      .join(', ')
    reasons.push(`Critical fields below ${thresholds.criticalFieldConfidence}: ${names}`)
  }

  return {
    auto:
      blockingCount === 0 &&
      lowConfidenceFields.length === 0 &&
      unsourced.length === 0 &&
      !forcedReview,
    blockingCount,
    warningCount,
    lowConfidenceFields,
    reasons,
  }
}
