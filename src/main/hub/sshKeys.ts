/*
 * Stoke Hub's SSH key transfer on this machine's disk (spec §5.4): listing the
 * key pairs in `~/.ssh` for the picker, reading ONE private key when the owner
 * picks it, and writing a received one without ever replacing anything.
 *
 * The rules are pure and live in `src/shared/hub/` (`sshKeyInstallPlan`,
 * `sshKeyTarget`, `isSafeSshKeyName`); this is the part that touches files:
 *
 * - The picker lists a key by its `.pub` beside it: the private file is only
 *   stat'ed, never read, until the owner shares that key.
 * - A received key is written with the exclusive flag (`wx`), 0600 (the `.pub`
 *   0644) into `~/.ssh` (made 0700 if missing), never renamed over a name, so
 *   a file that appeared since the probe makes the write fail, not replace it.
 * - An `IdentityFile` line is APPENDED for each host that uses the key —
 *   `buildIdentityBlock` + `appendToSshConfig`, the rules `saveKeyLocally`
 *   follows (append-only, `config.stoke.bak`) — and re-checked with `ssh -G`.
 *
 * Every path is injectable (`SshPaths`) so a suite and a sandbox never touch
 * the real `~/.ssh` (gotcha 74). `ssh -G` reads the config at the passwd home,
 * not `$HOME` (ssh.md, gotcha 126's note), so when the config written here is
 * not that one, the check names it with `-F`.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { hostsUsingKey, parsePublicKeyLine, sshKeyInstallPlan } from '../../shared/hub/client.ts'
import { isSafeSshKeyName, type SshKeyPayload, type SyncableHost } from '../../shared/hub/settings.ts'
import { buildIdentityBlock, identityFilesFromSshG, sshChildEnv, sshExecutable } from '../ssh.ts'
import { appendToSshConfig, type ExecRun } from '../sshEnroll.ts'

export interface SshPaths {
  /** `~/.ssh`. */
  dir: string
  /** `~/.ssh/config`. */
  config: string
  /** For `~` in `ssh -G`'s output. */
  home: string
}

export function defaultSshPaths(): SshPaths {
  const home = homedir()
  return { dir: join(home, '.ssh'), config: join(home, '.ssh', 'config'), home }
}

/** A key pair the picker can offer: what the `.pub` says. The private key is not read. */
export interface LocalKeyPair {
  name: string
  type: string
  comment: string
  fingerprint: string
  publicKey: string
}

/** OpenSSH's own fingerprint: `SHA256:` + unpadded base64 of the SHA-256 of the key blob. */
export function sshFingerprint(blobBase64: string): string {
  return `SHA256:${createHash('sha256').update(Buffer.from(blobBase64, 'base64')).digest('base64').replace(/=+$/, '')}`
}

/** Files larger than this are not keys; the picker skips them unread. */
const MAX_KEY_FILE_BYTES = 16 * 1024

/** Every `<name>` in `dir` with a `<name>.pub` beside it that parses, the private file present. */
export async function listKeyPairs(dir: string): Promise<LocalKeyPair[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const have = new Set(names)
  const out: LocalKeyPair[] = []
  for (const pub of names.filter((n) => n.endsWith('.pub')).sort()) {
    const name = pub.slice(0, -4)
    if (!have.has(name) || !isSafeSshKeyName(name)) continue
    try {
      const [pubInfo, privInfo] = await Promise.all([stat(join(dir, pub)), stat(join(dir, name))])
      if (!pubInfo.isFile() || !privInfo.isFile() || pubInfo.size > MAX_KEY_FILE_BYTES || privInfo.size > MAX_KEY_FILE_BYTES) continue
      const line = parsePublicKeyLine(await readFile(join(dir, pub), 'utf8'))
      if (!line) continue
      out.push({ name, type: line.type, comment: line.comment, fingerprint: sshFingerprint(line.blob), publicKey: `${line.type} ${line.blob}${line.comment ? ` ${line.comment}` : ''}` })
    } catch {
      /* unreadable: not offered */
    }
  }
  return out
}

