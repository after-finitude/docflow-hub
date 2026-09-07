import { isDeepStrictEqual } from 'node:util'

export function valuesMatch(actual, expected) {
  if (expected === null) return actual === null
  if (typeof expected === 'number')
    return typeof actual === 'number' && Math.abs(actual - expected) < 0.005
  return isDeepStrictEqual(actual, expected)
}
export const percent = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : null)
export function median(values) {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b),
    middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Denominators come from ground truth, including documents with no usable output. */
export function score(entries, results) {
  const counts = {
    documents: entries.length,
    valid: 0,
    classifiedCorrect: 0,
    criticalTotal: 0,
    criticalMatched: 0,
    fieldsTotal: 0,
    fieldsCovered: 0,
    values: 0,
    sourced: 0,
    autoApproved: 0,
    falseAutoApproval: 0,
    invalid: 0,
    rejectedInvalid: 0,
    rejectedValid: 0,
    failed: 0,
    unknown: 0,
    multiExpected: 0,
    multiDetected: 0,
  }
  const documents = []
  for (const entry of entries) {
    const result = results.find((candidate) => candidate.file === entry.file) ?? {
      status: 'failed',
      error: 'No result',
    }
    const fields = new Map((result.fields ?? []).map((field) => [field.name, field]))
    const valid = entry.expectedType !== null
    const usable =
      valid &&
      !['rejected', 'failed'].includes(result.status) &&
      result.documentType === entry.expectedType
    if (valid) {
      counts.valid++
      if (result.documentType === entry.expectedType) counts.classifiedCorrect++
      if (result.status === 'rejected') counts.rejectedValid++
      for (const [name, expected] of Object.entries(entry.criticalFields)) {
        counts.criticalTotal++
        if (usable && fields.has(name) && valuesMatch(fields.get(name).normalizedValue, expected))
          counts.criticalMatched++
      }
      for (const [name, expected] of Object.entries(entry.expectedFields)) {
        counts.fieldsTotal++
        const actual = fields.get(name)
        if (
          usable &&
          actual &&
          (expected === null
            ? actual.normalizedValue === null
            : actual.normalizedValue !== null && actual.normalizedValue !== undefined)
        )
          counts.fieldsCovered++
      }
    } else {
      counts.invalid++
      if (result.status === 'rejected') counts.rejectedInvalid++
    }
    if (result.status === 'failed') counts.failed++
    if (
      valid &&
      (!result.documentType || result.documentType === 'unknown') &&
      result.status !== 'rejected' &&
      result.status !== 'failed'
    )
      counts.unknown++
    for (const field of fields.values())
      if (field.normalizedValue !== null && field.normalizedValue !== undefined) {
        counts.values++
        if (field.sourceFound && field.sourceBbox && field.sourcePage) counts.sourced++
      }
    if (entry.multiDocument) {
      counts.multiExpected++
      if (
        result.issues?.some(
          (issue) => issue.ruleId === 'multi_document_suspected' && !issue.resolvedAt,
        )
      )
        counts.multiDetected++
    }
    const correct =
      usable &&
      Object.entries(entry.expectedFields).every(
        ([name, expected]) =>
          fields.has(name) && valuesMatch(fields.get(name).normalizedValue, expected),
      )
    const falseAuto =
      result.status === 'approved' &&
      (!entry.expectedAutoAllowed || !correct || result.blockingIssues > 0)
    if (result.status === 'approved') counts.autoApproved++
    if (falseAuto) counts.falseAutoApproval++
    documents.push({
      file: entry.file,
      status: result.status,
      type: result.documentType ?? null,
      correct,
      falseAuto,
      error: result.error ?? result.statusReason ?? null,
      schemaVersionId: result.schemaVersionId ?? null,
      schemaVersion: result.schemaVersion ?? null,
      elapsedMs: result.elapsedMs ?? null,
    })
  }
  const metric = (name, numerator, denominator, target = null) => ({
    name,
    numerator,
    denominator,
    percent: percent(numerator, denominator),
    target,
    meetsTarget:
      target === null ? null : denominator > 0 && (numerator / denominator) * 100 >= target,
  })
  const metrics = [
    metric('Classification accuracy', counts.classifiedCorrect, counts.valid, 95),
    metric('Critical field exact match', counts.criticalMatched, counts.criticalTotal, 90),
    metric(
      'Field coverage (including correct Missing)',
      counts.fieldsCovered,
      counts.fieldsTotal,
      98,
    ),
    metric('Source coverage', counts.sourced, counts.values),
    metric('Straight-through rate', counts.autoApproved, counts.documents),
  ]
  return {
    counts,
    metrics,
    documents,
    targetsMet: metrics.every((m) => m.meetsTarget !== false) && counts.falseAutoApproval === 0,
  }
}
