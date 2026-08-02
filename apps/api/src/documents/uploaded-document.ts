/**
 * Загруженный файл в том виде, в каком его передаёт multer.
 *
 * Тип объявлен явно, а не взят из глобального `Express.Multer.File`:
 * ambient-дополнение из @types/multer не подхватывается TypeScript 7, а из
 * всех полей multer здесь нужны только эти четыре.
 */
export interface UploadedDocument {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

/** Сигнатура fileFilter multer — объявлена по той же причине. */
export type MulterFileFilter = (
  request: unknown,
  file: { mimetype: string; originalname: string },
  callback: (error: Error | null, acceptFile: boolean) => void,
) => void
