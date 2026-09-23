'use client'

import {
  EXPORT_DESTINATIONS,
  GOOGLE_WORKSPACE_ENABLED,
  EXPORT_DESTINATION_LABELS,
  type ExportDestination,
  type ExportDto,
} from '@docflow/shared'

export function ExportPanel({
  exports,
  busy,
  onExport,
  onDownload,
}: {
  exports: ExportDto[]
  busy: boolean
  onExport: (destination: ExportDestination, exportKey?: string) => void
  onDownload: (exportId: string) => void
}) {
  return (
    <div className="mt-4 border-t border-rule pt-3">
      <h3 className="mono text-2xs tracking-[0.06em] text-muted uppercase">Export</h3>

      {exports.map((item) => (
        <p key={item.id} className="mt-1.5 text-xs">
          <span className="text-ink-2">{EXPORT_DESTINATION_LABELS[item.destination]}</span>{' '}
          {item.status === 'succeeded' ? (
            <>
              <span className="text-ok">completed {formatWhen(item.exportedAt)}</span>
              {item.destination === 'file_json' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm ml-2"
                  disabled={busy}
                  onClick={() => onDownload(item.id)}
                >
                  Download JSON
                </button>
              )}
            </>
          ) : item.status === 'failed' ? (
            <span className="text-danger">
              failed (<span className="mono">{item.errorCode}</span>), attempts {item.attempts}
            </span>
          ) : (
            <span className="text-muted">pending</span>
          )}
          {item.status !== 'succeeded' && (
            <button
              type="button"
              className="btn btn--ghost btn--sm ml-2"
              disabled={busy || (item.destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED)}
              title={
                item.destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED
                  ? 'Google Sheets is temporarily disabled'
                  : undefined
              }
              onClick={() => onExport(item.destination, item.exportKey)}
            >
              Retry export
            </button>
          )}
        </p>
      ))}

      <div className="mt-2 flex flex-wrap gap-2">
        {EXPORT_DESTINATIONS.map((destination) => {
          if (exports.some((item) => item.destination === destination)) return null
          return (
            <button
              key={destination}
              type="button"
              disabled={busy || (destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED)}
              onClick={() => onExport(destination)}
              className="btn btn--ghost btn--sm"
            >
              Export to {EXPORT_DESTINATION_LABELS[destination]}
              {destination === 'google_sheets' && !GOOGLE_WORKSPACE_ENABLED
                ? ' (temporarily disabled)'
                : ''}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function formatWhen(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
    : ''
}
