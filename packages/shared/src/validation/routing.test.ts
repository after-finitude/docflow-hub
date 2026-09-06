import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideRouting, type RoutingField } from './routing'

const THRESHOLDS = { autoClassify: 0.7, criticalFieldConfidence: 0.8, fieldConfidence: 0.6 }

function critical(name: string, confidence: number | null): RoutingField {
  return { name, label: name, isCritical: true, confidence, sourceFound: true }
}

describe('decideRouting', () => {
  it('passes automatically without blocking issues and with confident critical fields', () => {
    const decision = decideRouting([critical('grand_total', 0.95)], [], THRESHOLDS)
    assert.equal(decision.auto, true)
    assert.equal(decision.reasons.length, 0)
  })

  it('blocks automatic approval for an unresolved blocking issue', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'blocking', resolved: false }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, false)
    assert.equal(decision.blockingCount, 1)
  })

  it('ignores a resolved blocking issue', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'blocking', resolved: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })

  it('counts warnings without blocking automatic approval', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [
        { severity: 'warning', resolved: false },
        { severity: 'info', resolved: false },
      ],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
    assert.equal(decision.warningCount, 1)
  })

  it('blocks automatic approval for a forcesReview warning (spec 6.3)', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'warning', resolved: false, forcesReview: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, false)
    assert.ok(decision.reasons.some((reason) => reason.includes('manual review')))
  })

  it('ignores a resolved forcesReview warning', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'warning', resolved: true, forcesReview: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })

  it('routes a critical field below threshold to review', () => {
    const decision = decideRouting([critical('supplier_name', 0.5)], [], THRESHOLDS)
    assert.equal(decision.auto, false)
    assert.deepEqual(decision.lowConfidenceFields, [{ name: 'supplier_name', confidence: 0.5 }])
  })

  it('treats a valueless critical field as zero confidence', () => {
    const decision = decideRouting([critical('supplier_name', null)], [], THRESHOLDS)
    assert.equal(decision.auto, false)
  })

  it('allows a low-confidence noncritical field to pass automatically', () => {
    const decision = decideRouting(
      [
        critical('grand_total', 0.9),
        {
          name: 'due_date',
          label: 'due_date',
          isCritical: false,
          confidence: 0.1,
          sourceFound: false,
        },
      ],
      [],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })
})

it('never auto-approves an unsourced critical field even at zero threshold', () => {
  for (const criticalFieldConfidence of [0, 0.5]) {
    assert.equal(
      decideRouting([{ ...critical('total', 0.6), sourceFound: false }], [], {
        ...THRESHOLDS,
        criticalFieldConfidence,
      }).auto,
      false,
    )
    assert.equal(
      decideRouting([critical('total', null)], [], { ...THRESHOLDS, criticalFieldConfidence }).auto,
      false,
    )
  }
})
