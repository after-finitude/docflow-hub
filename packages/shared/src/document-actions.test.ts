import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DOCUMENT_ACTIONS,
  canPerform,
  isInFlight,
  isRoutable,
  type DocumentAction,
} from './document-actions'
import { DOCUMENT_STATUSES, type DocumentStatus } from './enums'

// The same rules seen per status rather than per action, so a change to the
// table has to be made twice on purpose.
const ALLOWED: Record<DocumentStatus, DocumentAction[]> = {
  received: ['sendToManual'],
  processing: ['sendToManual'],
  needs_review: [
    'editField',
    'reject',
    'approve',
    'changeType',
    'reprocess',
    'retryRun',
    'sendToManual',
    'replaceFile',
  ],
  approved: ['editField', 'reject', 'changeType', 'reprocess', 'export', 'retryRun', 'replaceFile'],
  exported: ['export'],
  failed: [
    'editField',
    'reject',
    'changeType',
    'reprocess',
    'retryRun',
    'sendToManual',
    'replaceFile',
  ],
  rejected: ['changeType', 'reprocess', 'retryRun', 'replaceFile'],
}

describe('document actions', () => {
  it('permits each operator action exactly in its listed statuses', () => {
    const actions = Object.keys(DOCUMENT_ACTIONS) as DocumentAction[]
    for (const status of DOCUMENT_STATUSES)
      for (const action of actions)
        assert.equal(
          canPerform(action, status),
          ALLOWED[status].includes(action),
          `${action} in ${status}`,
        )
  })

  it('treats only received and processing as in flight', () => {
    assert.deepEqual(DOCUMENT_STATUSES.filter(isInFlight), ['received', 'processing'])
  })

  it('never routes an exported or rejected document', () => {
    assert.deepEqual(
      DOCUMENT_STATUSES.filter((status) => !isRoutable(status)),
      ['exported', 'rejected'],
    )
  })
})
