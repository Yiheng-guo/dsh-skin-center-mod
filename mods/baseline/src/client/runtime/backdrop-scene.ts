/**
 * Unified "backdrop visible" scene marker (issue #777).
 *
 * A skin with painted background media or a mounted Wallpaper Engine
 * wallpaper both put real backdrop art behind the app. The two runtime
 * controllers (skin-controller and wallpaper) report their mount state
 * through setSceneBackdropActive(); this module folds them into ONE body /
 * html marker `data-dsh-backdrop-active` and installs the shared composer
 * seat neutralizer that keys on it.
 *
 * The shell's active composer seat paints a bottom occlusion gradient under
 * the sticky input card (rc.8: a linear gradient to --dsw-alias-bg-base,
 * z-index 7). Backdrop scenes intentionally remove that seat-wide gradient in
 * both active and hero phases so wallpaper art remains unobstructed down to the
 * viewport edge. Skin-provided seat-wide ::before masks are neutralized too.
 * Composer task/statistics surfaces are styled by the shared shell adapter
 * from skin theme tokens, not by this scene layer.
 *
 * The input card itself ([data-composer-card], the official shell's stable card
 * anchor) keeps its translucent tint and gains the configurable backdrop blur
 * (default INPUT_FROST_BLUR_PX).
 *
 * The card rule is enabled only while the conversation actually has message
 * content (data-dsh-conversation-content): an empty conversation has no正文 to
 * occlude, so the input keeps its normal hero appearance without a frost flash.
 * The strength is provided by --dsh-input-card-blur and falls back to the
 * compatibility default when the setting has not loaded yet.
 *
 * The marker is body/html level (managed outside the surface/part/plugin
 * enum, see contracts/semantic-attrs-v1.md) and survives a neutralizer
 * teardown; the style is inert whenever the marker is absent.
 * @module @linxin666/dsh-client-ui-skin-center/runtime/backdrop-scene
 */

/** Shared marker: set on html + body while a source reports backdrop art. */
export const BACKDROP_ACTIVE_ATTR = 'data-dsh-backdrop-active'

/** The shared composer-seat neutralizer style's own attribute. */
export const SCENE_NEUTRALIZER_ATTR = 'data-dsh-scene-neutralizer'

/**
 * Attribute of the composer frost follower: a body-level, fixed, empty element
 * sized to the input card's border box while a scene is active.
 *
 * It exists because the frost must NOT be painted on the card. A non-none
 * backdrop-filter (like transform, filter, contain or perspective) makes an
 * element the CONTAINING BLOCK for its fixed-position descendants, and the
 * official shell renders its tooltips inside the composer card: the composer
 * send arrow's bubble is position: fixed, so with the frost on the card it
 * resolved its viewport coordinates against the card, landed far outside it
 * but still inside the conversation scrollport, added its own height to
 * scrollHeight, and every hover clamped the scroll to the new bottom — the
 * whole conversation jumped by hundreds of pixels and snapped back on the
 * next frame (issue #1724). Documented throughout the catalog skins as the
 * reason a card ancestor never carries a filter.
 *
 * A body-level sibling is not an ancestor of the card, so it may carry the
 * blur; because nested backdrop-filters do not compose, the card itself must
 * stay filter-free for the follower's blur to read through its translucent
 * fill. The element is empty and pointer-events:none, and it is a sibling of
 * the app root, never inside the scrollport.
 */
export const COMPOSER_FROST_ATTR = 'data-dsh-composer-frost'

/** Stacking rung of the follower: above the skin art layers, below the shell. */
const COMPOSER_FROST_Z_INDEX = '-1'

/** Conversation-content marker: set while the active conversation has rows. */
export const CONVERSATION_CONTENT_ATTR = 'data-dsh-conversation-content'

/**
 * Stable shell scrollport scoped row selectors. Official builds emit the chat
 * anchor; the CSS-module suffix fallbacks retain compatibility with older
 * shells without returning to a body-wide topic/session query.
 */
