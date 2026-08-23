import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const PREFIX = 'scrypt'
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/** Cost parameters stored in the hash string; see formatHash. */
const DEFAULT_PARAMS = { N: 16_384, r: 8, p: 1 } as const

function derive(password: string, salt: Buffer, params: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Default maxmem is 32 MB; allow headroom above 128 * N * r for future N increases.
    scrypt(password, salt, KEY_LENGTH, { ...params, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

/**
 * Storage format: scrypt$N$r$p$<salt base64>$<key base64>. Embedded cost
 * parameters can increase later without invalidating stored passwords.
 */
export async function hashPassword(plain: string): Promise<string> {
  const { N, r, p } = DEFAULT_PARAMS
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(plain, salt, { N, r, p })
  return [PREFIX, N, r, p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== PREFIX) return false

  const [, rawN, rawR, rawP, saltPart, keyPart] = parts
  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  const expected = Buffer.from(keyPart, 'base64')
  if (expected.length !== KEY_LENGTH) return false

  const actual = await derive(plain, Buffer.from(saltPart, 'base64'), { N, r, p })
  return timingSafeEqual(actual, expected)
}
