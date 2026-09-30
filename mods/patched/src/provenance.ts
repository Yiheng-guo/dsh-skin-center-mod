/**
 * Official-market provenance verification (issue #1073).
 *
 * Skins installed one-click from the DSH Market carry a
 * dsh-market.provenance.json written by the market installer at install
 * time, pinning every installed file to its sha256 and to the market
 * origin. The market's skin content is built from THIS repository (same
 * review, same release), so when the on-disk skin.json and hooks entry
 * hash-match the provenance, the hooks bytes are exactly the reviewed
 * bytes and may run like a built-in skin's.
 *
 * Fail-closed: invalid provenance and any post-install byte mismatch keep the
 * hooks-refused behavior for user-directory skins. A pre-provenance install
 * recovers only by matching this release's generated reviewed identity. The
 * repair path records the origin it actually copied from: only the market
 * origin grants hook trust, so a copy taken from the package's own bundled
 * skins/ tree is integrity-verifiable but never market-provenanced.
 * Forging the provenance
 * requires write access to $DSH_HOME itself — an attacker with that access
 * can already install full plugins, so the file is a provenance record,
 * not a capability guard against the local user.
 * @module @linxin666/dsh-client-ui-skin-center/provenance
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, opendirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'

import { REVIEWED_SKIN_HOOKS } from './reviewed-hooks.generated.ts'

/** Provenance filename written by the market installer (mirrors PROVENANCE_FILENAME in @linxin666/dsh-client-ui-market; no cross-package runtime import). */
export const MARKET_PROVENANCE_FILENAME = 'dsh-market.provenance.json'

/** Market origin the provenance must pin (mirrors MARKET_ORIGIN in @linxin666/dsh-client-ui-market). */
export const MARKET_PROVENANCE_SOURCE = 'https://dsh-market.com'

/**
 * Origin recorded by this package's own repair path when it copies bytes
 * from a local source (the bundled skins/ tree or an explicit
 * localSourceDir) instead of downloading them from the market. It is
 * deliberately NOT the market origin: those bytes never passed through the
 * market, and market provenance is what makes a user-directory skin's hooks
 * executable. The document stays structurally valid so integrity
 * verification can still pin the copied bytes to their sha256, but the
 * market-only trust gate refuses it.
 */
export const LOCAL_PROVENANCE_SOURCE = 'local'

/** Hash-record source values verifySkinIntegrity accepts as a valid provenance document. */
const VERIFIABLE_PROVENANCE_SOURCES: readonly string[] = [MARKET_PROVENANCE_SOURCE, LOCAL_PROVENANCE_SOURCE]

function sha256Hex(abs: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

/** Parsed provenance document: which origin minted it and its per-file hashes. */
interface ParsedProvenance {
  source: string
  files: Record<string, unknown>
}

interface ProvenanceCheck {
  failure: 'tampered' | 'missing-files' | null
  mismatches: string[]
  missing: string[]
  totalFilesChecked: number
}

/**
 * Parse one provenance document and re-hash every recorded file. Null when
 * the document is absent, malformed, the origin is unknown, or the id does
 * not match; otherwise the source (market or local) plus the recorded files.
 */
function parseProvenance(dir: string, skinId: string): ParsedProvenance | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, MARKET_PROVENANCE_FILENAME), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const prov = raw as Record<string, unknown>
  if (prov.version !== 1) return null
  if (typeof prov.source !== 'string' || !VERIFIABLE_PROVENANCE_SOURCES.includes(prov.source)) return null
  if (prov.id !== skinId) return null
  const files = prov.files
  if (typeof files !== 'object' || files === null) return null
  return { source: prov.source, files: files as Record<string, unknown> }
}

/**
 * Re-hash the recorded files against the current bytes: which files are
 * missing or mismatched, plus how many entries were actually checked.
 */
function checkProvenanceFiles(dir: string, files: Record<string, unknown>): ProvenanceCheck {
  const mismatches: string[] = []
  const missing: string[] = []
  let totalFilesChecked = 0
  for (const [rel, expected] of Object.entries(files)) {
    if (typeof expected !== 'string') continue
    totalFilesChecked++
    const actual = sha256Hex(join(dir, ...rel.split('/')))
    if (actual === null) {
      missing.push(rel)
    } else if (actual !== expected) {
      mismatches.push(rel)
    }
  }
  if (missing.length > 0) return { failure: 'missing-files', mismatches, missing, totalFilesChecked }
  if (mismatches.length > 0) return { failure: 'tampered', mismatches, missing, totalFilesChecked }
  return { failure: null, mismatches: [], missing: [], totalFilesChecked }
}

