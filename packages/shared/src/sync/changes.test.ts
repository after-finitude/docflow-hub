import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideIngest, diffSnapshot, type SourceFile } from './changes'

function file(sourcePath: string, contentHash: string): SourceFile {
  return { sourcePath, name: sourcePath, mimeType: 'application/pdf', sizeBytes: 10, contentHash }
}

describe('diffSnapshot', () => {
  it('adds a new file to upserted', () => {
    const diff = diffSnapshot([file('a.pdf', 'h1')], [])
    assert.deepEqual(
      diff.upserted.map((f) => f.sourcePath),
      ['a.pdf'],
    )
    assert.deepEqual(diff.deletedPaths, [])
  })

  it('does not re-ingest an unchanged file', () => {
    const diff = diffSnapshot([file('a.pdf', 'h1')], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(diff.upserted, [])
  })

  it('treats a different hash at the same path as a change', () => {
    const diff = diffSnapshot([file('a.pdf', 'h2')], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(
      diff.upserted.map((f) => f.contentHash),
      ['h2'],
    )
  })

  it('treats a file missing from the snapshot as removed', () => {
    const diff = diffSnapshot(
      [file('a.pdf', 'h1')],
      [
        { sourcePath: 'a.pdf', checksum: 'h1' },
        { sourcePath: 'b.pdf', checksum: 'h9' },
      ],
    )
    assert.deepEqual(diff.deletedPaths, ['b.pdf'])
  })

  it('marks every known file removed for an empty snapshot', () => {
    const diff = diffSnapshot([], [{ sourcePath: 'a.pdf', checksum: 'h1' }])
    assert.deepEqual(diff.deletedPaths, ['a.pdf'])
  })
})

describe('decideIngest', () => {
  it('creates version one for a new path', () => {
    assert.deepEqual(decideIngest(null, 'h1'), { action: 'create', versionNumber: 1 })
  })

  it('does not create a version for a matching hash', () => {
    assert.deepEqual(decideIngest({ checksum: 'h1', versionNumber: 3 }, 'h1'), { action: 'skip' })
  })

  it('increments the version for a new hash', () => {
    assert.deepEqual(decideIngest({ checksum: 'h1', versionNumber: 3 }, 'h2'), {
      action: 'version',
      versionNumber: 4,
    })
  })
})
