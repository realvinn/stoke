/*
 * Print each cookie's name, encrypted_value length and 3-byte tag from a Chrome
 * cookie DB — `v10` means plain DPAPI, `v20` means app-bound encryption. For the
 * record only, in the Windows Chrome-import e2e (.github/workflows/windows.yml):
 * the reader must hand the value back decrypted whichever tag Chrome wrote.
 *
 *   node scripts/probe/cookie-prefix.mjs <path-to-Cookies>
 *
 * Reads a COPY the caller made — never the live file. node:sqlite (node 24).
 */
import { DatabaseSync } from 'node:sqlite'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/probe/cookie-prefix.mjs <Cookies>')
  process.exit(1)
}
const db = new DatabaseSync(file, { readOnly: true })
try {
  const rows = db.prepare('SELECT name, length(encrypted_value) AS n, hex(substr(encrypted_value, 1, 3)) AS p FROM cookies').all()
  for (const r of rows) {
    const tag = r.p ? Buffer.from(String(r.p), 'hex').toString('latin1') : '(none)'
    console.log(`${r.name}\tlen=${r.n}\ttag=${tag}`)
  }
} finally {
  db.close()
}