/**
 * Whether the skin directory at dir carries valid official-market
 * provenance for skinId whose declared hooks entry (already validated as a
 * safe relative path by the manifest validator) hash-matches the recorded
 * bytes — skin.json included, so the facet entry path itself is pinned.
 * Only the market origin passes: local-origin provenance never grants hook
 * trust.
 */
export function verifyMarketProvenance(dir: string, skinId: string, hooksEntry: string): boolean {
  const prov = parseProvenance(dir, skinId)
  if (prov === null || prov.source !== MARKET_PROVENANCE_SOURCE) return false
  for (const rel of ['skin.json', hooksEntry]) {
    const expected = prov.files[rel]
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return false
    const actual = sha256Hex(join(dir, ...rel.split('/')))
    if (actual === null || actual !== expected) return false
  }
  return true
}

/**
 * Recover a pre-provenance Workshop install only when its executable identity
 * is byte-for-byte one of this release's reviewed market skins. This is a
 * read-only fallback: no provenance is minted and no user file is replaced.
 */
export function verifyReviewedLegacyHooks(dir: string, skinId: string, hooksEntry: string): boolean {
  const reviewed = REVIEWED_SKIN_HOOKS[skinId]
  if (reviewed === undefined || reviewed.entry !== hooksEntry) return false
  const manifestHash = sha256Hex(join(dir, 'skin.json'))
  const hooksHash = sha256Hex(join(dir, ...hooksEntry.split('/')))
  return manifestHash === reviewed.manifestSha256 && hooksHash === reviewed.hooksSha256
}

export interface SkinIntegrityReport {
  id: string
  status: 'valid' | 'tampered' | 'missing-files' | 'missing-provenance' | 'unverified'
  hooksTrusted: boolean
  hasProvenance: boolean
  mismatches: string[]
  missing: string[]
  totalFilesChecked: number
}

/**
 * Deep integrity verification of one skin directory: checks all files declared
 * in dsh-market.provenance.json against recorded sha256 hashes for either
 * verifiable origin (the market installer's, or this package's own local
 * repair), or verifies against the reviewed legacy registry when provenance is
 * absent. hooksTrusted is granted only by market-origin provenance, by the
 * reviewed legacy identity, or by built-in origin.
 */
export function verifySkinIntegrity(
  dir: string,
  skinId: string,
  options: { isBuiltin?: boolean; hooksEntry?: string | null } = {},
): SkinIntegrityReport {
  if (options.isBuiltin) {
    return {
      id: skinId,
      status: 'valid',
      hooksTrusted: true,
      hasProvenance: false,
      mismatches: [],
      missing: [],
      totalFilesChecked: 0,
    }
  }

  const prov = parseProvenance(dir, skinId)
  if (prov !== null) {
    const checked = checkProvenanceFiles(dir, prov.files)
    if (checked.failure !== null) {
      return {
        id: skinId,
        status: checked.failure,
        hooksTrusted: false,
        hasProvenance: true,
        mismatches: checked.mismatches,
        missing: checked.missing,
        totalFilesChecked: checked.totalFilesChecked,
      }
    }
    return {
      id: skinId,
      status: 'valid',
      // Only the market origin's byte-pinned provenance makes hooks
      // executable; a local-origin document (this package's own local
      // repair) is integrity-valid but never a trust grant.
      hooksTrusted: prov.source === MARKET_PROVENANCE_SOURCE,
      hasProvenance: true,
      mismatches: [],
      missing: [],
      totalFilesChecked: checked.totalFilesChecked,
    }
  }

  // No valid provenance file
  const hooksEntry = options.hooksEntry
  if (hooksEntry) {
    const legacyTrusted = verifyReviewedLegacyHooks(dir, skinId, hooksEntry)
    if (legacyTrusted) {
      return {
        id: skinId,
        status: 'valid',
        hooksTrusted: true,
        hasProvenance: false,
        mismatches: [],
        missing: [],
        totalFilesChecked: 2,
      }
    }
    return {
      id: skinId,
      status: 'missing-provenance',
      hooksTrusted: false,
      hasProvenance: false,
      mismatches: [],
      missing: [],
      totalFilesChecked: 0,
    }
  }

  return {
    id: skinId,
    status: 'unverified',
    hooksTrusted: false,
    hasProvenance: false,
    mismatches: [],
    missing: [],
    totalFilesChecked: 0,
  }
}