const ACTIVE_CONVERSATION_CONTENT_SELECTOR = [
  '[data-conversation-scroll] [data-chat-anchor-key]',
  '[data-conversation-scroll] [class*="_userRow"]',
  '[data-conversation-scroll] [class*="_compactionRow"]',
  '[data-conversation-scroll] [class*="_contextRow"]',
  '[data-conversation-scroll] [class*="_turnErrorRow"]',
].join(', ')

/** One source that can make backdrop art visible. */
export type BackdropSource = 'skin' | 'wallpaper'

/** Compatibility default for the input-card backdrop blur strength (px). */
export const INPUT_FROST_BLUR_PX = 10

const sourceSets = new WeakMap<Document, Set<BackdropSource>>()
const contentObservers = new WeakMap<Document, MutationObserver>()
const contentFrames = new WeakMap<Document, number>()

/** Write a marker attribute only when the desired state is not applied yet. */
function applyMarker(el: Element | null, attr: string, active: boolean): void {
  if (el === null) return
  if (active) {
    if (el.getAttribute(attr) !== 'true') el.setAttribute(attr, 'true')
    return
  }
  if (el.hasAttribute(attr)) el.removeAttribute(attr)
}

/**
 * Report one source's backdrop-art presence. The marker stays on while any
 * source is active, so the skin and wallpaper controllers never clobber each
 * other across their mount/unmount cycles.
 */
export function setSceneBackdropActive(doc: Document, source: BackdropSource, active: boolean): void {
  let sources = sourceSets.get(doc)
  if (sources === undefined) {
    sources = new Set()
    sourceSets.set(doc, sources)
  }
  if (active) sources.add(source)
  else sources.delete(source)
  syncMarker(doc, sources)
}

/** Reflect the source set onto html/body and ensure the neutralizer on use. */
function syncMarker(doc: Document, sources: Set<BackdropSource>): void {
  const active = sources.size > 0
  applyMarker(doc.body, BACKDROP_ACTIVE_ATTR, active)
  applyMarker(doc.documentElement, BACKDROP_ACTIVE_ATTR, active)
  if (active) {
    ensureSceneNeutralizer(doc)
    startContentObserver(doc)
  } else {
    stopContentObserver(doc)
  }
  // The frost gate is the marker pair, so every path that changes either one
  // re-evaluates it: a scene mount/unmount, and the conversation-content flip
  // the observer above reports.
  syncComposerFrost(doc)
}

/**
 * Track whether the active conversation scrollport has message rows for the
 * frost gate. Topic pickers and outgoing session trees can retain their own
 * data-chat-anchor-key nodes during a switch; a body-wide query would count
 * those stale rows and flash the composer frost over the new empty topic.
 */
function updateConversationContent(doc: Document): void {
  const has = doc.body !== null && doc.body.querySelector(ACTIVE_CONVERSATION_CONTENT_SELECTOR) !== null
  applyMarker(doc.body, CONVERSATION_CONTENT_ATTR, has)
  applyMarker(doc.documentElement, CONVERSATION_CONTENT_ATTR, has)
  // The composer frost is gated on this marker, so the flip must reach it.
  syncComposerFrost(doc)
}

/**
 * Coalesce the mutation bursts of a streaming conversation into one content
 * check per frame; a check scheduled for a document that stopped observing is
 * dropped so a late frame can never re-add the marker after teardown.
 */
function scheduleConversationContent(doc: Document): void {
  if (contentFrames.has(doc)) return
  const win = doc.defaultView
  if (win === null || typeof win.requestAnimationFrame !== 'function') {
    updateConversationContent(doc)
    return
  }
  contentFrames.set(doc, win.requestAnimationFrame(() => {
    contentFrames.delete(doc)
    if (!contentObservers.has(doc)) return
    updateConversationContent(doc)
  }))
}

/** Observe the conversation tree while a backdrop is visible. */
function startContentObserver(doc: Document): void {
  if (contentObservers.has(doc)) return
  updateConversationContent(doc)
  const win = doc.defaultView
  if (win === null || typeof win.MutationObserver !== 'function') return
  const observer = new win.MutationObserver(() => scheduleConversationContent(doc))
  observer.observe(doc.body ?? doc.documentElement, { childList: true, subtree: true })
  contentObservers.set(doc, observer)
}

