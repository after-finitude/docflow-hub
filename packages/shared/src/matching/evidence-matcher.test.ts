import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OcrBlock } from '../contracts/ocr'
import {
  levenshtein,
  matchEvidence,
  type EvidenceMatch,
  type EvidencePage,
} from './evidence-matcher'

/** Matcher unit tests on prepared OCR fixtures (spec 6.5). */

/** assert.ok narrows only the expression, not the union, so use an explicit guard. */
function expectFound(
  match: EvidenceMatch,
): asserts match is Extract<EvidenceMatch, { found: true }> {
  assert.equal(match.found, true)
}

let rowCounter = 0
function block(text: string, confidence = 0.9): OcrBlock {
  rowCounter += 1
  return {
    text,
    bbox: { x: 0.1, y: rowCounter * 0.05, width: 0.3, height: 0.04 },
    confidence,
  }
}

function page(pageNumber: number, blocks: OcrBlock[]): EvidencePage {
  return { pageNumber, blocks }
}

describe('exact match', () => {
  it('finds an excerpt inside one block and returns its bbox', () => {
    const b = block('Supplier: Megabuild LLC')
    const match = matchEvidence('Megabuild LLC', 1, [page(1, [b])])
    expectFound(match)
    assert.equal(match.method, 'exact')
    assert.deepEqual(match.bbox, b.bbox)
    assert.equal(match.pageMismatch, false)
  })

  it('is case-insensitive', () => {
    const match = matchEvidence('acme gmbh', 1, [page(1, [block('Supplier: ACME GMBH')])])
    expectFound(match)
    assert.equal(match.method, 'exact')
  })

  it('collapses repeated whitespace', () => {
    const match = matchEvidence('Invoice   DF-1001', 1, [page(1, [block('Invoice DF-1001')])])
    expectFound(match)
  })
})

describe('value split across two lines', () => {
  it('joins adjacent blocks and unions their bbox', () => {
    const first = block('Vector Limited')
    const second = block('Liability Company')
    const match = matchEvidence('Vector Limited Liability Company', 1, [
      page(1, [block('document header'), first, second]),
    ])
    expectFound(match)
    // The union bbox covers both blocks.
    assert.ok(match.bbox.y <= first.bbox.y)
    assert.ok(match.bbox.y + match.bbox.height >= second.bbox.y + second.bbox.height)
  })

  it('averages OCR confidence across window blocks', () => {
    const match = matchEvidence('first part second part', 1, [
      page(1, [block('first part', 1), block('second part', 0.5)]),
    ])
    expectFound(match)
    assert.equal(match.ocrConfidence, 0.75)
  })
})

describe('hyphens', () => {
  it('finds a word split by a line-break hyphen', () => {
    const match = matchEvidence('Megabuild', 1, [page(1, [block('Mega-'), block('build')])])
    expectFound(match)
  })

  it('handles hyphen differences with fuzzy matching', () => {
    const match = matchEvidence('DF-1001-A', 1, [page(1, [block('Number: DF 1001 A')])])
    expectFound(match)
    assert.equal(match.method, 'fuzzy')
  })
})

describe('split numbers', () => {
  it('finds an amount split into OCR blocks', () => {
    const match = matchEvidence('1200,00', 1, [page(1, [block('1'), block('200,00')])])
    expectFound(match)
  })

  it('finds an amount with a space thousands separator in one block', () => {
    const match = matchEvidence('1 200,00 EUR', 1, [page(1, [block('Total: 1 200,00 EUR')])])
    expectFound(match)
    assert.equal(match.method, 'exact')
  })
})

describe('punctuation', () => {
  it('matches table evidence with pipe separators to adjacent OCR cells', () => {
    const cells: OcrBlock[] = ['Archive digitisation', '7', '145.00', '1,015.00'].map(
      (text, index) => ({
        text,
        bbox: { x: index * 0.2, y: 0.3, width: 0.1, height: 0.02 },
        confidence: 0,
      }),
    )
    for (const separator of [' | ', '|']) {
      const match = matchEvidence(cells.map((cell) => cell.text).join(separator), 1, [
        page(1, cells),
      ])
      expectFound(match)
      assert.equal(match.method, 'fuzzy')
      assert.equal(match.ocrConfidence, 0)
      assert.ok(Math.abs(match.bbox.width - 0.7) < 1e-10)
      assert.equal(match.bbox.x, 0)
      assert.equal(match.bbox.y, 0.3)
      assert.ok(Math.abs(match.bbox.height - 0.02) < 1e-10)
    }
  })

  it('finds an excerpt despite quote and comma differences', () => {
    const match = matchEvidence('Vector LLC', 1, [page(1, [block('“Vector LLC”,')])])
    expectFound(match)
  })

  it('tolerates small OCR errors within 15%', () => {
    // A missing letter in “Munich” and comma remain within 15% of 16 characters.
    const match = matchEvidence('Acme GmbH, Munich', 1, [page(1, [block('Acme GmbH Munch')])])
    expectFound(match)
    assert.equal(match.method, 'fuzzy')
  })

  it('rejects an excerpt beyond the tolerance', () => {
    const match = matchEvidence('completely different text', 1, [
      page(1, [block('nothing similar is here')]),
    ])
    assert.equal(match.found, false)
  })
})

describe('page mismatch', () => {
  it('finds an excerpt on another page and marks the mismatch', () => {
    const match = matchEvidence('DF-1001', 1, [
      page(1, [block('cover page')]),
      page(2, [block('Invoice DF-1001')]),
    ])
    expectFound(match)
    assert.equal(match.page, 2)
    assert.equal(match.pageMismatch, true)
  })

  it('prefers an exact match on another page over a fuzzy match on the reported page', () => {
    const match = matchEvidence('Total: 1440.00', 2, [
      page(1, [block('Total: 1440.00')]),
      page(2, [block('Tota1 1440 00')]),
    ])
    expectFound(match)
    assert.equal(match.page, 1)
    assert.equal(match.method, 'exact')
  })
})

describe('excerpt not found', () => {
  it('returns found=false when the excerpt is absent', () => {
    const match = matchEvidence('nonexistent value', 1, [
      page(1, [block('page text')]),
      page(2, [block('other text')]),
    ])
    assert.equal(match.found, false)
  })

  it('returns found=false for empty evidence', () => {
    assert.equal(matchEvidence('   ', 1, [page(1, [block('text')])]).found, false)
  })
})

describe('Levenshtein', () => {
  it('calculates distance', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3)
    assert.equal(levenshtein('same', 'same'), 0)
  })

  it('stops above the budget', () => {
    assert.ok(levenshtein('completely different', 'nothing alike', 3) > 3)
  })
})
