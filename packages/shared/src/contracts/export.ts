import { z } from 'zod'
import type { ExportStatus } from '../enums'

/** Адаптеры назначения обязательного объёма (ТЗ 6.8). */
export const EXPORT_DESTINATIONS = ['file_json', 'google_sheets'] as const
export type ExportDestination = (typeof EXPORT_DESTINATIONS)[number]

export const EXPORT_DESTINATION_LABELS: Record<ExportDestination, string> = {
  file_json: 'JSON-файл',
  google_sheets: 'Google Sheets',
}

export const exportRequestSchema = z.object({
  destination: z.enum(EXPORT_DESTINATIONS).optional(),
  /**
   * Ключ идемпотентности. По умолчанию выводится из документа и назначения,
   * поэтому повторный запрос не создаёт второй объект (ТЗ §9).
   */
  exportKey: z.string().min(1).max(200).optional(),
})
export type ExportRequest = z.infer<typeof exportRequestSchema>

export interface ExportDto {
  id: string
  destination: ExportDestination
  exportKey: string
  status: ExportStatus
  payloadRef: string | null
  errorCode: string | null
  attempts: number
  exportedAt: string | null
}
