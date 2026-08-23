import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessOcrQuality } from './quality'

describe('assessOcrQuality', () => {
  it('does not warn for well-recognized pages', () => {
    assert.equal(assessOcrQuality([{ pageNumber: 1, confidence: 0.95, textLength: 400 }]), null)
  })

  it('warns for a blank page', () => {
    const issue = assessOcrQuality([{ pageNumber: 1, confidence: null, textLength: 0 }])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [1])
    assert.match(issue.message, /no text recognized/)
  })

  it('warns below the confidence threshold', () => {
    const issue = assessOcrQuality([{ pageNumber: 2, confidence: 0.4, textLength: 120 }])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [2])
    assert.match(issue.message, /0\.40/)
  })

  it('does not treat missing confidence with text as a poor scan', () => {
    // A provider may omit confidence for a PDF text layer.
    assert.equal(assessOcrQuality([{ pageNumber: 1, confidence: null, textLength: 300 }]), null)
  })

  it('lists pages in ascending order', () => {
    const issue = assessOcrQuality([
      { pageNumber: 3, confidence: 0.2, textLength: 10 },
      { pageNumber: 1, confidence: null, textLength: 0 },
    ])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [1, 3])
  })

  it('supports a configurable threshold', () => {
    const pages = [{ pageNumber: 1, confidence: 0.7, textLength: 100 }]
    assert.equal(assessOcrQuality(pages, 0.6), null)
    assert.ok(assessOcrQuality(pages, 0.8))
  })

  it('returns no assessment for a document without pages', () => {
    assert.equal(assessOcrQuality([]), null)
  })
})
