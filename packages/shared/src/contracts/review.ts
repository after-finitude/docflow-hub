import { z } from 'zod'
import { REJECT_REASONS } from '../enums'

/**
 * Review Workspace contracts (spec 5.2).
 */

/** Simple line items in a flat table without nesting (spec §4). */
export const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.number().nullable(),
  unit_price: z.number().nullable(),
  amount: z.number().nullable(),
})
export type LineItem = z.infer<typeof lineItemSchema>

/** Dates and references retain the text printed in the statement. */
export const bankTransactionSchema = z
  .object({
    date: z.string().nullable(),
    reference: z.string().nullable(),
    payment_type: z.string().nullable(),
    description: z.string(),
    credit: z.number().finite().nonnegative().nullable(),
    debit: z.number().finite().nonnegative().nullable(),
    balance: z.number().finite().nullable(),
  })
  .strict()
export type BankTransaction = z.infer<typeof bankTransactionSchema>

export const tableValueSchema = z.union([
  z.array(lineItemSchema.strict()),
  z.array(bankTransactionSchema),
])
export type TableValue = z.infer<typeof tableValueSchema>

/** The reserved transactions field uses statement rows; other arrays keep invoice rows. */
export function tableValueSchemaFor(name: string) {
  return name === 'transactions' ? z.array(bankTransactionSchema) : z.array(lineItemSchema.strict())
}

/**
 * Field edit: string for server-normalized scalars, array for line items, and
 * null to clear explicitly.
 */
export const updateFieldRequestSchema = z.object({
  value: z.union([z.string(), tableValueSchema, z.null()]),
})
export type UpdateFieldRequest = z.infer<typeof updateFieldRequestSchema>

export const rejectRequestSchema = z.object({
  reason: z.enum(REJECT_REASONS),
  comment: z.string().max(1000).optional(),
})
export type RejectRequest = z.infer<typeof rejectRequestSchema>
