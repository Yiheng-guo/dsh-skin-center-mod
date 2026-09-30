/**
 * Skin-center v2 HTTP routes (issue #506, M2) — the loading/serving half of
 * the new architecture. Pure read-only asset serving plus the active-skin
 * selection write; the actual switch happens browser-side (atomic swap, no
 * reload, no cordis.patch.yml rewrite).
 *
 * Endpoints (all under /api/skin-center/v2):
 *  - GET  /catalog                     catalog snapshot (installed skins + diagnostics)
 *  - GET  /skins/<id>/stylesheet       transformed + scoped skin.css
 *  - GET  /skins/<id>/patches          transformed + scoped patches.css (404 when absent)
 *  - GET  /skins/<id>/hooks.mjs        the escape-hatch entry (404 when absent)
 *  - GET  /skins/<id>/assets/<path>    static in-directory assets (incl. preview/)
 *  - GET  /active                      the persisted active skin id + background preferences
 *  - POST /active                      persist active id and/or background (same-origin fenced)
 *  - POST /verify                      integrity report; repairs only on {"autoRepair":true}
 *
 * The stylesheet/patches responses pass through the CSS safety pipeline
 * (force-scoped under html[data-dsh-skin="<id>"], whitelist fail-closed), so
 * the browser can inject them blindly. hooks.mjs is served verbatim — it is
 * trusted, same-review same-release code (high sensitivity, see contracts/),
 * served for built-in skins and for byte-verified official-market user
 * installs, including exact reviewed legacy installs (issue #1073).
 * @module @linxin666/dsh-client-ui-skin-center/routes-v2
 */

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { pipeline } from 'node:stream'

import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import { writeJson, requireSameOrigin } from './http-utils.ts'
import { readJsonBody } from './http.ts'
import { defaultActiveStatePath, readActiveState, writeActiveState } from './active-state.ts'
import { sanitizeSkinBackground, type SkinBackgroundConfig } from './core/background.ts'
import { transformSkinCss, SkinCssSafetyError } from './core/css-safety/transform.ts'
import { canServeSkinHooks, findSkin, loadSkinCatalog, repairSkin, resolveInsideSkin, shippedSkinIds, uninstallUserSkin, verifyAllSkinsIntegrity, verifyAndRepairAllSkins } from './skin-repo.ts'
import { MARKET_PROVENANCE_FILENAME } from './provenance.ts'
import type { SkinCatalog, SkinCatalogEntry } from './skin-repo.ts'

export const SKIN_CENTER_V2_PREFIX = '/api/skin-center/v2'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
}

export interface RoutesV2Deps {
  /** Catalog loader (defaults to the real dual-source scan). */
  loadCatalog?: () => SkinCatalog
  /** Shipped builtin id set (defaults to the package.json files whitelist). */
  shippedSkinIds?: () => Set<string>
  /** Where the active-skin selection persists (defaults under $DSH_HOME). */
  activeStatePath?: string
  /** User skins directory override (tests). */
  userDir?: string
  /** Now function for catalog capture. */
  now?: () => number
  /** fetch implementation override (tests). */
  fetchImpl?: typeof fetch
  /** Local source dir mirror override (tests). */
  localSourceDir?: string
  /** CSS transform override (tests); defaults to the fail-closed pipeline. */
  transformCss?: typeof transformSkinCss
}

/**
 * Bound on the transformed-CSS memo. One entry is one served stylesheet, so
 * the installed-typical ceiling is two per skin (skin.css + patches.css); 64
 * covers 32 installed skins and can never grow with request count. Failures
 * are never stored, so the cap only ever holds successful transforms.
 */
const CSS_TRANSFORM_CACHE_MAX = 64

/** Stat identity a memoized transform is keyed on. */
interface FileIdentity {
  mtimeMs: number
  size: number
}

/**
 * Memoized transform entry point: (skin id, filename, stat identity) ->
 * transformed CSS. It throws exactly what the pipeline throws, and only a
 * successful result is stored — a whitelist violation must be reported on
 * every request, never pinned as a stale success.
 */
type SkinCssMemo = (
  entry: SkinCatalogEntry,
  abs: string,
  filename: string,
  identity: FileIdentity,
) => string

