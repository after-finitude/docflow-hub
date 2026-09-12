import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { NO_SOURCE_CONFIDENCE_CAP } from '../constants'
import { scoreConfidence } from './score'

describe('scoreConfidence', () => {
  it('caps confidence at 0.6 without a source (spec §9)', () => {
    const score = scoreConfidence({ extraction: 1, ocr: null, sourceFound: false })
    assert.ok(score.confidence <= NO_SOURCE_CONFIDENCE_CAP)
    assert.ok(score.reasons.some((reason) => reason.includes('not found')))
  })

  it('gives high confidence for a clean scan with a source', () => {
    const score = scoreConfidence({ extraction: 0.9, ocr: 0.98, sourceFound: true })
    assert.ok(score.confidence > 0.85)
    assert.equal(score.reasons.length, 0)
  })

  it('reduces confidence for poor OCR and explains why', () => {
    const clean = scoreConfidence({ extraction: 0.9, ocr: 0.95, sourceFound: true })
    const noisy = scoreConfidence({ extraction: 0.9, ocr: 0.4, sourceFound: true })
    assert.ok(noisy.confidence < clean.confidence)
    assert.ok(noisy.reasons.includes('OCR accuracy in the source area requires review'))
  })

  it('keeps uncalibrated OCR conservative without claiming poor image quality', () => {
    const score = scoreConfidence({ extraction: 0.9, ocr: 0, sourceFound: true })
    assert.equal(score.confidence, 0.54)
    assert.deepEqual(score.reasons, ['OCR accuracy in the source area requires review'])
  })

  it('reduces confidence for a page mismatch (spec 6.5.4)', () => {
    const same = scoreConfidence({ extraction: 0.9, ocr: 0.9, sourceFound: true })
    const other = scoreConfidence({
      extraction: 0.9,
      ocr: 0.9,
      sourceFound: true,
      pageMismatch: true,
    })
    assert.ok(other.confidence < same.confidence)
    assert.ok(other.reasons.some((reason) => reason.includes('page')))
  })

  it('reduces confidence after validation failure', () => {
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
