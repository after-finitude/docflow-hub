/**
 * Single organization in the required scope (spec §7 tenant_id note). Tenant
 * isolation is not implemented, so this value is fixed.
 */
export const DEFAULT_TENANT_ID = '00000000-0000-0000-0000-000000000001'

/**
 * Confidence ceiling for a field without a source (spec §9, 6.5).
 */
export const NO_SOURCE_CONFIDENCE_CAP = 0.6

/**
 * OCR quality threshold (spec §10). This is a constant because OCR runs before
 * classification, when no document type or schema exists.
 */
export const MIN_OCR_CONFIDENCE = 0.6

/**
 * Session-cookie name shared by the API and Next.js proxy. A constant prevents
 * mismatched values and redirect loops when Next builds without .env.
 */
export const SESSION_COOKIE_NAME = 'docflow_session'

/** Temporarily paused at the user's request; enable after live Drive/Sheets acceptance. */
export const GOOGLE_WORKSPACE_ENABLED = false