function sendCss(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
  res.end(code)
}

/** Serve one manifest-referenced stylesheet through the safety pipeline. */
function serveStylesheet(
  res: ServerResponse,
  entry: SkinCatalogEntry,
  relPath: string,
  filename: string,
  memoTransform: SkinCssMemo,
): void {
  const abs = resolveInsideSkin(entry, relPath)
  if (!abs || !existsSync(abs)) {
    writeJson(res, 404, { ok: false, error: 'stylesheet-not-found' })
    return
  }
  try {
    const stat = statSync(abs)
    const code = memoTransform(entry, abs, filename, { mtimeMs: stat.mtimeMs, size: stat.size })
    sendCss(res, 200, code)
  } catch (error) {
    if (error instanceof SkinCssSafetyError) {
      writeJson(res, 422, { ok: false, error: 'css-whitelist-violation', violations: error.violations })
      return
    }
    writeJson(res, 500, { ok: false, error: 'css-transform-failed', detail: (error as Error)?.message ?? String(error) })
  }
}

/** HTTP-date at the whole-second precision Last-Modified compares at. */
function httpDate(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / 1000) * 1000).toUTCString()
}

/**
 * Strong validator over the file's stat identity: same mtime and size -> same
 * tag. Size is part of it so an in-place edit that keeps the mtime granularity
 * still invalidates.
 */
function statEtag(identity: FileIdentity): string {
  return `"${Math.floor(identity.mtimeMs).toString(16)}-${identity.size.toString(16)}"`
}

/**
 * Conditional-request verdict. If-None-Match wins over If-Modified-Since
 * (RFC 9110 section 13.1.3): a caller that only carries the date still gets a
 * 304. Both validators are stat-derived, so a mutated file revalidates.
 */
function isNotModified(req: IncomingMessage, etag: string, lastModified: string): boolean {
  const ifNoneMatch = req.headers['if-none-match']
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() !== '') {
    return ifNoneMatch.split(',').some((raw) => {
      const tag = raw.trim()
      return tag === '*' || tag === etag || tag === `W/${etag}` || tag.replace(/^W\//, '') === etag
    })
  }
  const ifModifiedSince = req.headers['if-modified-since']
  if (typeof ifModifiedSince === 'string' && ifModifiedSince.trim() !== '') {
    const since = Date.parse(ifModifiedSince)
    if (!Number.isNaN(since)) return Date.parse(lastModified) <= since
  }
  return false
}

/**
 * Parse one `bytes=` range against the file size. The suffix form
 * `bytes=-N` means the LAST N bytes, not `0..N` — a naive parser turns it
 * into the wrong slice and breaks seeking in strict players. Returns null
 * when the header is absent or is not a single range (RFC 9110 lets the
 * server ignore such a header and answer the full 200), and 'unsatisfiable'
 * for a single range that falls outside the file (416).
 */
function parseSingleRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (suffixLength === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (size === 0 || start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/**
 * Stream one file (optionally one byte range) while coupling the descriptor's
 * lifetime to the response, mirroring we-routes.ts: a client that seeks away
 * mid-body must not leave the host holding sockets and descriptors.
 */
function pipeFile(absPath: string, res: ServerResponse, range?: { start: number; end: number }): void {
  if (res.destroyed || res.writableEnded) return
  const source = range ? createReadStream(absPath, range) : createReadStream(absPath)
  const closeSource = (): void => {
    source.destroy()
  }
  res.once('close', closeSource)
  if (res.destroyed || res.writableEnded) {
    res.off('close', closeSource)
    source.destroy()
    return
  }
  try {
    pipeline(source, res, () => {
      res.off('close', closeSource)
      // The callback consumes read and premature-close errors.
    })
  } catch {
    res.off('close', closeSource)
    source.destroy()
  }
}

/**
 * Serve one static file from inside the skin directory (fail-closed). Assets
 * are stat-validated and range-capable: `cache-control: no-store` made the
 * browser re-download a multi-megabyte background video on every render and
 * refresh, and a full buffer per request held a copy in the host. `no-cache`
 * keeps the file storable but revalidated, so an unchanged asset costs one
 * 304 with no body, and a changed one re-fetches.
 */
function serveAsset(req: IncomingMessage, res: ServerResponse, entry: SkinCatalogEntry, relPath: string): void {
  const abs = resolveInsideSkin(entry, relPath)
  // One stat drives both the fail-closed existence check and the validator, so
  // a request never pays for the file twice.
  let stat: Stats | undefined
  if (abs) {
    try {
      stat = statSync(abs)
    } catch {
      stat = undefined
    }
  }
  if (!abs || stat === undefined || !stat.isFile()) {
    writeJson(res, 404, { ok: false, error: 'asset-not-found' })
    return
  }
  const size = stat.size
  const etag = statEtag({ mtimeMs: stat.mtimeMs, size })
  const lastModified = httpDate(stat.mtimeMs)
  const validators: Record<string, string> = {
    'cache-control': 'no-cache',
    etag,
    'last-modified': lastModified,
    'accept-ranges': 'bytes',
  }
  const mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
  if (isNotModified(req, etag, lastModified)) {
    res.writeHead(304, validators)
    res.end()
    return
  }
  const range = parseSingleRange(req.headers.range, size)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...validators, 'content-range': `bytes */${size}` })
    res.end()
    return
  }
  if (range !== null) {
    res.writeHead(206, {
      ...validators,
      'content-type': mime,
      'content-range': `bytes ${range.start}-${range.end}/${size}`,
      'content-length': range.end - range.start + 1,
    })
    pipeFile(abs, res, range)
    return
  }
  res.writeHead(200, { ...validators, 'content-type': mime, 'content-length': size })
  pipeFile(abs, res)
}

/**
 * Build the v2 route set. Registration is the caller's job (the host entry
 * keeps the mount-once discipline).
 */
