// @vitest-environment jsdom

/**
 * The applied-skin convergence surface (issue #1740).
 *
 * Applying a skin and saving that choice are one action in the GUI, but the
 * selection is persisted for the NEXT page load, while the v2 runtime applies
 * in place. A page that keeps running must therefore converge on writes it did
 * not make: the workshop announcement, and the selection read back from the
 * activation endpoint. That endpoint also carries the background preferences,
 * so the same follow converges a background write made by the CLI, another
 * window or a paired remote. This spec pins both paths, the catalog re-read a
 * just-installed skin needs, the feedback rules the background follow must
 * keep, and the teardown that keeps each path inside the activation that owns
 * it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bootSkinRuntime,
  trackSkinAppliedEvents,
  watchPersistedSelection,
  type CatalogSkin,
  type SkinBackgroundTarget,
  type SkinRuntimeStore,
} from '../src/client/runtime/boot.ts'
import { resolveSkinBackground, type SkinBackgroundConfig } from '../src/core/background.ts'

const API = '/api/skin-center/v2'

const catalogSkin = (id: string): CatalogSkin => ({
  origin: 'user',
  warnings: [],
  manifest: { id, name: id, nameEn: id, contributes: { stylesheet: 'skin.css' } },
} as CatalogSkin)

/**
 * One activation-endpoint answer, shaped like the host route: the persisted
 * selection and the persisted background section (null when none is stored).
 */
function activeAnswer(
  active: () => string | null,
  background: () => SkinBackgroundConfig | null = () => null,
): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: true, active: active(), background: background() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

/**
 * A stand-in for the page's own BackgroundController: records every init() and
 * holds the applied values, so a test can tell a convergence from a revert.
 */
function fakeBackground(initial: SkinBackgroundConfig | null = null): {
  handle: SkinBackgroundTarget
  inits: Array<SkinBackgroundConfig | null>
  live: () => Required<SkinBackgroundConfig>
  edit: (patch: SkinBackgroundConfig) => void
} {
  const inits: Array<SkinBackgroundConfig | null> = []
  let live = resolveSkinBackground(initial)
  return {
    handle: {
      init: (next: SkinBackgroundConfig | null) => {
        inits.push(next)
        live = resolveSkinBackground(next)
      },
    },
    inits,
    live: () => live,
    /** A card edit: the live value moves immediately, its debounced POST has not landed. */
    edit: (patch: SkinBackgroundConfig) => { live = resolveSkinBackground({ ...live, ...patch }) },
  }
}

/** Drive the document's visibility the way the follow observes it. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

/**
 * A runtime store stand-in: the converge paths only read the document, the
 * window and the fetch seat off the store and drive its controller, so this
 * fake records the switches it was asked for instead of loading stylesheets.
 */
function fakeStore(options: {
  catalog?: CatalogSkin[]
  fetchImpl?: typeof fetch
  background?: SkinBackgroundTarget
} = {}): {
  store: SkinRuntimeStore
  switched: string[]
  catalogRefreshes: () => number
} {
  const catalog = options.catalog ?? []
  const switched: string[] = []
  let refreshes = 0
  const store = {
    controller: {
      switchTo: async (id: string | null) => { switched.push(id ?? 'null'); return id },
    },
    adapter: {},
    doc: document,
    window,
    apiBase: API,
    fetchImpl: options.fetchImpl ?? activeAnswer(() => null),
    background: options.background ?? null,
    catalog: () => catalog,
    diagnostics: () => [],
    refreshCatalog: async () => { refreshes += 1 },
    find: (id: string) => catalog.find(entry => entry.manifest.id === id) ?? null,
    subscribe: () => () => {},
    shutdown: () => {},
  } as unknown as SkinRuntimeStore
  return { store, switched, catalogRefreshes: () => refreshes }
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.querySelectorAll('link[rel="stylesheet"]').forEach(link => { link.remove() })
  document.documentElement.removeAttribute('data-dsh-skin')
})

afterEach(() => {
  vi.useRealTimers()
  delete (document as { visibilityState?: unknown }).visibilityState
})

