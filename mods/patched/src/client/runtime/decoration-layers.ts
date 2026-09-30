/**
 * Fixed decoration layers (issue #506, contract section 6).
 *
 * Six skin-center-owned, non-interactive containers mounted once per
 * document (component scope): background / ambient / top / bottom / sidebar /
 * foreground. Skins fill them per activation (background media, scrims,
 * strips); the CONTENT is activation scope — on every switch the controller
 * replaces it through the effect ledger.
 *
 * Guarantees:
 *  - pointer-events: none always (decoration must never eat clicks);
 *  - the layer elements themselves survive skin switches, reloads of the
 *    skin runtime, and HMR (ensure* is idempotent);
 *  - stacking stays below the official shell overlay: background/ambient sit
 *    behind the app, the strip/foreground layers use moderate z-indices that
 *    lose to dialogs/overlays (official overlay paints above 1000);
 *  - the background layer carries its own compositor layer (will-change:
 *    transform): a full-viewport skin background image is expensive to
 *    re-rasterize, and without isolation Chromium re-rasterizes it in
 *    horizontal bands whenever unrelated repaint bursts (streaming chat,
 *    animated pets, overlay menus) invalidate the same area — visible as
 *    vertical band flicker (issue #1013).
 * @module @linxin666/dsh-client-ui-skin-center/runtime/decoration-layers
 */

export const DECORATION_LAYER_NAMES = [
  'background',
  'ambient',
  'top',
  'bottom',
  'sidebar',
  'foreground',
] as const

export type DecorationLayerName = (typeof DECORATION_LAYER_NAMES)[number]

export type DecorationLayers = Record<DecorationLayerName, HTMLElement>

const LAYER_ATTR = 'data-dsh-skin-layer'

/**
 * Per-layer paint order. The background sits at -2: negative z-index
 * elements paint ABOVE the html/body backgrounds (so a skin's own opaque
 * root background-color renders BEHIND its art — the v1 layering) yet below
 * every panel surface. It shares -2 with the WE scrim, which never paints
 * at the same time (an active WE wallpaper suppresses skin media, enforced
 * by the controller). The skin-background blur veil (-1) still samples the
 * art above it. Ambient effects paint above the veils; the strip/foreground
 * layers stay below the official overlay band (>=1000).
 */
const LAYER_STYLE: Record<DecorationLayerName, string> = {
  // Explicit longhands only: the inset shorthand has burned us once (a
  // mid-session layer lost its bottom edge), longhands parse everywhere.
  background: 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:-2;pointer-events:none;will-change:transform;',
  ambient: 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:30;pointer-events:none;',
  top: 'position:fixed;top:0;left:0;right:0;z-index:40;pointer-events:none;',
  bottom: 'position:fixed;bottom:0;left:0;right:0;z-index:40;pointer-events:none;',
  sidebar: 'position:fixed;top:0;bottom:0;left:0;z-index:40;pointer-events:none;',
  foreground: 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:41;pointer-events:none;',
}

function ensureOne(doc: Document, name: DecorationLayerName): HTMLElement {
  const existing = doc.querySelector<HTMLElement>(`[${LAYER_ATTR}="${name}"]`)
  if (existing) {
    // Never trust a previous writer's styles: re-assert invariants.
    existing.style.cssText = LAYER_STYLE[name]
    return existing
  }
  const el = doc.createElement('div')
  el.setAttribute(LAYER_ATTR, name)
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText = LAYER_STYLE[name]
  doc.body.appendChild(el)
  return el
}

/**
 * Ensure all six layers exist and return their handles. Idempotent; safe to
 * call on every activation.
 */
export function ensureDecorationLayers(doc: Document): DecorationLayers {
  return {
    background: ensureOne(doc, 'background'),
    ambient: ensureOne(doc, 'ambient'),
    top: ensureOne(doc, 'top'),
    bottom: ensureOne(doc, 'bottom'),
    sidebar: ensureOne(doc, 'sidebar'),
    foreground: ensureOne(doc, 'foreground'),
  }
}

/**
 * Replace one layer's content (activation scope). Returns a teardown that
 * removes exactly the nodes this call added — idempotent, ledger-ready.
 */
export function setLayerContent(
  layer: HTMLElement,
  nodes: Iterable<Node>,
): () => void {
  const added = [...nodes]
  for (const node of added) layer.appendChild(node)
  let done = false
  return () => {
    if (done) return
    done = true
    for (const node of added) node.parentNode?.removeChild(node)
  }
}

