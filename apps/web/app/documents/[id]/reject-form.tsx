'use client'

import { REJECT_REASONS, REJECT_REASON_LABELS } from '@docflow/shared/browser'
import type { RejectReason } from '@docflow/shared'
import { useState } from 'react'

export function RejectForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void
  onSubmit: (reason: RejectReason, comment: string) => Promise<void>
}) {
  const [reason, setReason] = useState<RejectReason>(REJECT_REASONS[0])
  const [comment, setComment] = useState('')

  return (
    <div className="mt-3 rounded-[6px] border border-rule bg-paper-2 p-3">
      <label className="block">
        <span className="label mb-1">Rejection reason</span>
        <select
          className="field"
          value={reason}
          onChange={(event) => setReason(event.target.value as RejectReason)}
        >
          {REJECT_REASONS.map((option) => (
            <option key={option} value={option}>
              {REJECT_REASON_LABELS[option]}
            </option>
          ))}
        </select>
      </label>
      <textarea
        className="field mt-2"
        rows={2}
        placeholder="Comment (optional)"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void onSubmit(reason, comment)}
          className="btn btn--danger btn--sm"
        >
          Reject document
        </button>
        <button type="button" onClick={onCancel} className="btn btn--ghost btn--sm">
          Cancel
        </button>
      </div>
    </div>
  )
}
