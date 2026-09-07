import sharp from 'sharp'
import { openPdf, renderPdfPage } from '@docflow/core'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
class PdfInspectionUnavailableError extends Error {}

/**
 * File inspection and first-page thumbnail (spec 6.1).
 *
 * Every rejection here is a permanent file defect that retries cannot fix;
 * rejected documents never reach the LLM (spec §9, §10).
 */

export const THUMBNAIL_WIDTH = 240

export type InspectionResult =
  { ok: true; pageCount: number; thumbnail: Buffer } | { ok: false; code: string; reason: string }

/** Content signatures verify the client-supplied MIME type instead of trusting it. */
const MAGIC: Record<string, { bytes: number[]; label: string }> = {
  'application/pdf': { bytes: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  'image/jpeg': { bytes: [0xff, 0xd8, 0xff], label: 'JPEG' },
  'image/png': { bytes: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
}

function matchesMagic(buffer: Buffer, mimeType: string): boolean {
  const magic = MAGIC[mimeType]
  if (!magic) return false
  return magic.bytes.every((byte, index) => buffer[index] === byte)
}

export async function inspect(buffer: Buffer, mimeType: string): Promise<InspectionResult> {
  if (buffer.length === 0) {
    return { ok: false, code: 'empty_file', reason: 'File is empty' }
  }
  if (!matchesMagic(buffer, mimeType)) {
    const expected = MAGIC[mimeType]?.label ?? mimeType
    return {
      ok: false,
      code: 'content_mismatch',
      reason: `File content is not ${expected}; the extension or type does not match the data`,
    }
  }

  return mimeType === 'application/pdf' ? inspectPdf(buffer) : inspectImage(buffer)
}

async function inspectPdf(buffer: Buffer): Promise<InspectionResult> {
  let document: Awaited<ReturnType<typeof openPdf>> | undefined
  let pageNumber = 0
  try {
    document = await openPdf(buffer)
    if ((await document.getPermissions()) !== null)
      return {
        ok: false,
        code: 'password_protected',
        reason: 'PDF is password-protected. Upload an unprotected file',
      }
    // PDF.js recovers some invalid compressed streams even with stopAtErrors.
    // qpdf checks those streams and xrefs; warnings also reject the file.
    const temporary = await mkdtemp(join(tmpdir(), 'docflow-inspect-')).catch(() => {
      throw new PdfInspectionUnavailableError('PDF inspection unavailable; check temporary storage')
    })
    try {
      const file = join(temporary, 'input.pdf')
      await writeFile(file, buffer, { mode: 0o600 })
      try {
        await execute('qpdf', ['--check', file], { timeout: 30000, maxBuffer: 1024 * 1024 })
      } catch (error) {
        if (![2, 3].includes((error as { code: number }).code))
          throw new PdfInspectionUnavailableError(
            'PDF inspection unavailable; check qpdf installation and resource limits',
          )
        return {
          ok: false,
          code: 'corrupted_pdf',
          reason: 'PDF structure or a page stream is damaged; upload a valid replacement',
        }
      }
    } catch (error) {
      if (error instanceof PdfInspectionUnavailableError) throw error
      throw new PdfInspectionUnavailableError('PDF inspection unavailable; check temporary storage')
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => {
        throw new PdfInspectionUnavailableError(
          'PDF inspection unavailable; temporary file cleanup failed',
        )
      })
    }
    const pageCount = document.numPages
    if (pageCount < 1) return { ok: false, code: 'no_pages', reason: 'Document has no pages' }
    let thumbnail: Buffer | undefined
    for (pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await document.getPage(pageNumber)
      try {
        const { width, height } = page.getViewport({ scale: 1 })
        const { png } = await renderPdfPage(page, THUMBNAIL_WIDTH / Math.max(width, height))
        if (pageNumber === 1) thumbnail = png
      } finally {
        page.cleanup()
      }
    }
    return { ok: true, pageCount, thumbnail: thumbnail! }
  } catch (error) {
    if (error instanceof PdfInspectionUnavailableError) throw error
    if (error instanceof Error && error.name === 'PasswordException')
      return {
        ok: false,
        code: 'password_protected',
        reason: 'PDF is password-protected. Upload an unprotected file',
      }
    return {
      ok: false,
      code: 'corrupted_pdf',
      reason: `PDF is corrupted and cannot be read${pageNumber ? `: Page ${pageNumber}` : ''}`,
    }
  } finally {
    await document?.loadingTask.destroy()
  }
}

async function inspectImage(buffer: Buffer): Promise<InspectionResult> {
  try {
    const thumbnail = await sharp(buffer)
      // rotate() without arguments applies EXIF orientation so the thumbnail
      // matches what the operator sees.
      .rotate()
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer()
    return { ok: true, pageCount: 1, thumbnail }
  } catch {
    return {
      ok: false,
      code: 'corrupted_image',
      reason: 'Image is corrupted and cannot be read',
    }
  }
}