/**
 * Give the backdrop video a lifecycle policy: pause while the document is
 * hidden, and honour the viewer's motion preference by holding the artwork on
 * one frame instead of animating it.
 *
 * The wallpaper path already pauses on hidden (client/wallpaper.ts) and the
 * repository's own performance guidelines require it (R3, "frame loops and
 * infinite animations must pause when hidden"); the skin backdrop was the one
 * place still keeping a full-bleed loop decoding in a background window. The
 * motion-preference half is new: a looping video is precisely the sustained
 * animation `prefers-reduced-motion` exists for.
 */
function attachBackdropMediaPolicy(doc: Document, video: HTMLVideoElement): void {
  const motion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  const reduceMotion = (): boolean => motion?.matches === true
  let frozen = false

  /** Reduced motion: decode one frame, then hold it. */
  const freeze = (): void => {
    video.pause()
    if (frozen) return
    frozen = true
    video.autoplay = false
    video.loop = false
    // The still needs a decoded frame, which `metadata` alone will not produce.
    video.preload = 'auto'
    video.addEventListener('loadeddata', () => video.pause(), { once: true })
  }

  const sync = (): void => {
    if (reduceMotion()) {
      freeze()
      return
    }
    if (doc.hidden) {
      video.pause()
      return
    }
    // Muted media needs no gesture; a rejected play() (autoplay policy, decode
    // failure) must never surface as an unhandled rejection.
    void Promise.resolve(video.play()).catch(() => {})
  }

  const onVisibility = (): void => sync()
  const onMotion = (): void => sync()

  doc.addEventListener('visibilitychange', onVisibility)
  motion?.addEventListener?.('change', onMotion)
  sync()

  mediaPolicies.set(video, () => {
    doc.removeEventListener('visibilitychange', onVisibility)
    motion?.removeEventListener?.('change', onMotion)
    video.pause()
  })
}

/**
 * Teardown registered by background media that owns listeners (the backdrop
 * video's visibility and motion-preference handling). A WeakMap keeps the
 * policy out of the DOM and off the element's public shape.
 */
const mediaPolicies = new WeakMap<HTMLElement, () => void>()

/**
 * Remove every node an activation left in a layer (used on dispose).
 *
 * Media gets an explicit teardown before detach: a `<video>` that is merely
 * unparented keeps decoding in some browsers, and its listeners would outlive
 * the activation. Both are contract requirements (performance guidelines
 * R3/R6) that the wallpaper path already honours.
 */
export function clearLayer(layer: HTMLElement): void {
  while (layer.firstChild) {
    const child = layer.firstChild as HTMLElement
    const policy = mediaPolicies.get(child)
    if (policy !== undefined) {
      mediaPolicies.delete(child)
      policy()
    }
    if (child.tagName === 'VIDEO') (child as HTMLVideoElement).pause()
    layer.removeChild(child)
  }
}

/**
 * Build the background media element for a manifest backgroundMedia layer.
 * Returns null when the theme variant has no media. The element fills the
 * background layer; the scrim (when declared) is a sibling overlay.
 */
export function buildBackgroundMedia(
  doc: Document,
  layer: { type: 'image' | 'video'; src: string; scrim?: string },
  assetBase: string,
): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const fullBleed = 'position:absolute;top:0;right:0;bottom:0;left:0;width:100%;height:100%;object-fit:cover;'
  if (layer.type === 'image') {
    const img = doc.createElement('img')
    img.src = `${assetBase}/${layer.src}`
    img.alt = ''
    img.setAttribute('aria-hidden', 'true')
    img.style.cssText = fullBleed
    nodes.push(img)
  } else {
    const video = doc.createElement('video')
    video.src = `${assetBase}/${layer.src}`
    video.muted = true
    video.loop = true
    video.autoplay = true
    video.playsInline = true
    // Metadata only until the element is actually needed: a full-bleed loop can
    // be megabytes, and default `preload="auto"` pulls all of it before first
    // paint for a layer that may never become visible.
    video.preload = 'metadata'
    video.setAttribute('aria-hidden', 'true')
    // A stable hook so patches.css and third parties can find the backdrop
    // without guessing at layer indices or hash class names.
    video.setAttribute('data-dsh-backdrop-media', '')
    video.style.cssText = fullBleed
    attachBackdropMediaPolicy(doc, video)
    nodes.push(video)
  }
  if (layer.scrim) {
    const scrim = doc.createElement('div')
    scrim.setAttribute('aria-hidden', 'true')
    scrim.style.cssText = `position:absolute;inset:0;background:${layer.scrim};`
    nodes.push(scrim)
  }
  return nodes
}
