// @vitest-environment jsdom
/**
 * Wallpaper thumb fallback: a video wallpaper without a preview image
 * (a bare .mp4 in a manual library folder has no project.json preview)
 * renders its first frame through a <video preload="metadata"> thumb
 * instead of a blank box; entries with a real preview keep the <img>.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { WallpaperPanel } from '../src/client/WallpaperPanel.tsx'
import { zh, type SkinCenterKey } from '../src/client/locales.ts'
import type { WallpaperDirListing, WallpaperHandle } from '../src/client/wallpaper.ts'

;((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT) = true

const t = (key: SkinCenterKey): string => zh[key] ?? key

// Cached snapshot: useSyncExternalStore loops when getSnapshot returns a
// fresh object on every call.
const NO_DIRS: string[] = []

const stubWallpaper = (overrides: Partial<WallpaperHandle> = {}): WallpaperHandle => ({
  enabled: () => true,
  selection: () => '',
  mode: () => 'live',
  fit: () => 'cover',
  dim: () => 0,
  wallpaperBlur: () => 0,
  wallpaperOpacity: () => 100,
  pauseOnHidden: () => false,
  sound: () => false,
  volume: () => 100,
  dirs: () => NO_DIRS,
  addDir: () => {},
  removeDir: () => {},
  pickDir: async () => ({ kind: 'cancelled' }),
  activeId: () => null,
  writeError: () => null,
  trying: () => false,
  subscribe: () => () => {},
  setEnabled: () => {},
  setMode: () => {},
  setFit: () => {},
  setDim: () => {},
  setBlur: () => {},
  setOpacity: () => {},
  setPauseOnHidden: () => {},
  setSound: () => {},
  setVolume: () => {},
  applySelection: () => {},
  clearSelection: () => {},
  sync: () => {},
  tryOn: () => {},
  exitTryOn: () => {},
  recoverScenePlayer: () => {},
  dispose: () => {},
  ...overrides,
})

/** One host directory level as the browse capability reports it. */
const dirListing = (overrides: Partial<WallpaperDirListing> = {}): WallpaperDirListing => ({
  path: '/Users/demo',
  home: '/Users/demo',
  crumbs: [
    { name: '/', path: '/', hidden: false },
    { name: 'Users', path: '/Users', hidden: false },
    { name: 'demo', path: '/Users/demo', hidden: false },
  ],
  entries: [
    { name: 'Movies', path: '/Users/demo/Movies', hidden: false },
    { name: 'Pictures', path: '/Users/demo/Pictures', hidden: false },
    { name: '.cache', path: '/Users/demo/.cache', hidden: true },
  ],
  truncated: false,
  ...overrides,
})

const inventory = (wallpapers: unknown[]) => ({
  ok: true,
  installDir: null,
  total: wallpapers.length,
  portableCount: wallpapers.length,
  wallpapers,
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  host = document.getElementById('root') as HTMLDivElement
})

afterEach(() => {
  act(() => { root.unmount() })
  vi.unstubAllGlobals()
})

/** Render the panel against one stubbed inventory payload. */
async function render(wallpapers: unknown[], wallpaper: WallpaperHandle = stubWallpaper()): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => inventory(wallpapers),
  })))
  root = createRoot(host)
  await act(async () => {
    root.render(<WallpaperPanel t={t as never} wallpaper={wallpaper} />)
  })
}

/** The browse button of the manual-folder row. */
function browseButton(): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll('button'))
  return (buttons.find((button) => button.textContent === zh.wallpaperDirBrowse) ?? null) as HTMLButtonElement | null
}

/** One rendered button by its visible label (dialog rows and actions). */
function buttonWith(label: string): HTMLButtonElement | null {
  const buttons = Array.from(host.querySelectorAll('button'))
  return (buttons.find((button) => button.textContent === label) ?? null) as HTMLButtonElement | null
}