export function makeSkinCenterV2Routes(deps: RoutesV2Deps = {}): WebRoute[] {
  const loadCatalog = deps.loadCatalog ?? (() => loadSkinCatalog())
  const activeStatePath = deps.activeStatePath ?? defaultActiveStatePath()
  // Installed-only catalog (market/store separation): user dirs are always
  // installed, builtins only when the package ships them (files whitelist).
  const shippedSet = (deps.shippedSkinIds ?? shippedSkinIds)()
  const transformCss = deps.transformCss ?? transformSkinCss

  /**
   * Transformed-CSS memo: (skin id, filename, mtimeMs, size) -> code. The
   * transform is a pure function of those four values (filename selects
   * deriveFallbacks), yet it re-parsed the entire stylesheet with lightningcss
   * on every request. A Map with insertion-order eviction is the LRU here: a
   * hit is re-inserted, so the first key is the least recently served one and
   * eviction needs no list. The hard cap bounds the process at one string per
   * installed stylesheet (see CSS_TRANSFORM_CACHE_MAX) no matter how many
   * temp skins churn through. Successful transforms only: a whitelist
   * violation is re-derived and re-reported, never cached as success.
   */
  const cssCache = new Map<string, string>()
  const memoTransform: SkinCssMemo = (entry, abs, filename, identity) => {
    const key = `${entry.manifest.id}\u0000${filename}\u0000${identity.mtimeMs}\u0000${identity.size}`
    const hit = cssCache.get(key)
    if (hit !== undefined) {
      cssCache.delete(key)
      cssCache.set(key, hit)
      return hit
    }
    // Warnings are diagnostic surface (catalog/CLI), not transport: HTTP
    // headers reject non-Latin1 bytes and skin warnings can embed selector
    // fragments with CJK text.
    const { code } = transformCss(readFileSync(abs, 'utf8'), {
      skinId: entry.manifest.id,
      filename,
      // Only the main stylesheet derives fallback tints; patches re-deriving
      // from their partial token view would override the skin's real values.
      deriveFallbacks: filename === 'skin.css',
    })
    cssCache.set(key, code)
    if (cssCache.size > CSS_TRANSFORM_CACHE_MAX) {
      const oldest = cssCache.keys().next().value
      if (oldest !== undefined) cssCache.delete(oldest)
    }
    return code
  }

  const catalogHandler: WebRoute['handler'] = (_req, res) => {
    const catalog = loadCatalog()
    writeJson(res, 200, {
      ok: true,
      capturedAt: catalog.capturedAt,
      skins: catalog.skins
        .filter((s) => s.origin === 'user' || shippedSet.has(s.manifest.id))
        .map((s) => ({
          origin: s.origin,
          warnings: s.warnings,
          manifest: s.manifest,
          // Anonymous install-channel hint for telemetry (docs/telemetry.md):
          // Workshop installs carry a provenance file, registry installs do
          // not. This is a statistical hint only, never a security signal.
          channel: s.origin === 'user'
            ? (existsSync(join(s.dir, MARKET_PROVENANCE_FILENAME)) ? 'market' : 'unknown')
            : 'npm',
        })),
      diagnostics: catalog.diagnostics,
    })
  }

  const verifyHandler: WebRoute['handler'] = async (req, res) => {
    if (!requireSameOrigin(req, res)) return
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    let body: { autoRepair?: boolean } | null = null
    try {
      body = (await readJsonBody(req, { maxBytes: 16 * 1024 })) as { autoRepair?: boolean } | null
    } catch {
      body = null
    }
    // Verification is a read-only report by default: repairing replaces user
    // skin directories with a download from dsh-market.com, so it only happens
    // when the caller explicitly asks for it with {"autoRepair":true}.
    const autoRepair = body?.autoRepair === true
    const result = await verifyAndRepairAllSkins(loadCatalog, {
      userDir: deps.userDir,
      fetchImpl: deps.fetchImpl,
      localSourceDir: deps.localSourceDir,
      autoRepair,
    })
    writeJson(res, 200, { ok: true, ...result })
  }

  const skinPrefix = `${SKIN_CENTER_V2_PREFIX}/skins/`

  const skinsHandler: WebRoute['handler'] = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.slice(skinPrefix.length)
    const [id, ...tail] = rest.split('/')
    const sub = tail.join('/')
    const catalog = loadCatalog()
    const entry = id ? findSkin(catalog, id) : null

    if (sub === 'uninstall') {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!entry) {
        writeJson(res, 404, { ok: false, error: 'skin-not-found' })
        return
      }
      if (entry.origin === 'builtin') {
        writeJson(res, 400, { ok: false, error: 'cannot-uninstall-builtin' })
        return
      }
      const userDir = deps.userDir ?? (entry.dir ? dirname(entry.dir) : undefined)
      const uninstallRes = uninstallUserSkin(id, { userDir })
      if (!uninstallRes.ok) {
        const status = uninstallRes.error === 'skin-not-found' ? 404 : 500
        writeJson(res, status, { ok: false, error: uninstallRes.error, detail: uninstallRes.detail })
        return
      }
      // If the uninstalled skin was active, reset active to null
      const currentActive = readActiveState(activeStatePath).active
      if (currentActive === id) {
        writeActiveState(activeStatePath, { active: null })
      }
      writeJson(res, 200, { ok: true, id })
      return
    }

    if (sub === 'repair') {
      if (!requireSameOrigin(req, res)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!entry) {
        writeJson(res, 404, { ok: false, error: 'skin-not-found' })
        return
      }
      if (entry.origin === 'builtin') {
        writeJson(res, 400, { ok: false, error: 'cannot-repair-builtin' })
        return
      }
      const userDir = deps.userDir ?? (entry.dir ? dirname(entry.dir) : undefined)
      const repairRes = await repairSkin(id, {
        userDir,
        fetchImpl: deps.fetchImpl,
        localSourceDir: deps.localSourceDir,
      })
      writeJson(res, repairRes.ok ? 200 : 500, repairRes)
      return
    }

    if (!entry) {
      writeJson(res, 404, { ok: false, error: 'skin-not-found' })
      return
    }
    if (sub === 'stylesheet') {
      serveStylesheet(res, entry, entry.manifest.contributes.stylesheet, 'skin.css', memoTransform)
      return
    }
    if (sub === 'patches') {
      const patches = entry.manifest.contributes.patches
      if (!patches) {
        writeJson(res, 404, { ok: false, error: 'no-patches' })
        return
      }
      serveStylesheet(res, entry, patches, 'patches.css', memoTransform)
      return
    }
    if (sub === 'hooks.mjs') {
      const facet = entry.manifest.facets?.client
      if (!facet) {
        writeJson(res, 404, { ok: false, error: 'no-hooks' })
        return
      }
      // Trust model (contracts/README.md): hooks are executable same-review
      // content. Re-verify the CURRENT bytes at serve time so a cached catalog
      // snapshot cannot keep serving hooks after post-scan tampering. Current
      // Workshop installs use provenance; exact reviewed pre-provenance
      // installs use the generated legacy identity (issue #1073).
      if (!canServeSkinHooks(entry)) {
        writeJson(res, 403, { ok: false, error: 'hooks-require-review', origin: entry.origin })
        return
      }
      const abs = resolveInsideSkin(entry, facet.entry)
      if (!abs || !existsSync(abs)) {
        writeJson(res, 404, { ok: false, error: 'hooks-not-found' })
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(abs))
      return
    }
    if (sub.startsWith('assets/') || sub.startsWith('preview/')) {
      serveAsset(req, res, entry, sub)
      return
    }
    writeJson(res, 404, { ok: false, error: 'unknown-skin-resource' })
  }

  const activeGetHandler: WebRoute['handler'] = (_req, res) => {
    const state = readActiveState(activeStatePath)
    const catalog = loadCatalog()
    const effectiveActive = state.active !== null && !findSkin(catalog, state.active) ? null : state.active
    writeJson(res, 200, { ok: true, active: effectiveActive, background: state.background })
  }

  // POST accepts { active?, background? } with merge semantics (issue #996):
  // a key left out keeps its stored value, so a remote background write never
  // disturbs the active selection and vice versa.
  const activePostHandler: WebRoute['handler'] = async (req, res) => {
    if (!requireSameOrigin(req, res)) return
    // Shared lenient reader (16 KiB cap): invalid JSON, an over-limit body
    // (destroyed) and an empty body all yield null and answer the same 400
    // invalid-body envelope the old reader's rejection branch used.
    let body: unknown
    try {
      body = await readJsonBody(req, { maxBytes: 16 * 1024 })
    } catch {
      writeJson(res, 400, { ok: false, error: 'invalid-body' })
      return
    }
    if (body === null) {
      writeJson(res, 400, { ok: false, error: 'invalid-body' })
      return
    }
    const hasActive = typeof body === 'object' && body !== null && 'active' in body
    const hasBackground = typeof body === 'object' && body !== null && 'background' in body
    if (!hasActive && !hasBackground) {
      writeJson(res, 400, { ok: false, error: 'nothing-to-update' })
      return
    }
    const active = (body as { active?: unknown }).active
    if (hasActive && active !== null && typeof active !== 'string') {
      writeJson(res, 400, { ok: false, error: 'active-must-be-string-or-null' })
      return
    }
    if (typeof active === 'string' && !findSkin(loadCatalog(), active)) {
      writeJson(res, 404, { ok: false, error: 'skin-not-found' })
      return
    }
    const update: { active?: string | null; background?: SkinBackgroundConfig | null } = {}
    if (hasActive) update.active = active as string | null
    if (hasBackground) {
      const background = sanitizeSkinBackground((body as { background?: unknown }).background)
      if (background === null) {
        writeJson(res, 400, { ok: false, error: 'invalid-background' })
        return
      }
      update.background = background
    }
    writeActiveState(activeStatePath, update)
    const state = readActiveState(activeStatePath)
    writeJson(res, 200, { ok: true, active: state.active, background: state.background })
  }

  return [
    { kind: 'exact', path: `${SKIN_CENTER_V2_PREFIX}/catalog`, handler: catalogHandler },
    { kind: 'exact', path: `${SKIN_CENTER_V2_PREFIX}/verify`, handler: verifyHandler },
    { kind: 'prefix', path: skinPrefix.replace(/\/$/, ''), handler: skinsHandler },
    { kind: 'exact', path: `${SKIN_CENTER_V2_PREFIX}/active`, handler: (req, res) => {
      if (req.method === 'GET') return activeGetHandler(req, res)
      if (req.method === 'POST') return activePostHandler(req, res)
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    } },
  ]
}