const SAFE_REL_RE = /^[A-Za-z0-9._][A-Za-z0-9._\-/]{0,199}$/

function isSafeRel(rel: string): boolean {
  if (typeof rel !== 'string' || !SAFE_REL_RE.test(rel)) return false
  if (rel.includes('..') || rel.includes('//') || rel.startsWith('/') || rel.endsWith('/')) return false
  return true
}

function collectLocalFiles(dir: string, base: string = ''): string[] {
  const list: string[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === MARKET_PROVENANCE_FILENAME) continue
    const abs = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    const st = statSync(abs)
    if (st.isDirectory()) {
      list.push(...collectLocalFiles(abs, rel))
    } else if (st.isFile()) {
      list.push(rel)
    }
  }
  return list
}

export interface SkinRepairOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  localSourceDir?: string
}

export interface SkinRepairResult {
  ok: boolean
  id: string
  error?: string
  repairedFiles?: number
}

/** Marker separating a target path from this module's repair temp-dir suffix. */
const REPAIR_TEMP_INFIX = '.repair-'

/** mkdtempSync suffix shape (6 random characters) used by active-state's atomic write. */
const TEMP_NAME_TAIL_RE = /^[A-Za-z0-9]{6}$/

/** Repair temp directories older than an hour are abandoned: every repair either
 * renames its temp dir into place or sweeps it within seconds, so nothing can
 * legitimately own a matching directory that old. */
const STALE_TEMP_AGE_MS = 60 * 60 * 1000

/** Minimum interval between sweeps of the same directory. Sweeping on every
 * write would add an uncached directory listing to the per-request
 * active-state write for no benefit: anything the listing could find was
 * already older than STALE_TEMP_AGE_MS, so at most one sweep per interval is
 * enough to bound the leak. */
const TEMP_SWEEP_INTERVAL_MS = 60 * 1000

/** Last sweep time per directory (bounded implicitly by process lifetime). */
const lastSweepAt = new Map<string, number>()

/**
 * Stale temp-directory names this package leaves next to a target *if the
 * process dies mid-write*. A crash skips both modules' finally blocks, so the
 * next write to the same directory sweeps this module's own leftovers.
 *
 * Names must match exactly: this module mints "<target>.repair-<base36>-<6
 * chars>" (see repairSkinFromMarket), active-state mints
 * "<target>.tmp-<6 chars>" via mkdtempSync. Matching requires a directory
 * entry, so a file or symlink is never touched.
 */
export interface TempDirSweepPattern {
  prefix: string
  tail: (name: string) => boolean
}

/** Pattern for this module's repair temp directories (market repair path). */
export function repairTempSweepPattern(destDir: string): TempDirSweepPattern {
  const prefix = basename(destDir) + REPAIR_TEMP_INFIX
  return {
    prefix,
    tail: (name) => {
      const parts = name.slice(prefix.length).split('-')
      return parts.length === 2 && /^[a-z0-9]+$/.test(parts[0] ?? '') && TEMP_NAME_TAIL_RE.test(parts[1] ?? '')
    },
  }
}

/** Pattern for active-state.ts's atomic-write temp directories. */
export function activeStateTempSweepPattern(targetPath: string): TempDirSweepPattern {
  const prefix = basename(targetPath) + '.tmp-'
  return { prefix, tail: (name) => TEMP_NAME_TAIL_RE.test(name.slice(prefix.length)) }
}

