// @vitest-environment jsdom
/**
 * BackgroundController regression tests: the occlusion veil and the
 * per-state backdrop blur (empty vs. with-content conversation). Since
 * issue #996 the controller owns no settings scope — tests drive it with an
 * initial config plus a recording persist callback, the transport shape the
 * client wiring uses.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { SKIN_BACKGROUND_DEFAULTS } from '../src/core/background.ts'
import type { SkinBackgroundConfig } from '../src/core/background.ts'
import {
  BackgroundController,
  BUBBLE_ALPHA_VAR,
  BUBBLE_BLUR_VAR,
  SCRIM_VAR,
  INPUT_CARD_BLUR_VAR,
} from '../src/client/background.ts'
import { ACTIVE_CONVERSATION_CONTENT_SELECTOR } from '../src/client/runtime/backdrop-scene.ts'

/** A recording persist callback plus the controller built over it. */
function rig(initial: SkinBackgroundConfig | null = null): {
  controller: BackgroundController
  writes: SkinBackgroundConfig[]
} {
  const writes: SkinBackgroundConfig[] = []
  const controller = new BackgroundController(initial, (next) => { writes.push(next) })
  return { controller, writes }
}

/**
 * Find the injected fixed backdrop-filter element, if present.
 *
 * Addressed by its own attribute, not by "the body's aria-hidden div": the
 * occlusion veil is a second body-level layer with the same shape, so a
 * shape-based lookup would answer with whichever one happens to come first.
 */
function blurElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('div[data-dsh-backdrop-blur]')
}

/** Find the injected fixed occlusion veil, if present. */
function scrimElement(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('div[data-dsh-backdrop-scrim]')
}