describe('WallpaperPanel thumbs', () => {
  it('falls back to a muted first-frame <video> when no preview image exists', async () => {
    await render([{
      id: 'lib/aurora.mp4',
      title: 'aurora',
      type: 'video',
      source: 'local',
      playable: true,
      updateAvailable: false,
      videoUrl: '/api/skin-center/we/media/AAA',
      webUrl: null,
      frameUrl: null,
      previewUrl: null,
    }])
    const video = host.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe('/api/skin-center/we/media/AAA')
    expect(video?.getAttribute('preload')).toBe('metadata')
    expect(video?.muted).toBe(true)
    expect(host.querySelector('img')).toBeNull()
  })

  it('keeps the <img> thumb when the wallpaper has a real preview', async () => {
    await render([{
      id: 'workshop/123',
      title: 'sunset',
      type: 'video',
      source: 'workshop',
      playable: true,
      updateAvailable: false,
      videoUrl: '/api/skin-center/we/media/BBB',
      webUrl: null,
      frameUrl: null,
      previewUrl: '/api/skin-center/we/preview/CCC',
    }])
    const img = host.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/skin-center/we/preview/CCC')
    expect(host.querySelector('video')).toBeNull()
  })
})

describe('WallpaperPanel directory picker', () => {
  it('adds the picked folder directly through the native picker', async () => {
    const added: string[] = []
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'picked', path: '/Users/demo/Pictures/wallpapers' }),
      addDir: (dir) => { added.push(dir) },
    }))
    const button = browseButton()
    expect(button).not.toBeNull()
    await act(async () => { button!.click() })
    expect(added).toEqual(['/Users/demo/Pictures/wallpapers'])
  })

  it('does nothing when the picker is cancelled', async () => {
    const added: string[] = []
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'cancelled' }),
      addDir: (dir) => { added.push(dir) },
    }))
    await act(async () => { browseButton()!.click() })
    expect(added).toEqual([])
    expect(host.textContent).not.toContain(zh.wallpaperDirBrowseFailed)
  })

  it('reports a failed pick and keeps the manual input', async () => {
    // Given a Host whose pick call rejects (a transport or assembly fault)
    await render([], stubWallpaper({
      pickDir: async () => { throw new Error('the carrier broke') },
    }))

    // When the user clicks Browse
    await act(async () => { browseButton()!.click() })

    // Then the failure is reported and the manual input stays usable
    expect(host.textContent).toContain(zh.wallpaperDirBrowseFailed)
    expect(host.textContent).toContain('the carrier broke')
    expect(host.querySelector('input')).not.toBeNull()
  })

  it('falls back to the manual hint when nothing serves the browse capability', async () => {
    // Given a Host that refuses the pick and offers no listing primitives
    await render([], stubWallpaper({ pickDir: async () => ({ kind: 'unavailable' }) }))

    // When the user clicks Browse
    await act(async () => { browseButton()!.click() })

    // Then the panel asks for a typed path instead of opening an empty browser
    expect(host.textContent).toContain(zh.wallpaperDirBrowseFailed)
    expect(host.textContent).not.toContain(zh.wallpaperDirBrowseTitle)
  })

  it('hides the browse button when the face provides no picker', async () => {
    const stub = stubWallpaper()
    delete (stub as { pickDir?: unknown }).pickDir
    await render([], stub)
    expect(browseButton()).toBeNull()
  })
})