/**
 * Best-effort sweep of stale sibling temp directories in `dir` that match
 * `pattern` exactly. Never throws, never recurses, never deletes anything that
 * does not match, never deletes a directory younger than STALE_TEMP_AGE_MS,
 * and is safe to call while minting a fresh temp dir because a directory this
 * call just created cannot be an hour old. `exclude` protects the caller's
 * current temp dir explicitly. Repeated calls for the same directory are
 * throttled to TEMP_SWEEP_INTERVAL_MS so this never becomes the hot path.
 */
export function sweepStaleTempDirs(
  dir: string,
  pattern: TempDirSweepPattern,
  exclude: string | null = null,
): void {
  const now = Date.now()
  const previous = lastSweepAt.get(dir)
  if (previous !== undefined && now - previous < TEMP_SWEEP_INTERVAL_MS) return
  lastSweepAt.set(dir, now)
  let handle: ReturnType<typeof opendirSync>
  try {
    handle = opendirSync(dir)
  } catch {
    return
  }
  try {
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      const name = entry.name
      if (!name.startsWith(pattern.prefix) || !pattern.tail(name)) continue
      const abs = join(dir, name)
      if (abs === exclude) continue
      try {
        if (!entry.isDirectory()) continue
        const st = statSync(abs)
        if (now - st.mtimeMs < STALE_TEMP_AGE_MS) continue
        rmSync(abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch { /* best effort: a concurrent writer or a transient fs error must never break the write */ }
    }
  } finally {
    try {
      handle.closeSync()
    } catch { /* best effort */ }
  }
}

/** Filesystem errors that a later rename retry can clear (Windows indexer/AV
 * holds the freshly removed target's entry briefly). Everything else is a real
 * failure and is rethrown immediately. */
const TRANSIENT_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code)
}

/** Awaitable timer; the non-blocking replacement for a spin loop. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RenameRetryOptions {
  sleep?: (ms: number) => Promise<void>
  /** Total awaited-backoff budget. */
  totalMs?: number
  baseDelayMs?: number
  /** Injectable rename (tests); defaults to node:fs renameSync. */
  rename?: (src: string, dest: string) => void
}

/**
 * Rename src onto dest, retrying transient failures with an awaited backoff.
 *
 * repairSkinFromMarket must replace an existing destination, so it removes
 * dest and then renames; on Windows the removal can still be settling when the
 * rename runs, which surfaces as EBUSY/EPERM and clears within milliseconds.
 * The retry waits on a timer instead of spinning: a synchronous spin blocks
 * the event loop (this runs inside the host's HTTP request handling) and gives
 * the filesystem no more time than the loop's duration. Non-transient errors
 * fail fast, and exhausting the budget rethrows the last transient error so a
 * persistent failure still cleans up the temp dir and reports an error.
 */
export async function renameWithRetry(src: string, dest: string, options: RenameRetryOptions = {}): Promise<void> {
  const sleep = options.sleep ?? defaultSleep
  const rename = options.rename ?? renameSync
  const totalMs = options.totalMs ?? 1_000
  const baseDelayMs = options.baseDelayMs ?? 10
  const deadline = Date.now() + totalMs
  let delay = baseDelayMs
  for (;;) {
    try {
      rename(src, dest)
      return
    } catch (err) {
      if (!isTransientRenameError(err) || Date.now() + delay > deadline) throw err
      await sleep(delay)
      delay *= 2
    }
  }
}

/**
 * Repairs a corrupted or tampered skin directory by copying pristine files
 * from the local source tree or downloading them from the official DSH Market
 * and rewriting provenance. The rewritten document names the origin the bytes
 * actually came from: the market path records the market origin (the only
 * origin that later makes a user skin's hooks executable), while the local
 * path records LOCAL_PROVENANCE_SOURCE because bundled or explicitly supplied
 * bytes never passed through the market.
 */
