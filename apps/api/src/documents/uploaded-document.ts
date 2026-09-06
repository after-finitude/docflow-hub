import type { AuthenticatedRequest } from '../auth/decorators'

export interface UploadRequest extends AuthenticatedRequest {
  uploadMetadata?: { originalname: string; mimetype: string }
}

/**
 * Uploaded file in the shape provided by multer.
 *
 * Declared explicitly instead of using global `Express.Multer.File`: TypeScript 7
 * does not load the @types/multer ambient extension, and only four fields are needed.
 */
export interface UploadedDocument {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

/** Multer fileFilter signature, declared explicitly for the same reason. */
export type MulterFileFilter = (
  request: unknown,
  file: { mimetype: string; originalname: string },
  callback: (error: Error | null, acceptFile: boolean) => void,
) => void