/** Flush the MutationObserver's coalesced rAF recheck. */
async function flush(): Promise<void> {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/** Wrap one conversation message row inside the conversation pane. */
function addConversationRow(): void {
  const pane = document.createElement('div')
  pane.setAttribute('data-pane', 'conversation')
  const row = document.createElement('div')
  row.className = 'somehash_userRow'
  pane.appendChild(row)
  document.body.appendChild(pane)
}

/**
 * Wrap one official-shell message row (no compat `data-pane` shim) in the
 * conversation scrollport: the shared content selector scopes the bare
 * `data-chat-anchor-key` form to the active scrollport.
 */
function addOfficialConversationRow(): void {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const row = document.createElement('div')
  row.setAttribute('data-chat-anchor-key', 'turn-1')
  scrollport.appendChild(row)
  document.body.appendChild(scrollport)
}

function removeConversationRow(): void {
  document.body.querySelectorAll('[data-pane="conversation"]').forEach(node => node.remove())
  document.body.querySelectorAll('[data-conversation-scroll]').forEach(node => node.remove())
  document.body.querySelectorAll('[data-chat-anchor-key]').forEach(node => node.remove())
}

describe('BackgroundController', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-dsh-wallpaper-active')
  })

  it('defaults: no blur element and the occlusion var is still set', () => {
    const { controller } = rig()
    expect(blurElement()).toBeNull()
    // Occlusion is unchanged: the veil variable is written on a default-0 config.
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('0')
    controller.dispose()
  })

  it('paints the occlusion veil itself instead of leaving it to skin CSS', () => {
    const { controller } = rig({ backgroundOpacity: 42 })
    const veil = scrimElement()
    expect(veil).not.toBeNull()
    // A body-level fixed layer at the blur layer's own z-index: above the
    // backdrop art, below the shell. The runtime owns it because a skin that
    // never reads --dsw-skin-scrim would otherwise offer a dead slider.
    expect(veil!.style.position).toBe('fixed')
    expect(veil!.style.zIndex).toBe('-1')
    expect(veil!.style.pointerEvents).toBe('none')
    expect(veil!.style.opacity).toBe('0.42')
    // The variable stays for skins that do consume it.
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('0.42')
    controller.dispose()
  })

  it('removes the occlusion veil at 0', () => {
    const { controller } = rig({ backgroundOpacity: 42 })
    expect(scrimElement()).not.toBeNull()
    controller.set(0)
    expect(scrimElement()).toBeNull()
    controller.set(42)
    expect(scrimElement()).not.toBeNull()
    controller.dispose()
  })

  it('keeps the occlusion veil off under the master switch and under a wallpaper', () => {
    const off = rig({ enabled: false, backgroundOpacity: 42 })
    expect(scrimElement()).toBeNull()
    off.controller.dispose()

    // A wallpaper carries its own dimming; two veils would double it.
    document.documentElement.setAttribute('data-dsh-wallpaper-active', '')
    const wallpaper = rig({ backgroundOpacity: 42 })
    expect(scrimElement()).toBeNull()
    wallpaper.controller.dispose()
  })

  it('dispose leaves neither layer nor the occlusion variable behind', () => {
    const { controller } = rig({ backgroundOpacity: 42, backgroundBlurEmpty: 6 })
    expect(scrimElement()).not.toBeNull()
    expect(blurElement()).not.toBeNull()
    controller.dispose()
    expect(scrimElement()).toBeNull()
    expect(blurElement()).toBeNull()
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('')
  })

  it('setBlurEmpty(6) creates a fixed element and persists the whole snapshot', () => {    const { controller, writes } = rig()
    controller.setBlurEmpty(6)
    const element = blurElement()
    expect(element).not.toBeNull()
    expect(element!.style.backdropFilter).toContain('blur(6px)')
    // The Safari vendor prefix is set via setProperty; jsdom drops it, so
    // only the standard property is observable here.
    expect(element!.style.pointerEvents).toBe('none')
    expect(writes).toHaveLength(1)
    expect(writes[0].backgroundBlurEmpty).toBe(6)
    controller.dispose()
  })

  it('switches blur strength between empty and content states', async () => {
    const { controller } = rig({ backgroundBlurEmpty: 2, backgroundBlurContent: 10 })
    // Empty conversation -> empty blur.
    expect(blurElement()!.style.backdropFilter).toContain('blur(2px)')
    // A hash-prefixed message row flips the state to with-content.
    addConversationRow()
    await flush()
    expect(blurElement()!.style.backdropFilter).toContain('blur(10px)')
    // Removing the row flips back to the empty state.
    removeConversationRow()
    await flush()
    expect(blurElement()!.style.backdropFilter).toContain('blur(2px)')
    controller.dispose()
  })

  it('detects official shell message rows without the compat data-pane shim', async () => {
    const { controller } = rig({ backgroundBlurEmpty: 2, backgroundBlurContent: 10 })
    expect(blurElement()!.style.backdropFilter).toContain('blur(2px)')
    addOfficialConversationRow()
    await flush()
    expect(blurElement()!.style.backdropFilter).toContain('blur(10px)')
    controller.dispose()
  })

  it('ignores a stale topic-picker row outside the active scrollport (shared selector)', async () => {
    const { controller } = rig({ backgroundBlurEmpty: 2, backgroundBlurContent: 10 })
    expect(blurElement()!.style.backdropFilter).toContain('blur(2px)')
    // A topic picker retains its own anchor node while the new topic mounts.
    // The private bare-attribute query this controller used to carry counted
    // that stale row as content and flipped to the with-content strength while
    // the composer frost gate still saw an empty conversation.
    const staleRow = document.createElement('div')
    staleRow.setAttribute('data-chat-anchor-key', 'stale-topic-row')
    document.body.appendChild(staleRow)
    expect(document.querySelector(ACTIVE_CONVERSATION_CONTENT_SELECTOR)).toBeNull()
    await flush()
    expect(blurElement()!.style.backdropFilter).toContain('blur(2px)')
    // The same row inside the active scrollport is conversation content.
    const scrollport = document.createElement('div')
    scrollport.setAttribute('data-conversation-scroll', '')
    document.body.appendChild(scrollport)
    scrollport.appendChild(staleRow)
    await flush()
    expect(blurElement()!.style.backdropFilter).toContain('blur(10px)')
    controller.dispose()
  })

  it('removes the element when the active value becomes 0, and dispose leaves nothing', () => {
    const { controller } = rig({ backgroundBlurEmpty: 4 })
    expect(blurElement()).not.toBeNull()
    controller.setBlurEmpty(0)
    expect(blurElement()).toBeNull()
    // A later DOM change after dispose does nothing.
    controller.dispose()
    addConversationRow()
    expect(blurElement()).toBeNull()
  })

  it('clamps setBlurEmpty(99) to 20', () => {
    const { controller, writes } = rig()
    controller.setBlurEmpty(99)
    expect(controller.blurEmpty()).toBe(20)
    expect(blurElement()!.style.backdropFilter).toContain('blur(20px)')
    expect(writes[0].backgroundBlurEmpty).toBe(20)
    controller.dispose()
  })

  it('absent blur fields behave as 0 while occlusion reads its own field', () => {
    const { controller } = rig({ backgroundOpacity: 42 })
    expect(controller.blurEmpty()).toBe(0)
    expect(controller.blurContent()).toBe(0)
    expect(blurElement()).toBeNull()
    // Occlusion still reads its own field.
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('0.42')
    controller.dispose()
  })

  it('disabled config (enabled=false) applies no scrim var and no blur element even with nonzero values', () => {
    const { controller } = rig({ enabled: false, backgroundOpacity: 60, backgroundBlurEmpty: 8 })
    expect(controller.enabled()).toBe(false)
    // Occlusion is gated: the veil variable is removed, not written.
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('')
    // Blur is gated: no blur element is created despite a nonzero blur value.
    expect(blurElement()).toBeNull()
    controller.dispose()
  })

  it('wallpaper active suppresses the background blur layer even with nonzero blur (#777 decouple)', () => {
    document.documentElement.setAttribute('data-dsh-wallpaper-active', 'true')
    const { controller } = rig({ backgroundBlurEmpty: 6 })
    expect(blurElement()).toBeNull()
    controller.setBlurEmpty(10)
    expect(blurElement()).toBeNull()
    // Unmount wallpaper: the blur layer is allowed again on the next sync.
    document.documentElement.removeAttribute('data-dsh-wallpaper-active')
    controller.setBlurEmpty(10)
    expect(blurElement()).not.toBeNull()
    expect(blurElement()!.style.backdropFilter).toContain('blur(10px)')
    controller.dispose()
  })

  it('setEnabled(true) restores occlusion application and persists', () => {
    const { controller, writes } = rig({ enabled: false, backgroundOpacity: 60 })
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('')
    controller.setEnabled(true)
    expect(controller.enabled()).toBe(true)
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('0.6')
    expect(writes).toHaveLength(1)
    expect(writes[0].enabled).toBe(true)
    expect(writes[0].backgroundOpacity).toBe(60)
    controller.dispose()
  })

  it('applies, persists, and cleans up input-card blur', () => {
    const { controller, writes } = rig({ inputCardBlur: 6 })
    expect(controller.inputCardBlur()).toBe(6)
    expect(document.body.style.getPropertyValue(INPUT_CARD_BLUR_VAR)).toBe('6px')
    controller.setInputCardBlur(99)
    expect(controller.inputCardBlur()).toBe(20)
    expect(writes[0].inputCardBlur).toBe(20)
    controller.dispose()
    expect(document.body.style.getPropertyValue(INPUT_CARD_BLUR_VAR)).toBe('')
  })

  it('applies, persists, and cleans up message bubble opacity', () => {
    const { controller, writes } = rig({ bubbleOpacity: 35 })
    expect(controller.bubbleOpacity()).toBe(35)
    expect(document.body.style.getPropertyValue(BUBBLE_ALPHA_VAR)).toBe('0.35')
    controller.setBubbleOpacity(105)
    expect(controller.bubbleOpacity()).toBe(100)
    expect(document.body.style.getPropertyValue(BUBBLE_ALPHA_VAR)).toBe('1')
    expect(writes[0].bubbleOpacity).toBe(100)
    controller.dispose()
    expect(document.body.style.getPropertyValue(BUBBLE_ALPHA_VAR)).toBe('')
  })

  it('applies, persists, and cleans up message bubble blur', () => {
    const { controller, writes } = rig({ bubbleBlur: 6 })
    expect(controller.bubbleBlur()).toBe(6)
    expect(document.body.style.getPropertyValue(BUBBLE_BLUR_VAR)).toBe('6px')
    controller.setBubbleBlur(99)
    expect(controller.bubbleBlur()).toBe(20)
    expect(document.body.style.getPropertyValue(BUBBLE_BLUR_VAR)).toBe('20px')
    expect(writes[0].bubbleBlur).toBe(20)
    controller.dispose()
    expect(document.body.style.getPropertyValue(BUBBLE_BLUR_VAR)).toBe('')
  })

  it('setEnabled(false) persists the master switch', () => {
    const { controller, writes } = rig()
    controller.setEnabled(false)
    expect(controller.enabled()).toBe(false)
    expect(writes[0].enabled).toBe(false)
    controller.dispose()
  })

  it('init() replaces every value without persisting (issue #996 backfill)', () => {
    const { controller, writes } = rig({ backgroundOpacity: 10 })
    expect(controller.opacity()).toBe(10)
    // The boot refetch delivers the authoritative v2 state.
    controller.init({ backgroundOpacity: 100, backgroundBlurEmpty: 4, backgroundBlurContent: 5 })
    expect(controller.opacity()).toBe(100)
    expect(controller.blurEmpty()).toBe(4)
    expect(controller.blurContent()).toBe(5)
    // Untouched fields fall back to defaults, matching the stored merge.
    expect(controller.inputCardBlur()).toBe(10)
    expect(controller.bubbleOpacity()).toBe(50)
    expect(controller.bubbleBlur()).toBe(10)
    expect(document.body.style.getPropertyValue(SCRIM_VAR)).toBe('1')
    // init never writes back: the source already owns the stored copy.
    expect(writes).toHaveLength(0)
    controller.dispose()
  })

  it('init(null) resets to defaults', () => {
    const { controller } = rig({ backgroundOpacity: 80, backgroundBlurEmpty: 6 })
    controller.init(null)
    expect(controller.opacity()).toBe(0)
    expect(controller.blurEmpty()).toBe(0)
    expect(blurElement()).toBeNull()
    controller.dispose()
  })

  it('snapshot() carries every field so one POST replaces the section', () => {
    const { controller } = rig({ backgroundOpacity: 30, backgroundBlurEmpty: 2 })
    expect(controller.snapshot()).toEqual({
      enabled: true,
      backgroundOpacity: 30,
      backgroundBlurEmpty: 2,
      backgroundBlurContent: 0,
      inputCardBlur: 10,
      bubbleOpacity: 50,
      bubbleBlur: 10,
    })
    controller.dispose()
  })
})