describe('WallpaperPanel in-app folder browser', () => {
  it('browses the host when the composed picker serves the browse capability', async () => {
    // Given a Host whose picker refuses the native verb but lists directories
    const added: string[] = []
    const listed: (string | undefined)[] = []
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'unavailable' }),
      listDir: async (path?: string) => { listed.push(path); return dirListing() },
      addDir: (dir) => { added.push(dir) },
    }))

    // When the user clicks Browse
    await act(async () => { browseButton()!.click() })

    // Then the in-app browser opens on the host home instead of failing
    await vi.waitFor(() => { expect(host.textContent).toContain(zh.wallpaperDirBrowseTitle) })
    expect(host.textContent).toContain('Movies')
    expect(listed).toEqual([undefined])

    // And choosing the listed level adds that absolute host path
    await act(async () => { buttonWith(zh.wallpaperDirBrowseChoose)!.click() })
    expect(added).toEqual(['/Users/demo'])
    expect(host.textContent).not.toContain(zh.wallpaperDirBrowseTitle)
  })

  it('navigates one level and hides dot-folders until asked', async () => {
    // Given a listing whose child level is empty and a hidden entry at home
    const added: string[] = []
    const listed: (string | undefined)[] = []
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'unavailable' }),
      listDir: async (path?: string) => {
        listed.push(path)
        if (path === undefined) return dirListing()
        const parent = dirListing()
        return dirListing({
          path,
          crumbs: [...parent.crumbs, { name: 'Movies', path, hidden: false }],
          entries: [],
        })
      },
      addDir: (dir) => { added.push(dir) },
    }))
    await act(async () => { browseButton()!.click() })
    await vi.waitFor(() => { expect(host.textContent).toContain(zh.wallpaperDirBrowseTitle) })

    // Dot-folders stay hidden until the toggle is on
    expect(host.textContent).not.toContain('.cache')
    const toggle = host.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => { toggle.click() })
    expect(host.textContent).toContain('.cache')

    // Entering a row lists the absolute child path the Host reported
    await act(async () => { buttonWith('Movies')!.click() })
    expect(listed).toEqual([undefined, '/Users/demo/Movies'])

    // Then the level now shown is what gets added
    await act(async () => { buttonWith(zh.wallpaperDirBrowseChoose)!.click() })
    expect(added).toEqual(['/Users/demo/Movies'])
  })

  it('closes the browser on Escape', async () => {
    // Given an open in-app browser
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'unavailable' }),
      listDir: async () => dirListing(),
    }))
    await act(async () => { browseButton()!.click() })
    await vi.waitFor(() => { expect(host.textContent).toContain(zh.wallpaperDirBrowseTitle) })

    // When Escape is pressed
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })

    // Then the browser is gone
    expect(host.textContent).not.toContain(zh.wallpaperDirBrowseTitle)
  })

  it('reports a failed host listing inside the browser', async () => {
    // Given a Host whose listing call rejects
    await render([], stubWallpaper({
      pickDir: async () => ({ kind: 'unavailable' }),
      listDir: async () => { throw new Error('directory-unreadable') },
    }))

    // When the user clicks Browse
    await act(async () => { browseButton()!.click() })

    // Then the browser stays open and names the failure
    await vi.waitFor(() => { expect(host.textContent).toContain('directory-unreadable') })
    expect(host.textContent).toContain(zh.wallpaperDirBrowseFailed)
  })
})

