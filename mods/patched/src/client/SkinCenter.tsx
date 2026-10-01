/**
 * The skin-center card: rendered as the content of a first-level settings
 * section, listing the official stock look plus every installed skin in the
 * v2 catalog (package-shipped built-ins + user dirs under $DSH_HOME/skins).
 *
 * v2 architecture (issue #506): skins are pure asset directories loaded by
 * the skin-center runtime. Try-on and apply both go through the same atomic
 * switch engine (src/client/runtime/skin-controller.ts) — try-on simply
 * skips persistence, and apply is one click with NO page reload, no
 * cordis.patch.yml rewrite, no boot-graph regeneration. The "trying on"
 * badge tracks the controller's live state, so closing and reopening the
 * settings panel keeps showing the skin that is still being previewed.
 * Copy rides the standard `t` seat; the theme preview control drives the
 * official theme service (persisted, same as the Appearance row).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { CatalogSkin, SkinRuntimeStore } from './runtime/boot.ts'
import type { SemanticAdapterDiagnostics } from './runtime/semantic-adapter.ts'
import type { EffectLedgerEntry } from './runtime/effect-ledger.ts'
import type { SkinCenterKey } from './locales.ts'
import type { SkinBackgroundHandle } from './background.ts'
import type { WallpaperHandle } from './wallpaper.ts'
import type { PreviewCoordinator } from './preview-coordinator.ts'
import type { CustomThemeController } from './custom-theme-controller.ts'
import { CustomThemeCard } from './CustomThemePanel.tsx'
import { WallpaperPanel } from './WallpaperPanel.tsx'
import { SliderControl } from './SliderControl.tsx'
import css from './skin-center.module.css'

/** Business face the skin-center apply() injects into the card. */
export interface SkinCenterInjected {
  /** The v2 skin runtime store (controller + catalog). */
  runtime: SkinRuntimeStore
  theme: {
    getTheme(): ThemeSnapshot
    subscribe(listener: () => void): () => void
    setTheme(id: 'light' | 'dark'): void
  }
  /** Background occluder over the shared skin-background namespace. */
  background: SkinBackgroundHandle
  /** Wallpaper Engine bridge over the skin-wallpaper namespace. */
  wallpaper: WallpaperHandle
  /** One serialized preview session shared by skins and wallpapers. */
  preview: PreviewCoordinator
  /** User palette derived from the official stock theme. */
  customTheme: CustomThemeController
}

/** Plugin-card component props: locale seat + injected face. */
export type SkinCenterComponentProps =
  PropsLocale<'skinCenter'> & SkinCenterInjected

/** The apply target of the official stock-look card. */
const OFFICIAL = 'official'

/**
 * Optional diagnostic seats read off the runtime store.
 *
 * The boot store publishes the catalog view and the semantic adapter; the
 * effect ledger and the transport are reached through this structural view so
 * a runtime that does not publish one (a card test stub, or a store built
 * before the seat existed) reports nothing on that axis instead of throwing
 * inside the card. `adapter` is the very object `window.__skinRuntime.adapter`
 * names, so the card shows the state the runtime is actually running with.
 */
interface RuntimeDiagnosticSeats {
  adapter?: { diagnostics(): SemanticAdapterDiagnostics }
  ledger?: { entries(): readonly EffectLedgerEntry[] }
  apiBase?: string
  fetchImpl?: typeof fetch
}

/** Host half of the health snapshot, as `GET /v2/diagnostics` serves it. */
export interface HostDiagnostics {
  ok?: boolean
  capturedAt?: number
  diagnostics?: Array<{ subject: string; origin: string; errors: string[] }>
  skins?: Array<{ id: string; origin: string; warnings: string[] }>
  transformFailures?: Array<{
    skinId: string
    filename: string
    error: string
    violations?: string[]
  }>
}

/** Everything the skin health section renders, already reduced to problems. */
export interface SkinHealthReport {
  stamped: number
  neverMatched: Array<{ selector: string; tagged: number }>
  invalidRules: string[]
  ledgerFailures: string[]
  catalog: Array<{ subject: string; origin: string; errors: string[] }>
  warnings: Array<{ id: string; warnings: string[] }>
  transformFailures: Array<{ skinId: string; filename: string; error: string; violations: string[] }>
}

/** Render cap per problem list; the count in each header stays exact. */
const HEALTH_ITEMS_MAX = 20

