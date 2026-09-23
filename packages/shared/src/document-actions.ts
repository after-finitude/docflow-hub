import type { DocumentStatus } from './enums'

/**
 * Statuses in which an operator may perform each action. Server guards and UI
 * controls both read this table, so they cannot disagree on status. Status is not
 * the whole condition: a reserved export blocks changes separately
 * (`processingStep === 'export'` on the server, a pending or failed export in the UI).
 */
export const DOCUMENT_ACTIONS = {
  editField: ['needs_review', 'approved', 'failed'],
  reject: ['needs_review', 'approved', 'failed'],
  approve: ['needs_review'],
  changeType: ['needs_review', 'approved', 'failed', 'rejected'],
  reprocess: ['needs_review', 'approved', 'failed', 'rejected'],
  export: ['approved', 'exported'],
  retryRun: ['needs_review', 'approved', 'failed', 'rejected'],
  sendToManual: ['received', 'processing', 'needs_review', 'failed'],
  // A new version fixes a wrong or broken file, so rejected documents qualify.
  replaceFile: ['needs_review', 'approved', 'failed', 'rejected'],
} as const satisfies Record<string, readonly DocumentStatus[]>

export type DocumentAction = keyof typeof DOCUMENT_ACTIONS

export function canPerform(action: DocumentAction, status: DocumentStatus): boolean {
  return (DOCUMENT_ACTIONS[action] as readonly DocumentStatus[]).includes(status)
}

/** Still moving through the pipeline; worker results apply only in these statuses. */
export function isInFlight(status: DocumentStatus): boolean {
  return status === 'received' || status === 'processing'
}

/** Validation may move the document; exported and rejected are never routed again. */
export function isRoutable(status: DocumentStatus): boolean {
  return status !== 'exported' && status !== 'rejected'
}
