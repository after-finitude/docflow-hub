/**
 * Browser entry (`@docflow/shared/browser`): enums, constants, labels and pure
 * predicates, without the zod contracts. The root barrel is CommonJS and pulls
 * every module, zod included, into the client bundle; apps/web imports values
 * from here and types from the root.
 */
export * from './enums'
export * from './constants'
export * from './labels'
export * from './document-actions'
export { fieldConfidenceThreshold } from './confidence/score'