/**
 * Reduce the runtime's own diagnostics and the host snapshot into the report.
 *
 * Read-only by construction: it never mutates the adapter, the ledger or the
 * catalog, and it is only called while the section is open, so a collapsed
 * card does no work at all. The host snapshot wins where it answers (it is the
 * same catalog read plus the transform failures); the runtime's own catalog
 * view is the fallback when the route is unreachable.
 * @param runtime - the injected runtime store.
 * @param host - the `GET /v2/diagnostics` payload, or null when unavailable.
 * @returns the reduced health report.
 */
export function collectSkinHealth(runtime: SkinRuntimeStore, host: HostDiagnostics | null): SkinHealthReport {
  const seats = runtime as unknown as RuntimeDiagnosticSeats
  const adapter = seats.adapter?.diagnostics()
  const neverMatched = (adapter?.rules ?? [])
    .filter((rule) => rule.usable && !rule.everMatched)
    .map((rule) => ({ selector: rule.selector, tagged: rule.tagged }))
  const ledgerFailures = (seats.ledger?.entries() ?? [])
    .filter((entry) => entry.kind === 'cleanup-failed')
    .map((entry) => entry.label)
  const catalog = host?.diagnostics ?? runtime.diagnostics()
  const warnings = host?.skins !== undefined
    ? host.skins
      .filter((skin) => skin.warnings.length > 0)
      .map((skin) => ({ id: skin.id, warnings: skin.warnings }))
    : (runtime.catalog() ?? [])
      .filter((skin) => skin.warnings.length > 0)
      .map((skin) => ({ id: skin.manifest.id, warnings: skin.warnings }))
  const transformFailures = (host?.transformFailures ?? []).map((failure) => ({
    skinId: failure.skinId,
    filename: failure.filename,
    error: failure.error,
    violations: failure.violations ?? [],
  }))
  return {
    stamped: adapter?.stamped ?? 0,
    neverMatched,
    invalidRules: adapter?.invalidRules ?? [],
    ledgerFailures,
    catalog,
    warnings,
    transformFailures,
  }
}

/** Whether the report names no problem on any axis. */
function isHealthy(report: SkinHealthReport): boolean {
  return report.neverMatched.length === 0
    && report.invalidRules.length === 0
    && report.ledgerFailures.length === 0
    && report.catalog.length === 0
    && report.warnings.length === 0
    && report.transformFailures.length === 0
}

/**
 * Live-label helper: the shown value follows the in-drag thumb immediately,
 * and falls back to the store value once the store settles (issue #725).
 */
function useLiveValue(value: number): [number, (v: number | null) => void] {
  const [live, setLive] = useState<number | null>(null)
  useEffect(() => {
    setLive(null)
  }, [value])
  return [live ?? value, setLive]
}

/**
 * Render the skin-center card: a static header naming the plugin, with the
 * always-visible skin list (official default + every installed skin; try-on /
 * theme preview / one-click apply) rendered below it.
 * @param props - card props.
 * @returns the plugin card.
 */