describe('BackgroundController skin recommendation', () => {
  // Precedence is the whole feature: default < skin recommendation < stored user
  // value, merged per field. A skin ships advice in its tuning.json sidecar; it
  // must apply only where the user has not spoken, and must never need its own
  // state flag to know whether it has been applied.

  it('fills the gaps with the active skin recommendation, per field', () => {
    const recommended = { backgroundOpacity: 45, backgroundBlurContent: 12, inputCardBlur: 4 }
    const controller = new BackgroundController(null, () => {}, () => recommended)
    expect(controller.opacity()).toBe(45)
    expect(controller.blurContent()).toBe(12)
    expect(controller.inputCardBlur()).toBe(4)
    // A field the skin says nothing about still comes from the defaults.
    expect(controller.bubbleBlur()).toBe(SKIN_BACKGROUND_DEFAULTS.bubbleBlur)
    controller.dispose()
  })

  it('lets one stored field win without discarding the rest of the advice', () => {
    const controller = new BackgroundController(null, () => {}, () => ({
      backgroundOpacity: 45,
      backgroundBlurContent: 12,
      inputCardBlur: 4,
    }))
    controller.init({ inputCardBlur: 0 })
    expect(controller.inputCardBlur()).toBe(0)
    expect(controller.opacity()).toBe(45)
    expect(controller.blurContent()).toBe(12)
    controller.dispose()
  })

  it('returns to the recommendation when the stored config is cleared', () => {
    const controller = new BackgroundController(null, () => {}, () => ({ inputCardBlur: 4 }))
    controller.init({ inputCardBlur: 18 })
    expect(controller.inputCardBlur()).toBe(18)
    // What `dsh-skin bg reset` produces: no stored fields at all.
    controller.init({})
    expect(controller.inputCardBlur()).toBe(4)
    controller.dispose()
  })

  it('falls back to the documented defaults for a skin with no recommendation', () => {
    const controller = new BackgroundController(null, () => {}, () => null)
    expect(controller.inputCardBlur()).toBe(SKIN_BACKGROUND_DEFAULTS.inputCardBlur)
    expect(controller.opacity()).toBe(SKIN_BACKGROUND_DEFAULTS.backgroundOpacity)
    controller.dispose()
  })
})
