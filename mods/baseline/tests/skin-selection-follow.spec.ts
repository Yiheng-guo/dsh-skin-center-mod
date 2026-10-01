// @vitest-environment jsdom

/**
 * The applied-skin convergence surface (issue #1740).
 *
 * Applying a skin and saving that choice are one action in the GUI, but the
 * selection is persisted for the NEXT page load, while the v2 runtime applies
 * in place. A page that keeps running must therefore converge on writes it did
 * not make: the workshop announcement, and the selection read back from the
 * activation endpoint. This spec pins both paths, the catalog re-read a
 * just-installed skin needs, and the teardown that keeps each path inside the
 * activation that owns it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bootSkinRuntime,
  trackSkinAppliedEvents,
  watchPersistedSelection,
  type CatalogSkin,
  type SkinRuntimeStore,
} from '../src/client/runtime/boot.ts'

const API = '/api/skin-center/v2'

const catalogSkin = (id: string): CatalogSkin => ({
  origin: 'user',
  warnings: [],
  manifest: { id, name: id, nameEn: id, contributes: { stylesheet: 'skin.css' } },
} as CatalogSkin)

/** One activation-endpoint answer, shaped like the host route. */
function activeAnswer(active: () => string | null): typeof fetch {
  return (async () => new Response(JSON.stringify({ ok: true, active: active() }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

/**
 * A runtime store stand-in: the converge paths only read the document, the
 * window and the fetch seat off the store and drive its controller, so this
 * fake records the switches it was asked for instead of loading stylesheets.
 */
function fakeStore(options: { catalog?: CatalogSkin[]; fetchImpl?: typeof fetch } = {}): {
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