export function SkinCenter({ t, runtime, theme, background, wallpaper, preview, customTheme }: SkinCenterComponentProps) {
  const snapshot = useSyncExternalStore((listener) => theme.subscribe(listener), () => theme.getTheme())
  const enabled = useSyncExternalStore(background.subscribe, background.enabled)
  const opacity = useSyncExternalStore(background.subscribe, background.opacity)
  const blurEmpty = useSyncExternalStore(background.subscribe, background.blurEmpty)
  const blurContent = useSyncExternalStore(background.subscribe, background.blurContent)
  const inputCardBlur = useSyncExternalStore(background.subscribe, background.inputCardBlur)
  const bubbleOpacity = useSyncExternalStore(background.subscribe, background.bubbleOpacity)
  const bubbleBlur = useSyncExternalStore(background.subscribe, background.bubbleBlur)
  const [shownOpacity, setShownOpacity] = useLiveValue(opacity)
  const [shownBlurEmpty, setShownBlurEmpty] = useLiveValue(blurEmpty)
  const [shownBlurContent, setShownBlurContent] = useLiveValue(blurContent)
  const [shownInputCardBlur, setShownInputCardBlur] = useLiveValue(inputCardBlur)
  const [shownBubbleOpacity, setShownBubbleOpacity] = useLiveValue(bubbleOpacity)
  const [shownBubbleBlur, setShownBubbleBlur] = useLiveValue(bubbleBlur)
  const catalog = useSyncExternalStore(runtime.subscribe, runtime.catalog)
  const state = useSyncExternalStore(runtime.subscribe, runtime.controller.getState)
  const customThemeState = useSyncExternalStore(customTheme.subscribe, customTheme.getState)
  const activeId = state.active
  const previewing = state.previewing
  const tryingId = state.trying
  const activeEntry = activeId === null ? null : runtime.find(activeId)
  const backdropActive = activeEntry?.manifest.contributes.backgroundMedia !== undefined
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [verifySummary, setVerifySummary] = useState<{
    total: number
    valid: number
    issues: number
    repaired?: string[]
    repairFailed?: Array<{ id: string; error: string }>
  } | null>(null)
  const [verifyReports, setVerifyReports] = useState<Record<string, { status: string; hooksTrusted: boolean; mismatches: string[]; missing: string[] }>>({})
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null)
  const [uninstallingId, setUninstallingId] = useState<string | null>(null)
  // Skin health is collapsed by default and inert while collapsed: the host
  // snapshot is fetched on expand, and the runtime diagnostics are read only
  // while it is open (see the effect below).
  const [healthOpen, setHealthOpen] = useState(false)
  const [hostDiagnostics, setHostDiagnostics] = useState<HostDiagnostics | null>(null)
  // Unmount guard: once the card is gone, pending async completions must not
  // setState (the controller itself owns the skin state and lives on).
  const mounted = useRef(false)
  // Latest-click-wins token; a newer click invalidates older completions.
  const requestSeq = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Health data is read on expand only. Collapsing keeps the last snapshot but
  // stops all work; a collapsed card issues no request and maps no rule table.
  useEffect(() => {
    if (!healthOpen) return
    const seats = runtime as unknown as RuntimeDiagnosticSeats
    if (typeof seats.fetchImpl !== 'function' || typeof seats.apiBase !== 'string') return
    let cancelled = false
    void seats.fetchImpl(`${seats.apiBase}/diagnostics`)
      .then((res) => (res.ok ? res.json() as Promise<HostDiagnostics> : null))
      .then((payload) => {
        if (!cancelled && payload !== null && payload.ok === true) setHostDiagnostics(payload)
      })
      .catch(() => {
        // Fail-soft: the runtime's own catalog view still renders.
      })
    return () => { cancelled = true }
  }, [healthOpen, runtime])

  const health = healthOpen ? collectSkinHealth(runtime, hostDiagnostics) : null

  const run = (target: string, action: () => Promise<string | null>): void => {
    const seq = ++requestSeq.current
    setError(null)
    setBusyId(target)
    void action()
      .catch(() => {
        if (!mounted.current || seq !== requestSeq.current) return
        setError(t('applyFailed'))
      })
      .finally(() => {
        if (!mounted.current || seq !== requestSeq.current) return
        setBusyId(null)
      })
  }

  const tryOn = (entry: CatalogSkin): void => {
    run(entry.manifest.id, () => preview.runSkin(() => runtime.controller.tryOn(entry.manifest.id, entry)))
  }

  const tryOnOfficial = (): void => {
    run(OFFICIAL, () => preview.runSkin(() => runtime.controller.tryOn(null, null)))
  }

  const exitTryOn = (): void => {
    run(tryingId ?? OFFICIAL, () => preview.runSkin(() => runtime.controller.exitTryOn()))
  }

  const restoreCommittedSkin = async (state: { active: string | null }): Promise<void> => {
    const entry = state.active === null ? null : runtime.find(state.active)
    if (state.active !== null && entry === null) {
      throw new Error(`cannot restore skin ${state.active}`)
    }
    const restored = await runtime.controller.switchTo(state.active, entry)
    if (restored !== state.active) {
      throw new Error(`skin ${state.active ?? 'stock'} did not restore`)
    }
  }

  const switchAndDeactivateCustomTheme = async (
    target: string | null,
    entry: CatalogSkin | null,
  ): Promise<string | null> => {
    const previous = { ...runtime.controller.getState() }
    const active = await runtime.controller.switchTo(target, entry)
    if (active !== target) {
      throw new Error(`${target === null ? 'stock theme' : `skin ${target}`} did not activate`)
    }
    try {
      await customTheme.deactivate()
      return active
    } catch (error) {
      try {
        await restoreCommittedSkin(previous)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'skin switch cleanup and rollback failed')
      }
      throw error
    }
  }

  const restoreOfficialLook = async (): Promise<string | null> => {
    const active = await switchAndDeactivateCustomTheme(null, null)
    if (wallpaper.selection() !== '') wallpaper.clearSelection()
    return active
  }

  /**
   * One-click apply: atomic client-side switch + persisted selection. No
   * reload, no boot-graph wait — the tapIndex adapter makes the next page
   * load boot straight into this skin.
   * @param target - skin id, or `official` for the stock look.
   */
  const applySkin = (target: string): void => {
    if (target === OFFICIAL) {
      run(OFFICIAL, () => preview.runSkin(restoreOfficialLook))
      return
    }
    const entry = runtime.find(target)
    if (entry === null) {
      setError(t('applyFailed'))
      return
    }
    run(target, () => preview.runSkin(async () => {
      const active = await switchAndDeactivateCustomTheme(target, entry)
      if (wallpaper.selection() !== '') wallpaper.clearSelection()
      return active
    }))
  }

  const tryOnCustomTheme = (): void => {
    run('custom-theme', () => preview.runCustomTheme(async () => {
      const active = await runtime.controller.tryOn(null, null)
      if (active !== null) throw new Error('stock preview did not activate')
      customTheme.tryOn()
      return active
    }))
  }

  const exitCustomThemeTryOn = (): void => {
    run('custom-theme', () => preview.runCustomTheme(async () => {
      customTheme.exitTryOn()
      return await runtime.controller.exitTryOn()
    }))
  }

  const applyCustomTheme = (): void => {
    run('custom-theme', () => preview.runCustomTheme(async () => {
      await customTheme.apply()
      const active = await runtime.controller.switchTo(null, null)
      if (active !== null) {
        await customTheme.deactivate()
        throw new Error('stock theme did not activate')
      }
      return active
    }))
  }

  const handleVerify = async (): Promise<void> => {
    setVerifying(true)
    setError(null)
    try {
      const res = await fetch('/api/skin-center/v2/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRepair: true }),
      })
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean
        total?: number
        valid?: number
        issues?: number
        repaired?: string[]
        repairFailed?: Array<{ id: string; error: string }>
        details?: Array<{ id: string; status: string; hooksTrusted: boolean; mismatches: string[]; missing: string[] }>
      } | null
      if (!res.ok || json?.ok !== true) {
        throw new Error('verify failed')
      }
      if (!mounted.current) return
      setVerifySummary({
        total: json.total ?? 0,
        valid: json.valid ?? 0,
        issues: json.issues ?? 0,
        repaired: json.repaired ?? [],
        repairFailed: json.repairFailed ?? [],
      })
      const map: Record<string, { status: string; hooksTrusted: boolean; mismatches: string[]; missing: string[] }> = {}
      for (const item of json.details ?? []) {
        map[item.id] = item
      }
      setVerifyReports(map)
      if (json.repaired && json.repaired.length > 0) {
        await runtime.refreshCatalog()
        if (activeId && json.repaired.includes(activeId)) {
          const freshEntry = runtime.find(activeId)
          if (freshEntry) {
            await preview.runSkin(() => switchAndDeactivateCustomTheme(activeId, freshEntry))
          }
        }
      }
    } catch {
      if (mounted.current) setError(t('applyFailed'))
    } finally {
      if (mounted.current) setVerifying(false)
    }
  }

  const handleUninstall = async (entry: CatalogSkin): Promise<void> => {
    const id = entry.manifest.id
    setUninstallingId(id)
    setError(null)
    try {
      if (tryingId === id) {
        await preview.runSkin(() => runtime.controller.exitTryOn())
      }
      if (activeId === id) {
        await preview.runSkin(restoreOfficialLook)
      }
      const res = await fetch(`/api/skin-center/v2/skins/${encodeURIComponent(id)}/uninstall`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null
      if (!res.ok || json?.ok !== true) {
        throw new Error('uninstall failed')
      }
      await runtime.refreshCatalog()
      if (mounted.current) setConfirmUninstallId(null)
    } catch {
      if (mounted.current) setError(t('uninstallFailed'))
    } finally {
      if (mounted.current) setUninstallingId(null)
    }
  }

  const dark = document.body.hasAttribute('data-ds-dark-theme')

  /**
   * One health group: a localized header carrying the exact count, the first
   * HEALTH_ITEMS_MAX rows, and a localized remainder note. An empty group
   * renders nothing at all, so a healthy axis costs no DOM.
   */
  const healthGroup = (key: SkinCenterKey, items: ReactNode[]): ReactNode => {
    if (items.length === 0) return null
    return (
      <div className={css.healthGroup}>
        <div className={css.healthGroupTitle}>{t(key, { count: items.length })}</div>
        <ul className={css.healthList}>
          {items.slice(0, HEALTH_ITEMS_MAX).map((item, index) => (
            <li key={index} className={css.healthItem}>{item}</li>
          ))}
        </ul>
        {items.length > HEALTH_ITEMS_MAX && (
          <div className={css.healthMore}>{t('healthMore', { count: items.length - HEALTH_ITEMS_MAX })}</div>
        )}
      </div>
    )
  }

  /** One row: try-on control + apply button + optional uninstall. Shared by the official card and every skin card. */
  const actionButtons = (opts: {
    key: string
    entry?: CatalogSkin
    isActive: boolean
    isTrying: boolean
    onTryOn: () => void
    applyLabel: string
  }): ReactNode => {
    const isUser = opts.entry?.origin === 'user'
    const isConfirming = isUser && confirmUninstallId === opts.key
    return (
      <div className={css.actions}>
        {opts.isActive && !opts.isTrying ? (
          <button type="button" className={`${css.button} ${css.buttonGhost}`} disabled>
            {t('tryOn')}
          </button>
        ) : opts.isTrying ? (
          <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={busyId !== null || uninstallingId !== null} onClick={exitTryOn}>
            {t('exitTryOn')}
          </button>
        ) : (
          <button
            type="button"
            className={`${css.button} ${css.buttonPrimary}`}
            disabled={busyId !== null || uninstallingId !== null}
            onClick={opts.onTryOn}
          >
            {busyId === opts.key ? t('loading') : t('tryOn')}
          </button>
        )}
        <button
          type="button"
          className={css.button}
          disabled={busyId !== null || uninstallingId !== null}
          onClick={() => { applySkin(opts.key) }}
        >
          {busyId === opts.key ? t('applying') : opts.applyLabel}
        </button>
        {isUser && (
          isConfirming ? (
            <>
              <button
                type="button"
                className={`${css.button} ${css.buttonDangerConfirm}`}
                disabled={busyId !== null || uninstallingId !== null}
                onClick={() => { if (opts.entry) void handleUninstall(opts.entry) }}
              >
                {uninstallingId === opts.key ? t('uninstalling') : t('confirm')}
              </button>
              <button
                type="button"
                className={css.button}
                disabled={uninstallingId !== null}
                onClick={() => { setConfirmUninstallId(null) }}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${css.button} ${css.buttonDanger}`}
              disabled={busyId !== null || uninstallingId !== null}
              onClick={() => { setConfirmUninstallId(opts.key) }}
            >
              {t('uninstall')}
            </button>
          )
        )}
      </div>
    )
  }

  return (
    <li className={css.pluginCard}>
      <div className={css.cardHeaderStatic}>
        <span className={css.headText}>
          <span className={css.pluginName}>
            {t('title')}
            <span className={css.titleBadge}>{String(catalog?.length ?? 0)}</span>
          </span>
          <span className={css.cardDescription} title={t('cardDescription')}>{t('cardDescription')}</span>
        </span>
      </div>

      <div className={css.cardBody}>
            <div className={css.enableRow}>
              <span className={css.enableLabel} title={t('enabled')}>{t('enabled')}</span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label={t('enabled')}
                className={enabled ? css.switch + ' ' + css.switchOn : css.switch}
                onClick={() => { background.setEnabled(!enabled) }}
              >
                <span className={css.switchThumb} />
              </button>
              <p className={css.enableHint}>{t('enabledHint')}</p>
            </div>
            {enabled
              ? (
                <>
                  <div className={css.head}>
                    <div className={css.intro} title={t('intro')}>{t('intro')}</div>
                    <div className={css.toolbar}>
                      <div className={css.themeRow}>
                        <span className={css.themeLabel}>{t('theme')}</span>
                        <button
                          type="button"
                          className={`${css.themeButton} ${dark ? '' : css.themeButtonActive}`}
                          onClick={() => { theme.setTheme('light') }}
                        >
                          {t('themeLight')}
                        </button>
                        <button
                          type="button"
                          className={`${css.themeButton} ${dark ? css.themeButtonActive : ''}`}
                          onClick={() => { theme.setTheme('dark') }}
                        >
                          {t('themeDark')}
                        </button>
                      </div>
                      <button
                        type="button"
                        className={css.themeButton}
                        disabled={verifying || busyId !== null || uninstallingId !== null}
                        onClick={() => { void handleVerify() }}
                      >
                        {verifying ? t('verifyingIntegrity') : t('verifyIntegrity')}
                      </button>
                    </div>
                    {verifySummary !== null && (
                      <div className={`${css.verifySummary} ${verifySummary.issues === 0 ? css.verifySummarySuccess : css.verifySummaryWarning}`}>
                        {verifySummary.repaired && verifySummary.repaired.length > 0 && verifySummary.issues === 0
                          ? t('verifyRepaired', { count: verifySummary.repaired.length })
                          : verifySummary.issues === 0
                          ? t('verifyAllPassed', { count: verifySummary.total })
                          : verifySummary.repaired && verifySummary.repaired.length > 0
                          ? `${t('verifyRepaired', { count: verifySummary.repaired.length })}, ${t('verifyFoundIssues', { count: verifySummary.issues })}`
                          : t('verifyFoundIssues', { count: verifySummary.issues })}
                      </div>
                    )}
                  </div>

                  <div className={css.backgroundRow}>
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('backgroundOpacity')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownOpacity}%</span>
                    </div>
                                        <SliderControl
                      id="skin-center-background-opacity"
                      className={css.backgroundRange}
                      min={0}
                      max={100}
                      step={5}
                      value={opacity}
                      ariaValuetext={shownOpacity + '%'}
                      ariaLabel={t('backgroundOpacity')}
                      onChanging={setShownOpacity}
                      onChange={(value) => { background.set(value) }}
                    />
                    <p className={backdropActive ? css.backgroundHint : css.backgroundHintMuted}>
                      {backdropActive ? t('backgroundHint') : t('backgroundHintInert')}
                    </p>
                  </div>
                  <div className={css.backgroundRow}>
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('backgroundBlurEmpty')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownBlurEmpty}px</span>
                    </div>
                                        <SliderControl
                      id="skin-center-background-blur-empty"
                      className={css.backgroundRange}
                      min={0}
                      max={20}
                      step={1}
                      value={blurEmpty}
                      ariaValuetext={shownBlurEmpty + 'px'}
                      ariaLabel={t('backgroundBlurEmpty')}
                      onChanging={setShownBlurEmpty}
                      onChange={(value) => { background.setBlurEmpty(value) }}
                    />
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('backgroundBlurContent')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownBlurContent}px</span>
                    </div>
                                        <SliderControl
                      id="skin-center-background-blur-content"
                      className={css.backgroundRange}
                      min={0}
                      max={20}
                      step={1}
                      value={blurContent}
                      ariaValuetext={shownBlurContent + 'px'}
                      ariaLabel={t('backgroundBlurContent')}
                      onChanging={setShownBlurContent}
                      onChange={(value) => { background.setBlurContent(value) }}
                    />
                    <p className={backdropActive ? css.backgroundHint : css.backgroundHintMuted}>
                      {backdropActive ? t('backgroundBlurHint') : t('backgroundBlurInert')}
                    </p>
                  </div>


                  <div className={css.backgroundRow}>
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('inputCardBlur')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownInputCardBlur}px</span>
                    </div>
                                        <SliderControl
                      id="skin-center-input-card-blur"
                      className={css.backgroundRange}
                      min={0}
                      max={20}
                      step={1}
                      value={inputCardBlur}
                      ariaValuetext={shownInputCardBlur + 'px'}
                      ariaLabel={t('inputCardBlur')}
                      onChanging={setShownInputCardBlur}
                      onChange={(value) => { background.setInputCardBlur(value) }}
                    />
                    <p className={css.backgroundHint}>{t('inputCardBlurHint')}</p>
                  </div>

                  <div className={css.backgroundRow}>
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('bubbleOpacity')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownBubbleOpacity}%</span>
                    </div>
                                        <SliderControl
                      id="skin-center-bubble-opacity"
                      className={css.backgroundRange}
                      min={0}
                      max={100}
                      step={5}
                      value={bubbleOpacity}
                      ariaValuetext={shownBubbleOpacity + '%'}
                      ariaLabel={t('bubbleOpacity')}
                      onChanging={setShownBubbleOpacity}
                      onChange={(value) => { background.setBubbleOpacity(value) }}
                    />
                    <p className={css.backgroundHint}>{t('bubbleOpacityHint')}</p>
                  </div>

                  <div className={css.backgroundRow}>
                    <div className={css.backgroundHead}>
                      <span className={css.backgroundLabel}>{t('bubbleBlur')}</span>
                      <span className={css.backgroundValue} aria-hidden="true">{shownBubbleBlur}px</span>
                    </div>
                    <SliderControl
                      id="skin-center-bubble-blur"
                      className={css.backgroundRange}
                      min={0}
                      max={20}
                      step={1}
                      value={bubbleBlur}
                      ariaValuetext={shownBubbleBlur + 'px'}
                      ariaLabel={t('bubbleBlur')}
                      onChanging={setShownBubbleBlur}
                      onChange={(value) => { background.setBubbleBlur(value) }}
                    />
                    <p className={css.backgroundHint}>{t('bubbleBlurHint')}</p>
                  </div>

                  <WallpaperPanel t={t} wallpaper={wallpaper} />

                  {error !== null && <div className={css.error}>{error}</div>}

                  <div className={css.list}>
                    {(() => {
                      const isActive = activeId === null && !previewing && !customThemeState.applied
                      const isTrying = previewing && tryingId === null && !customThemeState.previewing
                      const badge = isActive ? t('active') : isTrying ? t('tryingOn') : null
                      return (
                        <div className={css.card} key={OFFICIAL}>
                          <div className={css.cardHead}>
                            <span className={css.swatch} style={{ background: '#98a1ab' }} aria-hidden="true" />
                            <span className={css.cardName} title={t('official')}>{t('official')}</span>
                            {badge !== null && (
                              <span className={`${css.badge} ${isActive ? css.badgeActive : css.badgeTrying}`}>
                                {badge}
                              </span>
                            )}
                          </div>
                          <div className={css.cardTagline} title={t('officialTagline')}>{t('officialTagline')}</div>
                          {actionButtons({
                            key: OFFICIAL,
                            isActive,
                            isTrying,
                            onTryOn: tryOnOfficial,
                            applyLabel: t('restore'),
                          })}
                        </div>
                      )
                    })()}

                    {(catalog ?? []).map(entry => {
                      const id = entry.manifest.id
                      const isActive = id === activeId && !previewing
                      const isTrying = previewing && id === tryingId
                      const badge = isActive ? t('active') : isTrying ? t('tryingOn') : null
                      const report = verifyReports[id]
                      return (
                        <div className={css.card} key={id}>
                          <div className={css.cardHead}>
                            <span
                              className={css.swatch}
                              style={{ background: entry.manifest.accent ?? '#98a1ab' }}
                              aria-hidden="true"
                            />
                            <span className={css.cardName} title={entry.manifest.nameEn}>{entry.manifest.nameEn}</span>
                            {report && (
                              <span
                                className={`${css.badge} ${
                                  report.status === 'valid'
                                    ? css.badgeSuccess
                                    : report.status === 'tampered'
                                    ? css.badgeWarning
                                    : css.badgeDanger
                                }`}
                                title={
                                  report.status === 'valid'
                                    ? t('integrityValid')
                                    : [...report.mismatches, ...report.missing].join(', ') || report.status
                                }
                              >
                                {report.status === 'valid'
                                  ? t('integrityValid')
                                  : report.status === 'tampered'
                                  ? t('integrityTampered')
                                  : report.status === 'missing-files'
                                  ? t('integrityMissing')
                                  : t('integrityHooksRefused')}
                              </span>
                            )}
                            {badge !== null && (
                              <span className={`${css.badge} ${isActive ? css.badgeActive : css.badgeTrying}`}>
                                {badge}
                              </span>
                            )}
                          </div>
                          <div className={css.cardTagline} title={entry.manifest.tagline ?? ''}>
                            {entry.manifest.tagline ?? ''}
                          </div>
                          {report && report.status !== 'valid' && (
                            <div className={css.integrityNote}>
                              {[
                                report.mismatches.length > 0 ? `${t('integrityTampered')}: ${report.mismatches.join(', ')}` : null,
                                report.missing.length > 0 ? `${t('integrityMissing')}: ${report.missing.join(', ')}` : null,
                              ].filter(Boolean).join(' | ')}
                            </div>
                          )}
                          {actionButtons({
                            key: id,
                            entry,
                            isActive,
                            isTrying,
                            onTryOn: () => { tryOn(entry) },
                            applyLabel: t('apply'),
                          })}
                        </div>
                      )
                    })}

                    <CustomThemeCard
                      t={t}
                      customTheme={customTheme}
                      scheme={dark ? 'dark' : 'light'}
                      setScheme={scheme => { theme.setTheme(scheme) }}
                      isActive={customThemeState.applied && activeId === null && !previewing}
                      isTrying={customThemeState.previewing}
                      busy={busyId === 'custom-theme'}
                      disabled={busyId !== null}
                      onTryOn={tryOnCustomTheme}
                      onExitTryOn={exitCustomThemeTryOn}
                      onApply={applyCustomTheme}
                    />
                  </div>

                  <div className={css.health}>
                    <button
                      type="button"
                      className={css.healthToggle}
                      aria-expanded={healthOpen}
                      onClick={() => { setHealthOpen(!healthOpen) }}
                    >
                      <span
                        className={healthOpen ? `${css.healthCaret} ${css.healthCaretOpen}` : css.healthCaret}
                        aria-hidden="true"
                      />
                      <span className={css.healthTitle}>{t('healthTitle')}</span>
                      <span className={css.healthHint}>{healthOpen ? t('healthCollapse') : t('healthExpand')}</span>
                    </button>
                    {health !== null && (
                      <div className={css.healthBody}>
                        <div className={css.healthSummary}>{t('healthStamped', { count: health.stamped })}</div>
                        {isHealthy(health)
                          ? <div className={css.healthEmpty} role="status">{t('healthEmpty')}</div>
                          : (
                            <>
                              {healthGroup('healthAdapterRules', health.neverMatched.map((rule) => (
                                <code className={css.healthCode}>{rule.selector}</code>
                              )))}
                              {healthGroup('healthInvalidRules', health.invalidRules.map((selector) => (
                                <code className={css.healthCode}>{selector}</code>
                              )))}
                              {healthGroup('healthLedgerFailures', health.ledgerFailures.map((label) => (
                                <code className={css.healthCode}>{label}</code>
                              )))}
                              {healthGroup('healthCatalogDiagnostics', health.catalog.map((item) => (
                                <span>
                                  <code className={css.healthCode}>{item.subject}</code>
                                  {` (${item.origin}): ${item.errors.join(' | ')}`}
                                </span>
                              )))}
                              {healthGroup('healthSkinWarnings', health.warnings.map((item) => (
                                <span>
                                  <code className={css.healthCode}>{item.id}</code>
                                  {`: ${item.warnings.join(' | ')}`}
                                </span>
                              )))}
                              {healthGroup('healthTransformFailures', health.transformFailures.map((failure) => (
                                <span>
                                  <code className={css.healthCode}>{`${failure.skinId}/${failure.filename}`}</code>
                                  {`: ${[failure.error, ...failure.violations].join(' | ')}`}
                                </span>
                              )))}
                            </>
                          )}
                      </div>
                    )}
                  </div>
                </>
              )
              : (
                <p className={css.offNote} role="status">{t('offNote')}</p>
              )}
          </div>
    </li>
  )
}

/** Props the settings section binds for the skin-center card page. */
export type SkinCenterSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'skinCenter'>
  & SkinCenterInjected

/** Render the skin-center card as a first-level settings page. */
export function SkinCenterSection(props: SkinCenterSectionProps): ReactNode {
  const { t, runtime, theme, background, wallpaper, preview, customTheme } = props
  return (
    <ul className={css.sectionList}>
      <SkinCenter
        t={t}
        runtime={runtime}
        theme={theme}
        background={background}
        wallpaper={wallpaper}
        preview={preview}
        customTheme={customTheme}
      />
    </ul>
  )
}