/**
 * Whether a private key is itself passphrase-protected. OpenSSH's own format
 * names its cipher right after the magic (`none` when unencrypted); PEM says
 * `Proc-Type: 4,ENCRYPTED`, PKCS#8 `ENCRYPTED PRIVATE KEY`.
 */
export function privateKeyHasPassphrase(text: string): boolean {
  if (/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(text) || /Proc-Type:\s*4,ENCRYPTED/.test(text)) return true
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(text)
  if (!m) return false
  const bytes = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
  const magic = 'openssh-key-v1\0'
  if (bytes.subarray(0, magic.length).toString('latin1') !== magic) return false
  const len = bytes.readUInt32BE(magic.length)
  return bytes.subarray(magic.length + 4, magic.length + 4 + len).toString('latin1') !== 'none'
}

/** The payload for one picked key: its private file read now, as is, and its `.pub`. */
export async function readKeyForShare(dir: string, name: string): Promise<SshKeyPayload | { error: string }> {
  if (!isSafeSshKeyName(name)) return { error: 'That is not a key file Stoke will read.' }
  const pair = (await listKeyPairs(dir)).find((k) => k.name === name)
  if (!pair) return { error: `${name} is not a key pair in ${dir} any more.` }
  let privateKey: string
  try {
    privateKey = await readFile(join(dir, name), 'utf8')
  } catch (err) {
    return { error: `Could not read ${name}: ${(err as Error).message}` }
  }
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) return { error: `${name} is not a private key file Stoke recognises.` }
  return { name, privateKey, publicKey: pair.publicKey, comment: pair.comment, fingerprint: pair.fingerprint, passphrase: privateKeyHasPassphrase(privateKey) }
}

const normalizeKey = (t: string): string => t.replace(/\r\n/g, '\n').trimEnd()

/**
 * `sshKeyInstallPlan` against the disk: the candidate names are read before
 * the plan is made (async, gotcha 40), so the probe itself is a lookup.
 */
export async function planInstall(dir: string, payload: SshKeyPayload): Promise<ReturnType<typeof sshKeyInstallPlan>> {
  let names: Set<string>
  try {
    names = new Set(await readdir(dir))
  } catch {
    names = new Set()
  }
  const contents = new Map<string, string | null>()
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? payload.name : `${payload.name}-stoke-${n}`
    if (!names.has(name)) continue
    try {
      contents.set(name, await readFile(join(dir, name), 'utf8'))
    } catch {
      contents.set(name, null)
    }
  }
  return sshKeyInstallPlan(payload, (name) => {
    if (!names.has(name) && !names.has(`${name}.pub`)) return 'free'
    const text = contents.get(name)
    return typeof text === 'string' && normalizeKey(text) === normalizeKey(payload.privateKey) ? 'same' : 'different'
  })
}

export interface InstallResult {
  ok: boolean
  /** The file name in `dir` the key is at, when it is there. */
  name: string | null
  wrote: boolean
  /** Aliases an `IdentityFile` line was added (or already present) for. */
  hosts: string[]
  message: string
}

/** `ssh -G` only, so `sshChildEnv` (gotcha 153). */
function defaultExec(file: string, args: string[], timeoutMs: number): ReturnType<ExecRun> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: sshChildEnv() }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '', error: err ? err.message : null })
    })
  })
}

/**
 * The identity files plain `ssh <alias>` would offer, reading `config`. When
 * `config` is not the file ssh reads by itself (the passwd home's), `-F`
 * names it — a sandbox with a scratch HOME must never be answered from the
 * real `~/.ssh/config`.
 */
