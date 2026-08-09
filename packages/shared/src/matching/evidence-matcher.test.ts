import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { OcrBlock } from '../contracts/ocr'
import {
  levenshtein,
  matchEvidence,
  type EvidenceMatch,
  type EvidencePage,
} from './evidence-matcher'

/** Unit-тесты модуля сопоставления на подготовленных OCR-фикстурах (ТЗ 6.5). */

/** assert.ok сужает только выражение, не объединение — нужен явный guard. */
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

describe('точное вхождение', () => {
  it('находит фрагмент внутри одного блока и возвращает его bbox', () => {
    const b = block('Поставщик: ООО «Мегастрой»')
    const match = matchEvidence('ООО «Мегастрой»', 1, [page(1, [b])])
    expectFound(match)
    assert.equal(match.method, 'exact')
    assert.deepEqual(match.bbox, b.bbox)
    assert.equal(match.pageMismatch, false)
  })

  it('не зависит от регистра', () => {
    const match = matchEvidence('acme gmbh', 1, [page(1, [block('Supplier: ACME GMBH')])])
    expectFound(match)
    assert.equal(match.method, 'exact')
  })

  it('схлопывает множественные пробелы', () => {
    const match = matchEvidence('Invoice   DF-1001', 1, [page(1, [block('Invoice DF-1001')])])
    expectFound(match)
  })
})

describe('перенос значения на две строки', () => {
  it('склеивает соседние блоки и объединяет bbox', () => {
    const first = block('Общество с ограниченной')
    const second = block('ответственностью «Вектор»')
    const match = matchEvidence('Общество с ограниченной ответственностью «Вектор»', 1, [
      page(1, [block('шапка документа'), first, second]),
    ])
    expectFound(match)
    // Объединённый bbox накрывает оба блока.
    assert.ok(match.bbox.y <= first.bbox.y)
    assert.ok(match.bbox.y + match.bbox.height >= second.bbox.y + second.bbox.height)
  })

  it('усредняет OCR-уверенность блоков окна', () => {
    const match = matchEvidence('первая часть вторая часть', 1, [
      page(1, [block('первая часть', 1), block('вторая часть', 0.5)]),
    ])
    expectFound(match)
    assert.equal(match.ocrConfidence, 0.75)
  })
})

describe('дефисы', () => {
  it('находит слово, разорванное переносом с дефисом', () => {
    const match = matchEvidence('Мегастрой', 1, [page(1, [block('Мега-'), block('строй')])])
    expectFound(match)
  })

  it('различие в дефисах покрывается нечётким сопоставлением', () => {
    const match = matchEvidence('DF-1001-A', 1, [page(1, [block('Номер: DF 1001 A')])])
    expectFound(match)
    assert.equal(match.method, 'fuzzy')
  })
})

describe('разрывы в числах', () => {
  it('находит сумму, разбитую OCR на отдельные блоки', () => {
    const match = matchEvidence('1200,00', 1, [page(1, [block('1'), block('200,00')])])
    expectFound(match)
  })

  it('находит сумму с пробелом-разделителем тысяч в одном блоке', () => {
    const match = matchEvidence('1 200,00 EUR', 1, [page(1, [block('Итого: 1 200,00 EUR')])])
    expectFound(match)
    assert.equal(match.method, 'exact')
  })
})

describe('пунктуация', () => {
  it('находит фрагмент при расхождении в кавычках и запятых', () => {
    const match = matchEvidence('ООО Вектор', 1, [page(1, [block('ООО «Вектор»,')])])
    expectFound(match)
  })

  it('терпит мелкие OCR-ошибки в пределах 15%', () => {
    // Потерянная буква в «Munich» и съеденная запятая: в пределах 15% от 16 символов.
    const match = matchEvidence('Acme GmbH, Munich', 1, [page(1, [block('Acme GmbH Munch')])])
    expectFound(match)
    assert.equal(match.method, 'fuzzy')
  })

  it('не принимает фрагмент с расхождением больше допуска', () => {
    const match = matchEvidence('совершенно другой текст', 1, [
      page(1, [block('ничего похожего здесь нет')]),
    ])
    assert.equal(match.found, false)
  })
})

describe('страница не совпала', () => {
  it('находит фрагмент на другой странице и помечает расхождение', () => {
    const match = matchEvidence('DF-1001', 1, [
      page(1, [block('титульный лист')]),
      page(2, [block('Invoice DF-1001')]),
    ])
    expectFound(match)
    assert.equal(match.page, 2)
    assert.equal(match.pageMismatch, true)
  })

  it('точное совпадение на чужой странице сильнее нечёткого на заявленной', () => {
    const match = matchEvidence('Total: 1440.00', 2, [
      page(1, [block('Total: 1440.00')]),
      page(2, [block('Tota1 1440 00')]),
    ])
    expectFound(match)
    assert.equal(match.page, 1)
    assert.equal(match.method, 'exact')
  })
})

describe('фрагмент не найден', () => {
  it('возвращает found=false, когда фрагмента нет нигде', () => {
    const match = matchEvidence('несуществующее значение', 1, [
      page(1, [block('текст страницы')]),
      page(2, [block('другой текст')]),
    ])
    assert.equal(match.found, false)
  })

  it('возвращает found=false на пустом evidence', () => {
    assert.equal(matchEvidence('   ', 1, [page(1, [block('текст')])]).found, false)
  })
})

describe('левенштейн', () => {
  it('считает расстояние', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3)
    assert.equal(levenshtein('одинаково', 'одинаково'), 0)
  })

  it('обрывается на бюджете', () => {
    assert.ok(levenshtein('completely different', 'ничего общего', 3) > 3)
  })
})
