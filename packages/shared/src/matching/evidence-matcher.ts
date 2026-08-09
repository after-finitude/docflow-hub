import type { BoundingBox, OcrBlock } from '../contracts/ocr'

/**
 * Сопоставление evidence → bbox (ТЗ 6.5). Ключевой механизм системы:
 * LLM возвращает дословный фрагмент и страницу, координаты ищутся здесь.
 *
 * Порядок: точное вхождение → нечёткое (нормализация пробелов и регистра,
 * Левенштейн ≤ 15% длины фрагмента); один блок → его bbox, последовательность
 * соседних блоков → объединённый bbox; фрагмент на другой странице →
 * фактическая страница со снижением уверенности; не найден нигде —
 * поле остаётся без источника (confidence cap 0.6 накладывает вызывающий).
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
      /** Страница не совпала с заявленной LLM (ТЗ 6.5 п.4). */
      pageMismatch: boolean
      /** Средняя OCR-уверенность блоков, накрытых совпадением. */
      ocrConfidence: number
      /** exact — вхождение после нормализации; fuzzy — в пределах допуска Левенштейна. */
      method: 'exact' | 'fuzzy'
    }
  | { found: false }

/** Максимум соседних блоков, склеиваемых в окно (перенос значения на строки). */
const MAX_WINDOW = 4
/** Допуск нечёткого сопоставления — доля длины фрагмента (ТЗ 6.5 п.2). */
const FUZZY_TOLERANCE = 0.15

export function matchEvidence(
  evidence: string,
  claimedPage: number,
  pages: EvidencePage[],
): EvidenceMatch {
  const needle = normalize(evidence)
  if (!needle) return { found: false }

  // Заявленная страница ищется первой; остальные — по возрастанию номера.
  const ordered = pages.toSorted((a, b) => {
    if (a.pageNumber === claimedPage) return -1
    if (b.pageNumber === claimedPage) return 1
    return a.pageNumber - b.pageNumber
  })

  // Два прохода: сначала точное совпадение на любой странице, затем нечёткое.
  // Иначе нечёткое совпадение на заявленной странице обгоняло бы точное на
  // фактической, и bbox указывал бы не туда.
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
  // Одиночные блоки — приоритетнее окон: точнее bbox.
  for (const block of blocks) {
    if (contains(normalize(block.text), needle, fuzzy)) {
      return { bbox: block.bbox, ocrConfidence: block.confidence }
    }
  }

  // Окна соседних блоков: значение перенесено на несколько строк (ТЗ 6.5 п.3).
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
 * Варианты склейки окна: через пробел (обычный перенос), вплотную (разрыв
 * внутри числа: «1 200,00» разбитое OCR на блоки) и со снятым дефисом
 * переноса («Мега-» + «строй» → «Мегастрой»).
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

/** Нормализация для сопоставления: регистр и пробелы (ТЗ 6.5 п.2). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Для нечёткого прохода дополнительно снимается пунктуация; дефисы становятся
 * пробелами, чтобы «DF-1001-A» сопоставлялся с «DF 1001 A» пословно.
 */
function stripPunctuation(text: string): string {
  return text
    .replace(/[.,;:!?'"«»()[\]{}]/g, '')
    .replace(/-/g, ' ')
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

  // Скользящее сравнение по словам: фрагмент может лежать внутри длинного
  // блока, поэтому сравнивается с каждым отрезком близкой длины.
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

/** Расстояние Левенштейна с ранним выходом при превышении бюджета. */
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
