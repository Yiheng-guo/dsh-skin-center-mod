/**
 * Browser boot wiring for the v2 skin runtime (issue #506): one store per
 * document that owns the effect ledger, the skin controller, the semantic
 * adapter and the catalog snapshot. The settings card consumes the store;
 * the store outlives the card (settings panels unmount on close), so a
 * try-on preview survives closing and reopening the panel.
 *
 * Boot sequence: fetch the catalog snapshot once, read the persisted active
 * selection, and activate it (the tapIndex adapter already stamped the
 * attribute and preloaded the stylesheet for first paint; the controller
 * re-installs under ledger ownership so later switches stay atomic).
 * @module @linxin666/dsh-client-ui-skin-center/runtime/boot
 */

import { createEffectLedger } from './effect-ledger.ts'
import { createSemanticAdapter } from './semantic-adapter.ts'
import type { SemanticAdapter } from './semantic-adapter.ts'
import { installShellRenderingAdapter } from './shell-rendering.ts'
import { createSkinController } from './skin-controller.ts'
import type { ControllerSkinEntry, SkinController } from './skin-controller.ts'

/** Display-ready catalog entry (manifest + origin), as served by /v2/catalog. */
export interface CatalogSkin {
  origin: 'builtin' | 'user'
  warnings: string[]
  manifest: ControllerSkinEntry['manifest'] & {
    name: string
    nameEn: string
    tagline?: string
    description?: string
    accent?: string
    order?: number
    author?: string
    license?: string
    attribution?: string
    preview?: { light: string; dark: string }
    tags?: string[]
  }
}

export interface CatalogDiagnostic {
  subject: string
  origin: string
  errors: string[]
}

export interface SkinRuntimeStore {
  readonly controller: SkinController
  readonly adapter: SemanticAdapter
  /**
   * The document this store owns. Everything the runtime touches - the
   * adapter, the stylesheet links, the selection poll - is keyed on it, so a
   * store never reaches into the ambient global document.
   */
  readonly doc: Document
  /** The owning window; timers and events go through it, never through globals. */
  readonly window: Window
  /** The skin-center API root this store reads and writes selection state under. */
  readonly apiBase: string
  /** The fetch seat this store uses (injectable for tests). */
  readonly fetchImpl: typeof fetch
  /** Loaded catalog snapshot (null until the first fetch resolves). */
  catalog(): CatalogSkin[] | null
  diagnostics(): CatalogDiagnostic[]
  /** Re-fetch the catalog (e.g. after the user drops a new skin directory). */
  refreshCatalog(): Promise<void>
  /** Find one entry in the current snapshot by id. */
  find(id: string): CatalogSkin | null
  /** Fires on catalog loads AND controller state transitions. */
  subscribe(listener: () => void): () => void
  /** Stop the semantic adapter and dispose the current activation. */
  shutdown(): void
}

export interface BootOptions {
  doc?: Document
  apiBase?: string
  fetchImpl?: typeof fetch
  /** Background-media priority: true suppresses skin manifest media (WE wallpaper wins). */
  suppressBackgroundMedia?: () => boolean
}

