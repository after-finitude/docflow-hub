import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideRouting, type RoutingField } from './routing'

const THRESHOLDS = { autoClassify: 0.7, criticalFieldConfidence: 0.8, fieldConfidence: 0.6 }

function critical(name: string, confidence: number | null): RoutingField {
  return { name, label: name, isCritical: true, confidence }
}

describe('decideRouting', () => {
  it('без blocking и с уверенными критичными полями документ проходит автоматически', () => {
    const decision = decideRouting([critical('grand_total', 0.95)], [], THRESHOLDS)
    assert.equal(decision.auto, true)
    assert.equal(decision.reasons.length, 0)
  })

  it('нерешённая blocking-ошибка останавливает автопроход', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'blocking', resolved: false }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, false)
    assert.equal(decision.blockingCount, 1)
  })

  it('решённая blocking-ошибка не мешает', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'blocking', resolved: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })

  it('предупреждения не мешают автопроходу, но считаются', () => {
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

  it('предупреждение с forcesReview останавливает автопроход (ТЗ 6.3)', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'warning', resolved: false, forcesReview: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, false)
    assert.ok(decision.reasons.some((reason) => reason.includes('ручного разбора')))
  })

  it('решённоеforcesReview-предупреждение автопроходу не мешает', () => {
    const decision = decideRouting(
      [critical('grand_total', 0.95)],
      [{ severity: 'warning', resolved: true, forcesReview: true }],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })

  it('критичное поле ниже порога отправляет на проверку', () => {
    const decision = decideRouting([critical('supplier_name', 0.5)], [], THRESHOLDS)
    assert.equal(decision.auto, false)
    assert.deepEqual(decision.lowConfidenceFields, [{ name: 'supplier_name', confidence: 0.5 }])
  })

  it('критичное поле без значения приравнивается к нулевой уверенности', () => {
    const decision = decideRouting([critical('supplier_name', null)], [], THRESHOLDS)
    assert.equal(decision.auto, false)
  })

  it('некритичное поле с низкой уверенностью автопроходу не мешает', () => {
    const decision = decideRouting(
      [
        critical('grand_total', 0.9),
        { name: 'due_date', label: 'due_date', isCritical: false, confidence: 0.1 },
      ],
      [],
      THRESHOLDS,
    )
    assert.equal(decision.auto, true)
  })
})
