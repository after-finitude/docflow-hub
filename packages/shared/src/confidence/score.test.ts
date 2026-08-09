import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NO_SOURCE_CONFIDENCE_CAP } from '../constants'
import { scoreConfidence } from './score'

describe('scoreConfidence', () => {
  it('без источника уверенность ограничена потолком 0.6 (ТЗ §9)', () => {
    const score = scoreConfidence({ extraction: 1, ocr: null, sourceFound: false })
    assert.ok(score.confidence <= NO_SOURCE_CONFIDENCE_CAP)
    assert.ok(score.reasons.some((reason) => reason.includes('не найден')))
  })

  it('чистый скан с найденным источником даёт высокую уверенность', () => {
    const score = scoreConfidence({ extraction: 0.9, ocr: 0.98, sourceFound: true })
    assert.ok(score.confidence > 0.85)
    assert.equal(score.reasons.length, 0)
  })

  it('низкий OCR снижает уверенность и объясняет причину', () => {
    const clean = scoreConfidence({ extraction: 0.9, ocr: 0.95, sourceFound: true })
    const noisy = scoreConfidence({ extraction: 0.9, ocr: 0.4, sourceFound: true })
    assert.ok(noisy.confidence < clean.confidence)
    assert.ok(noisy.reasons.some((reason) => reason.includes('качество распознавания')))
  })

  it('несовпадение страницы снижает уверенность (ТЗ 6.5 п.4)', () => {
    const same = scoreConfidence({ extraction: 0.9, ocr: 0.9, sourceFound: true })
    const other = scoreConfidence({
      extraction: 0.9,
      ocr: 0.9,
      sourceFound: true,
      pageMismatch: true,
    })
    assert.ok(other.confidence < same.confidence)
    assert.ok(other.reasons.some((reason) => reason.includes('странице')))
  })

  it('провал валидации снижает уверенность', () => {
    const ok = scoreConfidence({ extraction: 0.9, ocr: 0.9, sourceFound: true })
    const failed = scoreConfidence({
      extraction: 0.9,
      ocr: 0.9,
      sourceFound: true,
      failedValidation: true,
    })
    assert.ok(failed.confidence < ok.confidence)
  })
})