export function bootSkinRuntime(options: BootOptions = {}): SkinRuntimeStore {
  const doc = options.doc ?? document
  const apiBase = options.apiBase ?? '/api/skin-center/v2'
  const fetchImpl = options.fetchImpl ?? fetch.bind(doc.defaultView)

  const ledger = createEffectLedger()
  const controller = createSkinController({
    doc,
    ledger,
    apiBase,
    fetchImpl,
    suppressBackgroundMedia: options.suppressBackgroundMedia,
    // Switches fail closed to the previous skin; failures must still be
    // observable in the console (they are never thrown to the card).
    onError: (message, error) => {
      console.error(`[skin-center] ${message}`, error)
    },
  })
  const adapter = createSemanticAdapter(doc)
  adapter.start()
  const disposeShellRendering = installShellRenderingAdapter(doc)

  let catalog: CatalogSkin[] | null = null
  let diagnostics: CatalogDiagnostic[] = []
  // Two distinct roles, deliberately kept apart: store SUBSCRIBERS wake on
  // every emit(), while TEARDOWNS run only from shutdown(). They used to share
  // one set, and because emit() invokes every member, the window-listener
  // removal registered below ran on the very first catalog load — unsubscribing
  // the 'dsh-skin-applied' handler for the rest of the page (issue #1740).
  const listeners = new Set<() => void>()
  const teardowns = new Set<() => void>()
  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  async function refreshCatalog(): Promise<void> {
    const res = await fetchImpl(`${apiBase}/catalog`)
    if (!res.ok) throw new Error(`catalog fetch -> ${res.status}`)
    const payload = (await res.json()) as {
      ok: boolean
      skins?: CatalogSkin[]
      diagnostics?: CatalogDiagnostic[]
    }
    catalog = payload.skins ?? []
    diagnostics = payload.diagnostics ?? []
    emit()
  }

  const store: SkinRuntimeStore = {
    controller,
    adapter,
    doc,
    window: doc.defaultView ?? window,
    apiBase,
    fetchImpl,
    catalog: () => catalog,
    diagnostics: () => diagnostics,
    refreshCatalog,
    find(id) {
      return catalog?.find((s) => s.manifest.id === id) ?? null
    },
    subscribe(listener) {
      const off = controller.subscribe(listener)
      listeners.add(listener)
      return () => {
        off()
        listeners.delete(listener)
      }
    },
    shutdown() {
      adapter.stop()
      disposeShellRendering()
      controller.shutdown()
      for (const teardown of [...teardowns]) teardown()
      teardowns.clear()
      listeners.clear()
    },
  }

  // E2e/acceptance handle: exposes the boot store on the window for
  // scripted probes (see tests and the acceptance checklist).
  {
    const root = doc.defaultView as { __skinRuntime?: SkinRuntimeStore } & Window
    root.__skinRuntime = store
  }

  // Initial activation: apply the persisted selection from the snapshot.
  void (async () => {
    try {
      await refreshCatalog()
      let active = doc.documentElement?.getAttribute('data-dsh-skin') || null
      if (!active) {
        const res = await fetchImpl(`${apiBase}/active`)
        const payload = (await res.json()) as { ok: boolean; active?: string | null }
        active = payload.ok && typeof payload.active === 'string' ? payload.active : null
      }
      if (active === null) return
      let entry = store.find(active)
      if (entry === null) {
        const defaultEntry = store.find('blue-fantasy')
        if (defaultEntry !== null) {
          await controller.switchTo('blue-fantasy', defaultEntry as ControllerSkinEntry)
        } else {
          await controller.switchTo(null, null)
        }
        return
      }
      await controller.switchTo(active, entry as ControllerSkinEntry)
    } catch {
      // Fail-closed: boot into the stock look; the card surfaces catalog
      // errors through diagnostics().
      await controller.switchTo(null, null).catch(() => {})
    }
  })()

  // The workshop announcement converges this page on a skin installed while
  // it was open; the runtime store owns that listener for its own lifetime.
  teardowns.add(trackSkinAppliedEvents(store))

  return store
}

/**
 * Install the skin-applied contract: a window event carrying the applied skin
 * id makes this page converge on that skin immediately.
 *
 * The v1 runtime booted through a full document reload, so any page that
 * switched the skin could assume the next load picked the new selection up -
 * the workshop card simply reloaded. The v2 runtime applies in place, so the
 * page that is already open has to converge on the write, and the workshop
 * installs the skin files itself. Legacy-bridge pages announce through that
 * reload event; wiring it here keeps one converge path instead of two.
 * @param store - the runtime store the event converges.
 * @param win - the window whose document the runtime owns.
 * @returns the idempotent listener teardown.
 */