export async function identityFilesFor(alias: string, paths: SshPaths, exec: ExecRun = defaultExec): Promise<string[] | null> {
  const own = join(userInfo().homedir, '.ssh', 'config')
  let args = ['-G', alias]
  if (paths.config !== own) {
    let exists = false
    try {
      exists = (await stat(paths.config)).isFile()
    } catch {
      exists = false
    }
    args = ['-F', exists ? paths.config : process.platform === 'win32' ? 'NUL' : '/dev/null', '-G', alias]
  }
  const res = await exec(sshExecutable(), args, 10_000)
  if (!res.ok && !res.stdout) return null
  return identityFilesFromSshG(res.stdout, paths.home)
}

/**
 * Write a received key (never over anything), then make every host that uses
 * it offer it. Returns a result line either way; nothing here is silent.
 */
export async function installReceivedKey(
  paths: SshPaths,
  keyId: string,
  payload: SshKeyPayload,
  hosts: readonly SyncableHost[],
  keyRefs: Record<string, string[]>,
  from: string,
  exec: ExecRun = defaultExec
): Promise<InstallResult> {
  const plan = await planInstall(paths.dir, payload)
  if ('error' in plan) return { ok: false, name: null, wrote: false, hosts: [], message: plan.error }
  const keyPath = join(paths.dir, plan.name)
  if (plan.action === 'write') {
    try {
      await mkdir(paths.dir, { recursive: true, mode: 0o700 })
    } catch (err) {
      return { ok: false, name: null, wrote: false, hosts: [], message: `Could not create ${paths.dir}: ${(err as Error).message}` }
    }
    try {
      await writeFile(keyPath, `${normalizeKey(payload.privateKey)}\n`, { flag: 'wx', mode: 0o600 })
      if (process.platform !== 'win32') await chmod(keyPath, 0o600)
    } catch (err) {
      return { ok: false, name: null, wrote: false, hosts: [], message: `Did not write ${keyPath}: ${(err as Error).message}` }
    }
    try {
      await writeFile(`${keyPath}.pub`, `${payload.publicKey.trim()}\n`, { flag: 'wx', mode: 0o644 })
    } catch (err) {
      // Ours, written a moment ago: take it back rather than leave half a pair.
      await rm(keyPath, { force: true }).catch(() => {})
      return { ok: false, name: null, wrote: false, hosts: [], message: `Did not write ${keyPath}.pub: ${(err as Error).message}` }
    }
  }
  const using = hostsUsingKey(keyId, hosts, keyRefs)
  const done: string[] = []
  const problems: string[] = []
  for (const h of using) {
    const alias = h.alias.trim()
    const before = await identityFilesFor(alias, paths, exec)
    if (before?.includes(keyPath)) {
      done.push(alias)
      continue
    }
    const block = buildIdentityBlock(alias, keyPath)
    if (!block) {
      problems.push(`${alias} (Stoke cannot write a Host line for it safely)`)
      continue
    }
    const hubBlock = block.replace(/^# .*$/m, `# Added by Stoke Hub: a key shared from ${from.replace(/[\r\n]/g, ' ')}, for ${alias}.`)
    try {
      await appendToSshConfig(paths.config, hubBlock)
    } catch (err) {
      problems.push(`${alias} (${(err as Error).message})`)
      continue
    }
    const after = await identityFilesFor(alias, paths, exec)
    if (after?.includes(keyPath)) done.push(alias)
    else problems.push(`${alias} (added to ${paths.config}, but ssh -G still does not list it)`)
  }
  const where = plan.action === 'write' ? `Saved ${plan.name} to ${paths.dir} (owner-only)` : `${plan.name} was already in ${paths.dir}, identical`
  const hostsLine = done.length ? `; ${done.join(', ')} will offer it` : using.length === 0 ? '; no synced host names it yet' : ''
  const problemLine = problems.length ? ` Not set up for: ${problems.join('; ')}.` : ''
  return { ok: problems.length === 0, name: plan.name, wrote: plan.action === 'write', hosts: done, message: `${where}${hostsLine}.${problemLine}` }
}