export async function repairSkinFromMarket(
  destDir: string,
  skinId: string,
  options: SkinRepairOptions = {},
): Promise<SkinRepairResult> {
  if (!skinId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(skinId)) {
    return { ok: false, id: skinId, error: 'invalid-id' }
  }

  // 1. Check local source mirror if available
  const localDir = options.localSourceDir
    ?? (existsSync(join(import.meta.dirname, '..', 'skins', skinId, 'skin.json'))
      ? join(import.meta.dirname, '..', 'skins', skinId)
      : null)

  if (localDir && existsSync(join(localDir, 'skin.json'))) {
    const files = collectLocalFiles(localDir)
    if (files.length > 0) {
      const hashes: Record<string, string> = {}
      mkdirSync(destDir, { recursive: true })
      // Crash debris from an earlier repair of this same skin is swept before
      // a new provenance document is minted.
      sweepStaleTempDirs(dirname(destDir), repairTempSweepPattern(destDir))
      for (const rel of files) {
        const src = join(localDir, ...rel.split('/'))
        const target = join(destDir, ...rel.split('/'))
        const guard = rel.split('/').slice(0, -1).join(sep)
        if (guard) mkdirSync(join(destDir, guard), { recursive: true })
        cpSync(src, target, { force: true })
        const h = sha256Hex(target)
        if (h) hashes[rel] = h
      }
      const provenance = {
        version: 1,
        // Truthful origin: these bytes were copied from a local source, so
        // they carry no market review claim and the hooks trust gate refuses
        // them (see verifySkinIntegrity and verifyMarketProvenance).
        source: LOCAL_PROVENANCE_SOURCE,
        kind: 'skin',
        id: skinId,
        installedAt: new Date().toISOString(),
        files: hashes,
      }
      writeFileSync(join(destDir, MARKET_PROVENANCE_FILENAME), JSON.stringify(provenance, null, 2) + '\n')
      return { ok: true, id: skinId, repairedFiles: files.length }
    }
  }

  // 2. Fetch from market
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  try {
    const manifestUrl = `${MARKET_PROVENANCE_SOURCE}/manifest/skins.json`
    const res = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      return { ok: false, id: skinId, error: `manifest-fetch-failed: ${res.status}` }
    }
    const manifest = (await res.json()) as { items?: Array<{ id: string; files?: string[] }> }
    const item = manifest?.items?.find((it) => it.id === skinId)
    if (!item || !Array.isArray(item.files) || item.files.length === 0) {
      return { ok: false, id: skinId, error: 'skin-not-found-on-market' }
    }

    const tmp = destDir + REPAIR_TEMP_INFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    mkdirSync(tmp, { recursive: true })
    // The fresh temp dir is explicitly excluded: it can never be stale, and a
    // concurrent writer's directory is protected by the age threshold.
    sweepStaleTempDirs(dirname(destDir), repairTempSweepPattern(destDir), tmp)
    const hashes: Record<string, string> = {}

    try {
      for (const rel of item.files) {
        if (!isSafeRel(rel)) {
          throw new Error(`unsafe manifest path: ${rel}`)
        }
        const fileUrl = `${MARKET_PROVENANCE_SOURCE}/assets/skins/${encodeURIComponent(skinId)}/${rel.split('/').map(encodeURIComponent).join('/')}`
        const fileRes = await fetchImpl(fileUrl, { signal: AbortSignal.timeout(timeoutMs) })
        if (!fileRes.ok) {
          throw new Error(`failed to download ${rel}: ${fileRes.status}`)
        }
        const buf = Buffer.from(await fileRes.arrayBuffer())
        const target = join(tmp, ...rel.split('/'))
        const guard = rel.split('/').slice(0, -1).join(sep)
        if (guard) mkdirSync(join(tmp, guard), { recursive: true })
        writeFileSync(target, buf)
        hashes[rel] = createHash('sha256').update(buf).digest('hex')
      }

      const provenance = {
        version: 1,
        source: MARKET_PROVENANCE_SOURCE,
        kind: 'skin',
        id: skinId,
        installedAt: new Date().toISOString(),
        files: hashes,
      }
      writeFileSync(join(tmp, MARKET_PROVENANCE_FILENAME), JSON.stringify(provenance, null, 2) + '\n')

      if (existsSync(destDir)) {
        rmSync(destDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      }
      // Awaited retry instead of a synchronous spin: the spin froze the whole
      // host event loop for up to 50 ms while waiting for the just-removed
      // destination's directory entry to settle before the rename.
      await renameWithRetry(tmp, destDir)
      return { ok: true, id: skinId, repairedFiles: item.files.length }
    } finally {
      try {
        if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } catch { /* best effort */ }
    }
  } catch (err) {
    return { ok: false, id: skinId, error: err instanceof Error ? err.message : String(err) }
  }
}
