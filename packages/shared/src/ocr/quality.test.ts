import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assessOcrQuality } from './quality'

describe('assessOcrQuality', () => {
  it('хорошо распознанные страницы предупреждения не дают', () => {
    assert.equal(assessOcrQuality([{ pageNumber: 1, confidence: 0.95, textLength: 400 }]), null)
  })

  it('пустая страница — предупреждение', () => {
    const issue = assessOcrQuality([{ pageNumber: 1, confidence: null, textLength: 0 }])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [1])
    assert.match(issue.message, /текст не распознан/)
  })

  it('уверенность ниже порога — предупреждение', () => {
    const issue = assessOcrQuality([{ pageNumber: 2, confidence: 0.4, textLength: 120 }])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [2])
    assert.match(issue.message, /0\.40/)
  })

  it('отсутствие уверенности при наличии текста не считается плохим сканом', () => {
    // Провайдер может не сообщать уверенность (текстовый слой PDF).
    assert.equal(assessOcrQuality([{ pageNumber: 1, confidence: null, textLength: 300 }]), null)
  })

  it('страницы перечисляются по возрастанию', () => {
    const issue = assessOcrQuality([
      { pageNumber: 3, confidence: 0.2, textLength: 10 },
      { pageNumber: 1, confidence: null, textLength: 0 },
    ])
    assert.ok(issue)
    assert.deepEqual(issue.pages, [1, 3])
  })

  it('порог настраивается', () => {
    const pages = [{ pageNumber: 1, confidence: 0.7, textLength: 100 }]
    assert.equal(assessOcrQuality(pages, 0.6), null)
    assert.ok(assessOcrQuality(pages, 0.8))
  })

  it('документ без страниц оценивать нечем', () => {
    assert.equal(assessOcrQuality([]), null)
  })
})
