import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { encryptIntegrationSecret } from '../packages/core/dist/config/integration-secrets.js'

const [command, keyFile, output] = process.argv.slice(2)
if (command === 'keygen' && keyFile && !output) {
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
} else if (command === 'encrypt' && keyFile && output) {
  // Read plaintext from stdin, never command arguments or an output file.
  writeFileSync(output, encryptIntegrationSecret(readFileSync(0), readFileSync(keyFile)), {
    mode: 0o600,
    flag: 'wx',
  })
} else {
  throw new Error('Usage: integration-secret.mjs keygen KEY | encrypt KEY OUTPUT < SECRET')
}
