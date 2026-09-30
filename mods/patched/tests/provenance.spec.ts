/**
 * Provenance tests: truthful repair origin (market trust only for market
 * bytes), abandoned temp-directory sweeping, and the awaited rename retry that
 * replaced the synchronous spin wait.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LOCAL_PROVENANCE_SOURCE,
  MARKET_PROVENANCE_FILENAME,
  MARKET_PROVENANCE_SOURCE,
  renameWithRetry,
  repairSkinFromMarket,
  verifyMarketProvenance,
  verifySkinIntegrity,
} from '../src/provenance.ts'

const HOUR_MS = 60 * 60 * 1000

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function v2(id: string): Record<string, unknown> {
  return {
    skinManifestVersion: 2,
    id,
    name: id,
    nameEn: id,
    version: '1.0.0',
    author: 'tester',
    contributes: { stylesheet: 'skin.css' },
  }
}

let root: string

/** A pristine local source tree holding one skin with one stylesheet. */
function writeLocalSource(id: string): { dir: string; manifest: string; css: string } {
  const dir = join(root, 'source', id)
  mkdirSync(dir, { recursive: true })
  const manifest = JSON.stringify(v2(id), null, 2)
  const css = '.pristine { color: blue; }'
  writeFileSync(join(dir, 'skin.json'), manifest)
  writeFileSync(join(dir, 'skin.css'), css)
  return { dir, manifest, css }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'provenance-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('repairSkinFromMarket origin', () => {
  it('records the local origin and refuses hook trust for bytes copied from the bundled tree', async () => {
    const source = writeLocalSource('local-skin')
    const dest = join(root, 'user', 'local-skin')
    const res = await repairSkinFromMarket(dest, 'local-skin', { localSourceDir: source.dir })
    expect(res.ok).toBe(true)

    const doc = JSON.parse(readFileSync(join(dest, MARKET_PROVENANCE_FILENAME), 'utf8')) as { source: string; id: string }
    expect(doc.source).toBe(LOCAL_PROVENANCE_SOURCE)
    expect(doc.id).toBe('local-skin')
    // The copied bytes are integrity-verifiable, but the document never claims
    // market review, so the market-only hooks trust gate refuses them.
    expect(verifySkinIntegrity(dest, 'local-skin')).toEqual({
      id: 'local-skin',
      status: 'valid',
      hooksTrusted: false,
      hasProvenance: true,
      mismatches: [],
      missing: [],
      totalFilesChecked: 2,
    })
    expect(verifyMarketProvenance(dest, 'local-skin', 'hooks.mjs')).toBe(false)
  })

  it('keeps market provenance (and therefore hook trust) for byte-matching market installs', () => {
    const source = writeLocalSource('market-skin')
    const dir = join(root, 'user', 'market-skin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skin.json'), source.manifest)
    writeFileSync(join(dir, 'skin.css'), source.css)
    writeFileSync(join(dir, 'hooks.mjs'), 'export default {}\n')
    writeFileSync(join(dir, MARKET_PROVENANCE_FILENAME), JSON.stringify({
      version: 1,
      source: MARKET_PROVENANCE_SOURCE,
      kind: 'skin',
      id: 'market-skin',
      files: {
        'skin.json': sha256(source.manifest),
        'skin.css': sha256(source.css),
        'hooks.mjs': sha256('export default {}\n'),
      },
    }, null, 2))

    expect(verifyMarketProvenance(dir, 'market-skin', 'hooks.mjs')).toBe(true)
    const report = verifySkinIntegrity(dir, 'market-skin', { hooksEntry: 'hooks.mjs' })
    expect(report.status).toBe('valid')
    expect(report.hooksTrusted).toBe(true)
  })

  it('still detects post-repair tampering of a locally repaired skin', async () => {
    const source = writeLocalSource('tamper-me')
    const dest = join(root, 'user', 'tamper-me')
    expect((await repairSkinFromMarket(dest, 'tamper-me', { localSourceDir: source.dir })).ok).toBe(true)

    writeFileSync(join(dest, 'skin.css'), '.edited { color: red; }')
    const report = verifySkinIntegrity(dest, 'tamper-me')
    expect(report.status).toBe('tampered')
    expect(report.mismatches).toContain('skin.css')
    expect(report.hooksTrusted).toBe(false)
  })
})

describe('stale temp-directory sweeping', () => {
  it('sweeps an abandoned repair temp dir while repairing from the market', async () => {
    const source = writeLocalSource('debris-skin')
    const userDir = join(root, 'user')
    const dest = join(userDir, 'debris-skin')
    mkdirSync(userDir, { recursive: true })
    const stale = join(userDir, 'debris-skin.repair-abc123-zzzzzz')
    mkdirSync(stale)
    utimesSync(stale, new Date(Date.now() - 2 * HOUR_MS), new Date(Date.now() - 2 * HOUR_MS))

    const mockFetch = async (url: string | URL): Promise<Response> => {
      const target = String(url)
      if (target.endsWith('/manifest/skins.json')) {
        return new Response(JSON.stringify({ items: [{ id: 'debris-skin', files: ['skin.json', 'skin.css'] }] }), { status: 200 })
      }
      const rel = target.endsWith('/skin.json') ? 'skin.json' : 'skin.css'
      return new Response(readFileSync(join(source.dir, rel)), { status: 200 })
    }

    const res = await repairSkinFromMarket(dest, 'debris-skin', { fetchImpl: mockFetch as unknown as typeof fetch })
    expect(res.ok).toBe(true)
    expect(() => statSync(stale)).toThrow()
    expect(readFileSync(join(dest, 'skin.css'), 'utf8')).toBe(source.css)
  })
})

describe('renameWithRetry', () => {
  it('retries a transient rename failure with awaited backoff and succeeds', async () => {
    const sleeps: number[] = []
    const attempts: number[] = []
    await renameWithRetry('src', 'dest', {
      baseDelayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      rename: () => {
        attempts.push(attempts.length + 1)
        if (attempts.length < 3) {
          const err = new Error('simulated hold') as NodeJS.ErrnoException
          err.code = 'EBUSY'
          throw err
        }
      },
    })
    expect(attempts).toHaveLength(3)
    // Awaited, growing backoff: never a synchronous spin.
    expect(sleeps).toEqual([5, 10])
  })

  it('rethrows a non-transient rename error without waiting', async () => {
    const missing = join(root, 'does-not-exist')
    const dest = join(root, 'never')
    const sleeps: number[] = []
    await expect(renameWithRetry(missing, dest, {
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(sleeps).toEqual([])
  })

  it('gives up after the backoff budget and rethrows the last transient error', async () => {
    const sleeps: number[] = []
    await expect(renameWithRetry('src', 'dest', {
      totalMs: 0,
      baseDelayMs: 5,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      rename: () => {
        const err = new Error('never settles') as NodeJS.ErrnoException
        err.code = 'EBUSY'
        throw err
      },
    })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(sleeps).toEqual([])
  })
})
