'use client'

import { ACCEPTED_MIME_TYPES } from '@docflow/shared/browser'
import { useRef } from 'react'

/**
 * Original replacement uses a hidden input because the native file picker
 * button does not match the other panel actions.
 */
export function ReplaceFileButton({
  disabled,
  onSelect,
}: {
  disabled: boolean
  onSelect: (file: File) => void | Promise<void>
}) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_MIME_TYPES.join(',')}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Clear the value so selecting the same file again triggers change.
          event.target.value = ''
          if (file) void onSelect(file)
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="Upload a different file: this creates a new document version"
        className="btn btn--ghost"
      >
        Replace file
      </button>
    </>
  )
}
