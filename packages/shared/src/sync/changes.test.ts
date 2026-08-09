import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideIngest, diffSnapshot, type SourceFile } from './changes'

function file(sourcePath: string, contentHash: string): SourceFile {
  return { sourcePath, name: sourcePath, mimeType: 'application/pdf', sizeBytes: 10, contentHash }
}

describe('diffSnapshot', () => {
  it('новый файл попадает в upserted', () => {
    const diff = diffSnapshot([file('a.pdf', 'h1')], [])
    assert.deepEqual(
      diff.upserted.map((f) => f.sourcePath),
      ['a.pdf'],
    )
    assert.deepEqual(diff.deletedPaths, [])
  })

  it('неизменённый файл не вызывает повторного приёма', () => {
    const diff = diffSnapshot([file('a.pdf', 'h1')], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(diff.upserted, [])
  })

  it('другой хеш по тому же пути — изменение', () => {
    const diff = diffSnapshot([file('a.pdf', 'h2')], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(
      diff.upserted.map((f) => f.contentHash),
      ['h2'],
    )
  })

  it('исчезнувший из снимка файл считается удалённым', () => {
    const diff = diffSnapshot(
      [file('a.pdf', 'h1')],
      [
        { sourcePath: 'a.pdf', checksum: 'h1' },
        { sourcePath: 'b.pdf', checksum: 'h9' },
      ],
    )
    assert.deepEqual(diff.deletedPaths, ['b.pdf'])
  })

  it('пустой снимок помечает удалёнными все известные файлы', () => {
    const diff = diffSnapshot([], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(diff.deletedPaths, ['a.pdf'])
  })
})

describe('decideIngest', () => {
  it('первого файла по пути ещё не было', () => {
    assert.deepEqual(decideIngest(null, 'h1'), { action: 'create', versionNumber: 1 })
  })

  it('совпадение хеша не создаёт версию', () => {
    assert.deepEqual(decideIngest({ checksum: 'h1', versionNumber: 3 }, 'h1'), { action: 'skip' })
  })

  it('новый хеш увеличивает номер версии', () => {
    assert.deepEqual(decideIngest({ checksum: 'h1', versionNumber: 3 }, 'h2'), {
      action: 'version',
      versionNumber: 4,
    })
  })
})
