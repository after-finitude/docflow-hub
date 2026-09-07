import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const CONTEXT = Buffer.from('docflow-integration-secret:v1')
const envelopeSchema = z
  .object({
    version: z.literal(1),
    iv: z.string().base64(),
    tag: z.string().base64(),
    ciphertext: z.string().base64(),
  })
  .strict()

/** AES-GCM authenticates the envelope; the 32-byte key is supplied separately. */
export function encryptIntegrationSecret(plaintext: Buffer, key: Buffer): string {
  if (key.length !== 32 || plaintext.length === 0)
    throw new Error('Expected a 32-byte key and nonempty secret')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(CONTEXT)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return (
    JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }) + '\n'
  )
}

/** Decrypt only in memory. Never fall back to reading a plaintext credential. */
export function readIntegrationSecret(file: string, keyFile: string): string {
  try {
    const key = readFileSync(keyFile)
    const bytes = readFileSync(file)
    if (key.length !== 32 || bytes.length > 1024 * 1024) throw new Error()
    const envelope = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')))
    const iv = Buffer.from(envelope.iv, 'base64'),
      tag = Buffer.from(envelope.tag, 'base64')
    if (iv.length !== 12 || tag.length !== 16) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(CONTEXT)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    if (!plaintext.trim()) throw new Error()
    return plaintext
  } catch {
    throw new Error(
      'Cannot decrypt integration secret; check its envelope and separate runtime key',
    )
  }
}

export function readGoogleCredentials(file: string, keyFile: string) {
  try {
    return z
      .object({
        type: z.literal('service_account'),
        project_id: z.string().min(1),
        client_email: z.email(),
        private_key: z.string().min(1),
      })
      .parse(JSON.parse(readIntegrationSecret(file, keyFile)))
  } catch {
    throw new Error('Cannot load encrypted Google service-account credentials')
  }
}
