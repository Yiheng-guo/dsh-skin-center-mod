import { mkdtempSync, readFileSync, readdirSync, renameSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SKIN_ID, readActiveSelection, readActiveState, seedDefaultActiveSkin, writeActiveSelection, writeActiveState } from '../src/active-state.ts'

const HOUR_MS = 60 * 60 * 1000

const { originalRename } = vi.hoisted(() => ({
  originalRename: { impl: null as unknown as typeof renameSync },
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  originalRename.impl = actual.renameSync
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const renameMock = vi.mocked(renameSync)

describe('active-state persistence (issue #678: atomic write)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'active-state-'))
    path = join(dir, 'skin-center-active.json')
    renameMock.mockReset()
    renameMock.mockImplementation(originalRename.impl)
  })

  it('writes a valid JSON document and reads it back', () => {
    writeActiveSelection(path, 'skin-a')
    expect(readActiveSelection(path)).toBe('skin-a')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ active: 'skin-a', initialized: true })
  })

  it('persists null (stock look) and never overwrites it with seed', () => {
    writeActiveSelection(path, null)
    expect(readActiveSelection(path)).toBeNull()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ active: null, initialized: true })
    expect(seedDefaultActiveSkin(path, () => true)).toBe(false)
    expect(readActiveSelection(path)).toBeNull()
  })

  it('creates the parent directory on demand', () => {
    const nested = join(dir, 'a', 'b', 'active.json')
    writeActiveSelection(nested, 'skin-a')
    expect(readActiveSelection(nested)).toBe('skin-a')
  })

  it('leaves no temp directories behind after a successful write', () => {
    writeActiveSelection(path, 'skin-a')
    expect(readdirSync(dir)).toEqual(['skin-center-active.json'])
  })

  it('sweeps abandoned atomic-write temp directories from a crashed process', () => {
    // Exactly the shape mkdtempSync produced before the crash: mkdtempSync
    // appends 6 random characters to "<target>.tmp-".
    const stale = mkdtempSync(join(dir, 'skin-center-active.json.tmp-'))
    const old = new Date(Date.now() - 2 * HOUR_MS)
    utimesSync(stale, old, old)
    const unrelated = mkdtempSync(join(dir, 'other-skin.json.tmp-'))
    utimesSync(unrelated, old, old)
    const otherModuleDebris = mkdtempSync(join(dir, 'skin-center-active.json.repair-abc123-'))
    utimesSync(otherModuleDebris, old, old)

    writeActiveSelection(path, 'skin-a')

    expect(() => statSync(stale)).toThrow()
    // Only this module's exact temp-name pattern is swept.
    expect(statSync(unrelated).isDirectory()).toBe(true)
    expect(statSync(otherModuleDebris).isDirectory()).toBe(true)
    expect(readActiveSelection(path)).toBe('skin-a')
  })

  it('never sweeps a recent temp directory that may belong to a concurrent write', () => {
    const recent = mkdtempSync(join(dir, 'skin-center-active.json.tmp-'))
    writeActiveSelection(path, 'skin-a')
    expect(statSync(recent).isDirectory()).toBe(true)
    expect(readActiveSelection(path)).toBe('skin-a')
  })

  it('seeds the default shipped skin on a first boot with no selection', () => {
    expect(seedDefaultActiveSkin(path, () => true)).toBe(true)
    expect(readActiveSelection(path)).toBe(DEFAULT_SKIN_ID)
  })

  it('seeds nothing when the default skin is absent from the catalog', () => {
    expect(seedDefaultActiveSkin(path, () => false)).toBe(false)
    expect(readActiveSelection(path)).toBeNull()
  })

  it('never overwrites an existing selection', () => {
    writeActiveSelection(path, 'maid-atelier')
    expect(seedDefaultActiveSkin(path, () => true)).toBe(false)
    expect(readActiveSelection(path)).toBe('maid-atelier')
  })

  it('roundtrips the background section (issue #996)', () => {
    writeActiveState(path, { active: 'skin-a', background: { backgroundOpacity: 100, backgroundBlurEmpty: 4 } })
    expect(readActiveState(path)).toEqual({
      active: 'skin-a',
      background: { backgroundOpacity: 100, backgroundBlurEmpty: 4 },
      initialized: true,
    })
  })

  it('merges updates: a skin switch keeps the background and vice versa', () => {
    writeActiveState(path, { active: 'skin-a', background: { backgroundOpacity: 80 } })
    writeActiveState(path, { background: { backgroundOpacity: 60, backgroundBlurContent: 5 } })
    expect(readActiveState(path)).toEqual({
      active: 'skin-a',
      background: { backgroundOpacity: 60, backgroundBlurContent: 5 },
      initialized: true,
    })
    writeActiveSelection(path, 'skin-b')
    expect(readActiveState(path)).toEqual({
      active: 'skin-b',
      background: { backgroundOpacity: 60, backgroundBlurContent: 5 },
      initialized: true,
    })
  })

  it('normalizes stored background data and drops unknown keys', () => {
    writeActiveState(path, { background: { backgroundOpacity: 140, backgroundBlurEmpty: -3, bogus: 1 } as never })
    expect(readActiveState(path).background).toEqual({ backgroundOpacity: 100, backgroundBlurEmpty: 0 })
  })

  it('reads legacy files without a background key as null', () => {
    writeActiveSelection(path, 'skin-a')
    expect(readActiveState(path)).toEqual({ active: 'skin-a', background: null, initialized: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ active: 'skin-a', initialized: true })
  })

  it('keeps the previous content when the rename fails mid-write', () => {
    writeActiveSelection(path, 'skin-a')
    expect(readActiveSelection(path)).toBe('skin-a')
    renameMock.mockImplementationOnce(() => {
      throw new Error('simulated crash')
    })
    expect(() => writeActiveSelection(path, 'skin-b')).toThrow('simulated crash')
    // The half-written temp file must never replace the previous document.
    expect(readActiveSelection(path)).toBe('skin-a')
    expect(readFileSync(path, 'utf8')).toContain('"skin-a"')
    // The failed attempt must clean up its temp directory.
    expect(readdirSync(dir)).toEqual(['skin-center-active.json'])
  })
})