describe('WallpaperPanel folder-sourced library status', () => {
  const item = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: id,
    type: 'video',
    source: 'local',
    playable: true,
    updateAvailable: false,
    videoUrl: '/api/skin-center/we/media/' + id,
    webUrl: null,
    frameUrl: null,
    previewUrl: '/api/skin-center/we/preview/' + id,
    ...overrides,
  })

  it('pages the grid by 24 items with full pagination controls (#1354)', async () => {
    const many = Array.from({ length: 50 }, (_, i) => item('w' + String(i), { title: 'Wallpaper ' + String(i) }))
    await render(many)
    const cards = (): number => host.querySelectorAll('img').length
    // Page 1 should mount exactly 24 items
    expect(cards()).toBe(24)
    expect(host.textContent).toContain('1')
    expect(host.textContent).toContain('3') // 50 items = 3 pages

    // Next page button
    const nextBtn = Array.from(host.querySelectorAll('button'))
      .find((b) => b.getAttribute('aria-label') === zh.wallpaperPageNext) as HTMLButtonElement
    expect(nextBtn).toBeDefined()
    await act(async () => { nextBtn.click() })

    // Page 2 should mount 24 items
    expect(cards()).toBe(24)

    // Click page 3 button
    const page3Btn = Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === '3') as HTMLButtonElement
    expect(page3Btn).toBeDefined()
    await act(async () => { page3Btn.click() })

    // Page 3 should mount remaining 2 items (50 - 48 = 2)
    expect(cards()).toBe(2)

    // Jump back to page 1 via jump form
    const jumpInput = host.querySelector('input[aria-label="' + zh.wallpaperPageJump + '"]') as HTMLInputElement
    const jumpForm = jumpInput.closest('form') as HTMLFormElement
    expect(jumpInput).toBeDefined()
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    await act(async () => {
      nativeSetter?.call(jumpInput, '1')
      jumpInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      jumpForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(cards()).toBe(24)
  })

  it('defaults to G rating and allows filtering to PG-13 or R18 (#1354)', async () => {
    const wallpapers = [
      item('w1', { title: 'Safe Art', rating: 'g' }),
      item('w2', { title: 'Teen Art', rating: 'pg13' }),
      item('w3', { title: 'Adult Art', rating: 'r18' }),
    ]
    await render(wallpapers)

    // Defaults to G rating: only Safe Art visible initially
    expect(host.querySelectorAll('img').length).toBe(1)
    expect(host.textContent).toContain('Safe Art')
    expect(host.textContent).not.toContain('Adult Art')

    // There is no "All" option in the toolbar
    const allFilter = Array.from(host.querySelectorAll('button'))
      .find((b) => b.getAttribute('role') === 'tab' && b.textContent === zh.wallpaperRatingAll)
    expect(allFilter).toBeUndefined()

    // Filter by R18
    const r18Filter = Array.from(host.querySelectorAll('button'))
      .find((b) => b.getAttribute('role') === 'tab' && b.textContent === zh.wallpaperRatingR18) as HTMLButtonElement
    expect(r18Filter).toBeDefined()
    await act(async () => { r18Filter.click() })

    // Only Adult Art visible with R18 badge
    expect(host.querySelectorAll('img').length).toBe(1)
    expect(host.textContent).toContain('Adult Art')
    expect(host.textContent).toContain('R18')
    expect(host.textContent).not.toContain('Safe Art')

    // Filter by PG-13
    const pg13Filter = Array.from(host.querySelectorAll('button'))
      .find((b) => b.getAttribute('role') === 'tab' && b.textContent === zh.wallpaperRatingPg13) as HTMLButtonElement
    await act(async () => { pg13Filter.click() })
    expect(host.querySelectorAll('img').length).toBe(1)
    expect(host.textContent).toContain('Teen Art')
    expect(host.textContent).toContain('PG-13')

    // Switch back to G
    const gFilter = Array.from(host.querySelectorAll('button'))
      .find((b) => b.getAttribute('role') === 'tab' && b.textContent === zh.wallpaperRatingG) as HTMLButtonElement
    await act(async () => { gFilter.click() })
    expect(host.querySelectorAll('img').length).toBe(1)
    expect(host.textContent).toContain('Safe Art')
  })

  it('reports the added-folders status line when no Wallpaper Engine install is found', async () => {
    // Given an inventory with neither a Wallpaper Engine install nor system
    // entries — the macOS shape, where the library is the folders the user added
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        installDir: null,
        total: 1,
        portableCount: 1,
        wallpapers: [item('local/mine', { source: 'local' })],
      }),
    })))
    root = createRoot(host)
    await act(async () => {
      root.render(<WallpaperPanel t={t as never} wallpaper={stubWallpaper()} />)
    })

    // Then the panel names the added-folder source instead of a system scan
    await vi.waitFor(() => { expect(host.textContent).toContain(zh.wallpaperLibraryManual) })
  })

  it('user sees a failed-save notice after a settings write the Host refused', async () => {
    // Given a wallpaper card whose last settings write did not land
    await render([item('workshop/123', {})], stubWallpaper({
      writeError: () => 'the Host did not accept the wallpaper setting',
    }))

    // When the panel renders
    // Then the notice names the failure next to the controls
    expect(host.textContent).toContain(zh.wallpaperSaveFailed)
    expect(host.textContent).toContain('the Host did not accept the wallpaper setting')
  })
})