export function trackSkinAppliedEvents(store: SkinRuntimeStore): () => void {
  const win = store.window
  const onApplied = (event: Event): void => {
    const detail = (event as CustomEvent<{ id?: unknown }>).detail
    if (detail === null || typeof detail !== 'object') return
    const id = (detail as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') return
    void convergeOnSkin(store, id)
  }
  win.addEventListener('dsh-skin-applied', onApplied)
  return () => { win.removeEventListener('dsh-skin-applied', onApplied) }
}

/** Polling cadence for a selection changed outside this page. */
const SELECTION_POLL_MS = 2000

/** Read the persisted selection; undefined when the endpoint cannot answer. */
async function readPersistedSelection(store: SkinRuntimeStore): Promise<string | null | undefined> {
  let res: Response
  try {
    res = await store.fetchImpl(`${store.apiBase}/active`)
  } catch {
    return undefined
  }
  if (!res.ok) return undefined
  let payload: { ok?: boolean; active?: unknown }
  try {
    payload = (await res.json()) as { ok?: boolean; active?: unknown }
  } catch {
    return undefined
  }
  if (payload.ok !== true) return undefined
  return typeof payload.active === 'string' && payload.active !== '' ? payload.active : null
}

/**
 * Converge on the skin the persisted selection names, re-reading the catalog
 * first when the id is not in the current snapshot (a workshop install lands
 * after the page read the catalog).
 */
async function convergeOnSelection(store: SkinRuntimeStore, id: string | null): Promise<void> {
  if (id !== null && store.find(id) === null) {
    try {
      await store.refreshCatalog()
    } catch {
      // A failed re-read keeps the current snapshot; a skin already in it
      // still converges.
    }
  }
  if (id === null) {
    await store.controller.switchTo(null, null)
    return
  }
  const entry = store.find(id)
  if (entry === null) return
  await store.controller.switchTo(id, entry as ControllerSkinEntry)
}

/** Converge on an announced skin id, re-reading the catalog when it is new. */
async function convergeOnSkin(store: SkinRuntimeStore, id: string): Promise<void> {
  await convergeOnSelection(store, id)
}

/**
 * Install the skin-applied contract: a window event carrying the applied skin
 * id makes this page converge on that skin immediately.
 *
 * The v1 runtime booted through a full document reload, so any page that
 * switched the skin could assume the next load picked the new selection up -
 * the workshop card simply reloaded. The v2 runtime applies in place, so the
 * page already open has to converge on the write, and the workshop installs
 * the skin files itself. The workshop card announces through that reload
 * event; this is the one converge path for it.
 * @param store - the booted runtime store.
 * @returns the idempotent teardown of the listener.
 */
export function watchSkinAppliedEvents(store: SkinRuntimeStore): () => void {
  return trackSkinAppliedEvents(store)
}

/**
 * Follow the persisted selection while this page is open.
 *
 * Applying a skin and saving that choice are one action in the GUI, but the
 * choice is persisted for the NEXT page load. The conventional route is the
 * official settings form: it writes the settings row this plugin owns, the
 * Host applies it, and nothing inside this page is told. That row is seeded
 * from the skin center's own configuration, so the two are the same choice
 * written twice, and this page reads it back rather than assuming it owns
 * every write (issue #1740).
 *
 * The poll only reads: it never writes the selection back, it skips a value
 * already applied, and it stops while the page is hidden.
 * @param store - the booted runtime store.
 * @param intervalMs - polling cadence in milliseconds.
 * @returns the idempotent teardown of the poll.
 */
export function watchPersistedSelection(
  store: SkinRuntimeStore,
  intervalMs: number = SELECTION_POLL_MS,
): () => void {
  let applied: string | null | undefined
  // Window timers, not the ambient ones: the two are different types once
  // Node's globals are in the program (index.ts / boot.ts both are).
  let timer: number | null = null
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    const next = await readPersistedSelection(store)
    if (stopped || next === undefined || next === applied) return
    applied = next
    await convergeOnSelection(store, next)
  }

  const stopTimer = (): void => {
    if (timer !== null) store.window.clearInterval(timer)
    timer = null
  }
  const startTimer = (): void => {
    if (stopped || timer !== null) return
    timer = store.window.setInterval(() => { void tick() }, intervalMs)
  }

  void (async () => {
    // Seed the baseline from the CURRENT selection without converging on it:
    // boot already activated it, and re-activating would restart the skin
    // runtime's own work on every load.
    applied = await readPersistedSelection(store)
    if (!stopped) startTimer()
  })()

  // A hidden page polls for nothing, and comes back to whatever was applied
  // while it was away, so the cadence follows the document's visibility.
  const onVisibility = (): void => {
    if (store.doc.visibilityState === 'visible') {
      startTimer()
      void tick()
    } else {
      stopTimer()
    }
  }
  store.doc.addEventListener('visibilitychange', onVisibility)

  return () => {
    stopped = true
    stopTimer()
    store.doc.removeEventListener('visibilitychange', onVisibility)
  }
}