/** Stop the content observer, cancel pending work and drop the marker. */
function stopContentObserver(doc: Document): void {
  const frame = contentFrames.get(doc)
  if (frame !== undefined) {
    const win = doc.defaultView
    if (win !== null && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(frame)
    contentFrames.delete(doc)
  }
  const observer = contentObservers.get(doc)
  if (observer !== undefined) {
    observer.disconnect()
    contentObservers.delete(doc)
  }
  applyMarker(doc.body, CONVERSATION_CONTENT_ATTR, false)
  applyMarker(doc.documentElement, CONVERSATION_CONTENT_ATTR, false)
  syncComposerFrost(doc)
}

/**
 * Install the shared composer-seat neutralizer, keyed by head presence so a
 * cleared head (tests) or a re-mount re-creates it. Without the marker the
 * rules are inert, so the style can outlive a single mount without changing
 * any other look.
 *
 * The composer card is deliberately absent from this sheet: its frost rides
 * {@link COMPOSER_FROST_ATTR} instead, because no rule here may put a
 * containing-block property back on the card (issue #1724).
 */
export function ensureSceneNeutralizer(doc: Document): void {
  if (doc.head === null) return
  if (doc.head.querySelector(`style[${SCENE_NEUTRALIZER_ATTR}]`) !== null) return
  const style = doc.createElement('style')
  style.setAttribute(SCENE_NEUTRALIZER_ATTR, '')
  style.textContent = `
    html[data-dsh-backdrop-active] [data-composer-seat],
    html[data-dsh-backdrop-active] [data-composer-seat]::before {
      background: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    html[data-dsh-backdrop-active][data-dsh-conversation-content] [${COMPOSER_FROST_ATTR}] {
      backdrop-filter: blur(var(--dsh-input-card-blur, ${INPUT_FROST_BLUR_PX}px)) !important;
      -webkit-backdrop-filter: blur(var(--dsh-input-card-blur, ${INPUT_FROST_BLUR_PX}px)) !important;
    }
  `
  doc.head.appendChild(style)
}

/** One observed document's frost follower: the element and its measure loop. */
interface FrostFollower {
  el: HTMLElement
  resizeObserver: ResizeObserver | null
  /** The card the resize observer currently watches (a switch replaces it). */
  observed: Element | null
  /** Viewport listener: a window resize moves the card without any mutation. */
  onResize: (() => void) | null
  frame: number | null
  /** Last applied border box, so an unchanged frame writes nothing. */
  applied: string
}

const frostFollowers = new WeakMap<Document, FrostFollower>()

/** The composer card the frost tracks, or null while none is mounted. */
function composerCardOf(doc: Document): HTMLElement | null {
  return doc.body === null ? null : doc.body.querySelector<HTMLElement>('[data-composer-card]')
}

/**
 * Create the follower on first use and keep it sized to the composer card.
 *
 * The element is empty, fixed and inert: it paints nothing of its own, and it
 * receives no pointer events, so it can never take a tap from the composer or
 * the sidebar. Sizing uses one measure per animation frame (the shape
 * shell-rendering.ts uses for the composer height) rather than a per-mutation
 * read, and writes only when the box actually changed.
 */
function syncFrostFollower(doc: Document): void {
  const follower = frostFollowers.get(doc)
  if (follower === undefined) return
  const card = composerCardOf(doc)
  if (card === null) return
  // A conversation switch replaces the composer card; move the observation to
  // the node we now track (this runs inside the coalesced content check).
  if (follower.observed !== card) {
    if (follower.observed !== null) follower.resizeObserver?.unobserve(follower.observed)
    follower.observed = card
    follower.resizeObserver?.observe(card)
    follower.applied = ''
  }
  const rect = card.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  // The follower paints the card's own shape, including a skin's radius
  // override, so the blurred region never reads as a rectangle behind a
  // rounded card. Read per apply: a skin may change it after mount.
  const radius = doc.defaultView?.getComputedStyle(card).borderRadius ?? ''
  const box = [rect.top, rect.left, rect.width, rect.height, radius]
    .map((value) => typeof value === 'number' ? Math.round(value) : value)
    .join('|')
  if (box === follower.applied) return
  follower.applied = box
  const style = follower.el.style
  style.top = `${Math.round(rect.top)}px`
  style.left = `${Math.round(rect.left)}px`
  style.width = `${Math.round(rect.width)}px`
  style.height = `${Math.round(rect.height)}px`
  style.borderRadius = radius
}

/** Coalesce a burst of geometry changes into one measurement per frame. */
function scheduleFrostSync(doc: Document): void {
  const follower = frostFollowers.get(doc)
  if (follower === undefined || follower.frame !== null) return
  const win = doc.defaultView
  if (win === null || typeof win.requestAnimationFrame !== 'function') {
    syncFrostFollower(doc)
    return
  }
  follower.frame = win.requestAnimationFrame(() => {
    follower.frame = null
    if (!frostFollowers.has(doc)) return
    syncFrostFollower(doc)
  })
}

/** Mount the follower while a scene is visible and start tracking the card. */
function startFrostFollower(doc: Document): void {
  if (frostFollowers.has(doc) || doc.body === null) return
  const el = doc.createElement('div')
  el.setAttribute(COMPOSER_FROST_ATTR, '')
  el.setAttribute('aria-hidden', 'true')
  const style = el.style
  style.position = 'fixed'
  style.pointerEvents = 'none'
  style.zIndex = COMPOSER_FROST_Z_INDEX
  style.borderRadius = 'inherit'
  const follower: FrostFollower = { el, resizeObserver: null, observed: null, onResize: null, frame: null, applied: '' }
  // A body-level sibling, appended after the app root so the shell's own
  // layers (and any skin decoration) keep their place; the rung above decides
  // paint order, not the append position.
  doc.body.appendChild(el)
  frostFollowers.set(doc, follower)
  const win = doc.defaultView
  if (win !== null && typeof win.ResizeObserver === 'function') {
    follower.resizeObserver = new win.ResizeObserver(() => scheduleFrostSync(doc))
  }
  if (win !== null && typeof win.addEventListener === 'function') {
    follower.onResize = () => scheduleFrostSync(doc)
    win.addEventListener('resize', follower.onResize)
  }
  syncFrostFollower(doc)
}

/** Remove the follower and stop every loop that fed it. */
function stopFrostFollower(doc: Document): void {
  const follower = frostFollowers.get(doc)
  if (follower === undefined) return
  frostFollowers.delete(doc)
  const win = doc.defaultView
  // Cancel whatever is queued BEFORE the element goes: a frame that still held
  // a reference would otherwise re-apply a box to a detached node.
  if (follower.frame !== null && win !== null && typeof win.cancelAnimationFrame === 'function') {
    win.cancelAnimationFrame(follower.frame)
    follower.frame = null
  }
  follower.resizeObserver?.disconnect()
  follower.resizeObserver = null
  if (follower.onResize !== null) {
    win?.removeEventListener('resize', follower.onResize)
    follower.onResize = null
  }
  follower.el.remove()
}

/**
 * Attach the composer frost to the current scene state. Called from the shared
 * marker sync so the follower exists exactly while a backdrop is visible and
 * the conversation has content — the same gate the card's old frost rule used.
 *
 * The follower tracks the card through a ResizeObserver on the card itself and
 * one interval-free re-schedule on every re-mount, so a conversation switch
 * that replaces the composer keeps the frost aligned without a polling loop.
 */
export function syncComposerFrost(doc: Document): void {
  const wanted = doc.body !== null && doc.body.hasAttribute(BACKDROP_ACTIVE_ATTR)
    && doc.body.hasAttribute(CONVERSATION_CONTENT_ATTR)
  if (!wanted) {
    stopFrostFollower(doc)
    return
  }
  startFrostFollower(doc)
}
