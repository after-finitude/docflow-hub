import type { BoundingBox, OcrBlock } from '../contracts/ocr'

/**
 * Evidence → bbox matching (spec 6.5). The LLM returns a verbatim excerpt and
 * page; this code locates its coordinates.
 *
 * Order: exact match, then fuzzy after whitespace/case normalization with
 * Levenshtein ≤15%. A block returns its bbox; adjacent blocks return a union.
 * A match on another page lowers confidence; no match leaves the field unsourced.
 */

export interface EvidencePage {
  pageNumber: number
  blocks: OcrBlock[]
}

export type EvidenceMatch =
  | {
      found: true
      page: number
      bbox: BoundingBox
      /** Page differs from the one reported by the LLM (spec 6.5.4). */
      pageMismatch: boolean
      /** Mean OCR confidence of matched blocks. */
      ocrConfidence: number
      /** exact after normalization; fuzzy within the Levenshtein allowance. */
      method: 'exact' | 'fuzzy'
    }
  | { found: false }

/** Maximum adjacent blocks joined into a multiline window. */
const MAX_WINDOW = 4
/** Fuzzy-match allowance as a fraction of excerpt length (spec 6.5.2). */
const FUZZY_TOLERANCE = 0.15

export function matchEvidence(
  evidence: string,
  claimedPage: number,
  pages: EvidencePage[],
): EvidenceMatch {
  const needle = normalize(evidence)
  if (!needle) return { found: false }

  // Search the reported page first, then the others in page order.
  const ordered = pages.toSorted((a, b) => {
    if (a.pageNumber === claimedPage) return -1
    if (b.pageNumber === claimedPage) return 1
    return a.pageNumber - b.pageNumber
  })

  // Search exact matches on every page before fuzzy matches so a fuzzy hit on
  // the reported page cannot outrank an exact hit elsewhere.
  for (const method of ['exact', 'fuzzy'] as const) {
    for (const page of ordered) {
      const hit = matchOnPage(needle, page.blocks, method === 'fuzzy')
      if (hit) {
        return {
          found: true,
          page: page.pageNumber,
          bbox: hit.bbox,
          pageMismatch: page.pageNumber !== claimedPage,
          ocrConfidence: hit.ocrConfidence,
          method,
        }
      }
    }
  }

  return { found: false }
}

interface PageHit {
  bbox: BoundingBox
  ocrConfidence: number
}

function matchOnPage(needle: string, blocks: OcrBlock[], fuzzy: boolean): PageHit | null {
  // Prefer single blocks because their bbox is more precise.
  for (const block of blocks) {
    if (contains(normalize(block.text), needle, fuzzy)) {
      return { bbox: block.bbox, ocrConfidence: block.confidence }
    }
  }

  // Adjacent block windows handle values split across lines (spec 6.5.3).
  for (let size = 2; size <= MAX_WINDOW; size++) {
    for (let start = 0; start + size <= blocks.length; start++) {
      const window = blocks.slice(start, start + size)
      for (const joined of joinVariants(window)) {
        if (contains(joined, needle, fuzzy)) {
          return {
            bbox: unionBbox(window.map((block) => block.bbox)),
            ocrConfidence: average(window.map((block) => block.confidence)),
          }
        }
      }
    }
  }

  return null
}

/**
 * Window variants join with a space, directly for split numbers, or after
 * removing a line-break hyphen.
 */
function joinVariants(window: OcrBlock[]): string[] {
  const texts = window.map((block) => normalize(block.text))
  const variants = new Set<string>()
  variants.add(texts.join(' '))
  variants.add(texts.join(''))
  variants.add(
    texts.reduce(
      (acc, part) => (acc.endsWith('-') ? acc.slice(0, -1) + part : acc ? `${acc} ${part}` : part),
      '',
    ),
  )
  return [...variants]
}

/** Normalize case and whitespace for matching (spec 6.5.2). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Fuzzy matching removes punctuation and treats table pipes and hyphens as spaces so
 * “DF-1001-A” can match “DF 1001 A”.
 */
function stripPunctuation(text: string): string {
  return text
    .replace(/[.,;:!?'"«»()[\]{}]/g, '')
    .replace(/[-|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function contains(haystack: string, needle: string, fuzzy: boolean): boolean {
  if (haystack.includes(needle)) return true
  if (!fuzzy) return false

  const cleanNeedle = stripPunctuation(needle)
  const cleanHaystack = stripPunctuation(haystack)
  if (!cleanNeedle) return false
  if (cleanHaystack.includes(cleanNeedle)) return true

  const budget = Math.floor(cleanNeedle.length * FUZZY_TOLERANCE)
  if (budget === 0) return false

  // Slide over words because the excerpt may be inside a longer block.
  const words = cleanHaystack.split(' ')
  const needleWords = cleanNeedle.split(' ').length
  for (let span = Math.max(1, needleWords - 1); span <= needleWords + 1; span++) {
    for (let start = 0; start + span <= words.length; start++) {
      const candidate = words.slice(start, start + span).join(' ')
      if (Math.abs(candidate.length - cleanNeedle.length) > budget) continue
      if (levenshtein(candidate, cleanNeedle, budget) <= budget) return true
    }
  }
  return false
}

/** Levenshtein distance with early exit above the budget. */
export function levenshtein(a: string, b: string, budget = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > budget) return budget + 1

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      if (current[j]! < rowMin) rowMin = current[j]!
    }
    if (rowMin > budget) return budget + 1
    previous = current
  }
  return previous[b.length]!
}

function unionBbox(boxes: BoundingBox[]): BoundingBox {
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y,
  }
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}
