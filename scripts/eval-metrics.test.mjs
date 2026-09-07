import assert from 'node:assert/strict'
import { test } from 'node:test'
import { score, valuesMatch, median } from './eval-metrics.mjs'
const entry = (file, extra = {}) => ({
  file,
  expectedType: 'invoice',
  criticalFields: { total: 10 },
  expectedFields: { total: 10, optional: null },
  expectedAutoAllowed: true,
  ...extra,
})
const fields = [
  { name: 'total', normalizedValue: 10 },
  { name: 'optional', normalizedValue: null },
]

test('rejected, failed and Unknown documents stay in all applicable denominators', () => {
  const report = score(
    ['good', 'rejected', 'failed', 'unknown'].map((file) => entry(file)),
    [
      { file: 'good', status: 'needs_review', documentType: 'invoice', fields },
      { file: 'rejected', status: 'rejected' },
      { file: 'failed', status: 'failed', documentType: 'invoice' },
      { file: 'unknown', status: 'needs_review', documentType: 'unknown' },
    ],
  )
  assert.equal(report.counts.valid, 4)
  assert.equal(report.counts.classifiedCorrect, 2)
  assert.equal(report.counts.criticalTotal, 4)
  assert.equal(report.counts.criticalMatched, 1)
  assert.equal(report.counts.fieldsTotal, 8)
  assert.equal(report.counts.fieldsCovered, 2)
  assert.equal(report.targetsMet, false)
})
test('Missing requires an actual null field, not omission, empty text or a fabricated value', () => {
  for (const [value, covered] of [
    [undefined, 1],
    ['', 1],
    ['invented', 1],
    [null, 2],
  ]) {
    const actual =
      value === undefined ? [fields[0]] : [fields[0], { name: 'optional', normalizedValue: value }]
    const report = score(
      [entry('one')],
      [{ file: 'one', status: 'approved', documentType: 'invoice', fields: actual }],
    )
    assert.equal(report.counts.fieldsCovered, covered)
    assert.equal(report.counts.falseAutoApproval, value === null ? 0 : 1)
  }
  assert.equal(valuesMatch(null, ''), false)
})
test('false auto-approval covers negative cases, wrong type and noncritical errors in any subset', () => {
  for (const [expected, result] of [
    [
      entry('one', {
        expectedType: null,
        criticalFields: {},
        expectedFields: {},
        expectedAutoAllowed: false,
      }),
      { documentType: 'invoice', fields },
    ],
    [entry('one', { expectedAutoAllowed: false }), { documentType: 'invoice', fields }],
    [entry('one'), { documentType: 'contract', fields }],
    [
      entry('one'),
      {
        documentType: 'invoice',
        fields: [fields[0], { name: 'optional', normalizedValue: 'wrong' }],
      },
    ],
  ])
    assert.equal(
      score([expected], [{ file: 'one', status: 'approved', ...result }]).counts.falseAutoApproval,
      1,
    )
  assert.equal(score([], []).targetsMet, false)
  assert.equal(
    score([entry('one')], [{ file: 'one', status: 'approved', documentType: 'invoice', fields }])
      .counts.falseAutoApproval,
    0,
  )
  assert.equal(median([]), null)
  assert.equal(median([8, 2, 4, 6]), 5)
})