describe('applied-skin convergence (issue #1740)', () => {
  it('user applies an installed skin elsewhere and this page switches to it on the announcement', async () => {
    // Given a page whose runtime knows the newly installed skin
    const { store, switched } = fakeStore({ catalog: [catalogSkin('whale-song')] })
    const stop = trackSkinAppliedEvents(store)

    // When the workshop announces that it applied that skin
    window.dispatchEvent(new CustomEvent('dsh-skin-applied', { detail: { id: 'whale-song' } }))
    await vi.waitFor(() => { expect(switched).toEqual(['whale-song']) })

    // Then the page shows the announced skin, and teardown stops listening
    stop()
    window.dispatchEvent(new CustomEvent('dsh-skin-applied', { detail: { id: 'whale-song' } }))
    await Promise.resolve()
    expect(switched).toEqual(['whale-song'])
  })

  it('an announced skin that this page has not read yet is resolved after a catalog re-read', async () => {
    // Given a page whose catalog predates the installation
    const { store, switched, catalogRefreshes } = fakeStore({ catalog: [] })
    const stop = trackSkinAppliedEvents(store)

    // When the announcement names a skin the snapshot does not carry
    window.dispatchEvent(new CustomEvent('dsh-skin-applied', { detail: { id: 'maid-atelier' } }))
    await vi.waitFor(() => { expect(catalogRefreshes()).toBe(1) })

    // Then the page re-reads the catalog and, with no entry to switch to,
    // leaves the previous activation alone rather than clearing it
    expect(switched).toEqual([])
    stop()
  })

  it('user picks a skin while this page stays open and the page converges on the persisted selection', async () => {
    vi.useFakeTimers()
    // Given a page that has already applied the persisted selection
    let persisted: string | null = 'mint'
    const { store, switched } = fakeStore({
      catalog: [catalogSkin('mint'), catalogSkin('harbor')],
      fetchImpl: activeAnswer(() => persisted),
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When something else writes a different selection
    persisted = 'harbor'
    await vi.advanceTimersByTimeAsync(2500)

    // Then this page switches to the new selection instead of keeping the old one
    expect(switched).toEqual(['harbor'])
    stop()
  })

  it('an unchanged selection is not re-applied on every poll', async () => {
    vi.useFakeTimers()
    // Given a page following the persisted selection
    const { store, switched } = fakeStore({ catalog: [catalogSkin('mint')], fetchImpl: activeAnswer(() => 'mint') })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When several polls pass with the selection unchanged
    await vi.advanceTimersByTimeAsync(10_000)

    // Then the runtime is never asked to re-apply what it already shows
    expect(switched).toEqual([])
    stop()
  })

  it('user clears the selection and the page returns to the stock look', async () => {
    vi.useFakeTimers()
    // Given a page showing a skin while the persisted selection is cleared
    let persisted: string | null = 'mint'
    const { store, switched } = fakeStore({ catalog: [catalogSkin('mint')], fetchImpl: activeAnswer(() => persisted) })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When the selection is cleared elsewhere
    persisted = null
    await vi.advanceTimersByTimeAsync(2500)

    // Then the page drops the skin rather than keeping a selection nobody serves
    expect(switched).toEqual(['null'])
    stop()
  })

  it('a page that already loaded its catalog still reacts to an announcement', async () => {
    // Given a booted runtime whose catalog load completed before any announcement
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/catalog')) {
        return new Response(JSON.stringify({ ok: true, skins: [catalogSkin('whale-song')], diagnostics: [] }), { status: 200 })
      }
      if (url.endsWith('/active')) {
        return new Response(JSON.stringify({ ok: true, active: null }), { status: 200 })
      }
      if (url.endsWith('/skins/whale-song/stylesheet')) {
        return new Response('', { status: 200, headers: { 'content-type': 'text/css' } })
      }
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    const store = bootSkinRuntime({ apiBase: API, fetchImpl })
    await vi.waitFor(() => { expect(store.catalog()?.length).toBe(1) })

    // When an announcement arrives after that load
    window.dispatchEvent(new CustomEvent('dsh-skin-applied', { detail: { id: 'whale-song' } }))

    // Then the runtime activates it: the switch starts by requesting that
    // skin's stylesheet, which the pre-fix runtime never did because its own
    // catalog load had already unsubscribed the listener
    await vi.waitFor(() => {
      expect(document.head.querySelector('link[href*="whale-song/stylesheet"]')?.getAttribute('href')).toBe(`${API}/skins/whale-song/stylesheet`)
    })
    store.shutdown()
  })
})

describe('persisted background convergence', () => {
  it('a background write from outside this page converges through the page controller', async () => {
    vi.useFakeTimers()
    // Given a page whose background controller shows the persisted value
    let persisted: SkinBackgroundConfig | null = { backgroundOpacity: 10 }
    const background = fakeBackground({ backgroundOpacity: 10 })
    const { store } = fakeStore({
      fetchImpl: activeAnswer(() => 'mint', () => persisted),
      catalog: [catalogSkin('mint')],
      background: background.handle,
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)
    // The seed never converges: boot already applied the stored value
    expect(background.inits).toEqual([])

    // When something else writes a different background (the dsh-skin CLI)
    persisted = { backgroundOpacity: 40, bubbleBlur: 3 }
    await vi.advanceTimersByTimeAsync(2500)

    // Then the open page converges on it instead of waiting for a reload
    expect(background.inits).toEqual([{ backgroundOpacity: 40, bubbleBlur: 3 }])
    expect(background.live().backgroundOpacity).toBe(40)
    expect(background.live().bubbleBlur).toBe(3)
    stop()
  })

  it('clearing the background elsewhere returns the page to the documented defaults', async () => {
    vi.useFakeTimers()
    // Given a page showing a customized background
    let persisted: SkinBackgroundConfig | null = { backgroundOpacity: 40, bubbleBlur: 3 }
    const background = fakeBackground(persisted)
    const { store } = fakeStore({
      fetchImpl: activeAnswer(() => null, () => persisted),
      background: background.handle,
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When the section is dropped (dsh-skin bg reset) so the endpoint answers null
    persisted = null
    await vi.advanceTimersByTimeAsync(2500)

    // Then the page applies the defaults rather than keeping the stale values
    expect(background.inits).toEqual([null])
    expect(background.live().backgroundOpacity).toBe(0)
    expect(background.live().bubbleBlur).toBe(10)
    stop()
  })

  it('a hidden page does not converge and catches up when it is visible again', async () => {
    vi.useFakeTimers()
    let persisted: SkinBackgroundConfig | null = { backgroundOpacity: 10 }
    const background = fakeBackground({ backgroundOpacity: 10 })
    const { store } = fakeStore({
      fetchImpl: activeAnswer(() => null, () => persisted),
      background: background.handle,
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When the page is hidden while something else writes
    setVisibility('hidden')
    persisted = { backgroundOpacity: 40 }
    await vi.advanceTimersByTimeAsync(10_000)

    // Then no poll ran, and becoming visible again converges on the write
    expect(background.inits).toEqual([])
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(0)
    expect(background.inits).toEqual([{ backgroundOpacity: 40 }])
    expect(background.live().backgroundOpacity).toBe(40)
    stop()
  })

  it('an edit still in flight is not reverted by the follow', async () => {
    vi.useFakeTimers()
    // Given a page whose card just moved a slider; its debounced POST has not landed
    const persisted: SkinBackgroundConfig = { backgroundOpacity: 10 }
    const background = fakeBackground({ backgroundOpacity: 10 })
    const { store } = fakeStore({
      fetchImpl: activeAnswer(() => null, () => persisted),
      background: background.handle,
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)
    background.edit({ backgroundOpacity: 40 })

    // When a poll runs before that write lands
    await vi.advanceTimersByTimeAsync(2500)

    // Then the poll must not put the stored value back over the user's edit
    expect(background.inits).toEqual([])
    expect(background.live().backgroundOpacity).toBe(40)

    // And once the write lands the page is already showing it
    persisted.backgroundOpacity = 40
    await vi.advanceTimersByTimeAsync(2500)
    expect(background.live().backgroundOpacity).toBe(40)
    stop()
  })

  it('an unchanged background is not re-applied on every poll', async () => {
    vi.useFakeTimers()
    // Given a page following a persisted background
    const background = fakeBackground({ backgroundOpacity: 10 })
    const { store } = fakeStore({
      fetchImpl: activeAnswer(() => null, () => ({ backgroundOpacity: 10 })),
      background: background.handle,
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When several polls pass with the background unchanged
    await vi.advanceTimersByTimeAsync(10_000)

    // Then the controller is never asked to apply what it already shows
    expect(background.inits).toEqual([])
    stop()
  })

  it('a page booted without a background controller still follows the selection', async () => {
    vi.useFakeTimers()
    // Given a store whose page owns no background controller (the field is null)
    let persisted = 'mint'
    let storedBackground: SkinBackgroundConfig | null = { backgroundOpacity: 10 }
    const { store, switched } = fakeStore({
      catalog: [catalogSkin('mint'), catalogSkin('harbor')],
      fetchImpl: activeAnswer(() => persisted, () => storedBackground),
    })
    const stop = watchPersistedSelection(store)
    await vi.advanceTimersByTimeAsync(0)

    // When both the selection and the background change elsewhere
    persisted = 'harbor'
    storedBackground = { backgroundOpacity: 40 }
    await vi.advanceTimersByTimeAsync(2500)

    // Then the selection still converges, and the follow leaves the missing
    // controller alone rather than dereferencing it
    expect(switched).toEqual(['harbor'])
    stop()
  })
})
