// @vitest-environment jsdom
/**
 * Backdrop scene marker contracts (#777 follow-up): the mutation-driven
 * conversation-content check coalesces into one check per animation frame,
 * marker/attribute writes are idempotent, and clearing the last backdrop
 * source cancels pending scheduled work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BACKDROP_ACTIVE_ATTR,
  CONVERSATION_CONTENT_ATTR,
  SCENE_NEUTRALIZER_ATTR,
  setSceneBackdropActive,
} from '../src/client/runtime/backdrop-scene.ts'

let frames: Array<FrameRequestCallback | null> = []
let cancelledFrames = 0
let originalRaf: typeof window.requestAnimationFrame
let originalCancelRaf: typeof window.cancelAnimationFrame

function flushFrames(): void {
  const pending = frames.splice(0, frames.length)
  for (const callback of pending) callback?.(0)
}

/** Let the MutationObserver deliver its queued records (macrotask). */
function deliverMutations(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

/** Append one active-scrollport message row: what the frost gate keys on. */
function appendConversationRow(): HTMLElement {
  const scrollport = document.createElement('div')
  scrollport.setAttribute('data-conversation-scroll', '')
  const row = document.createElement('div')
  row.setAttribute('data-chat-anchor-key', 'turn-row')
  scrollport.appendChild(row)
  document.body.appendChild(scrollport)
  return scrollport
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.head.innerHTML = ''
  document.documentElement.removeAttribute(BACKDROP_ACTIVE_ATTR)
  document.documentElement.removeAttribute(CONVERSATION_CONTENT_ATTR)
  // Reset the module-level per-document observer state from a previous test.
  setSceneBackdropActive(document, 'skin', false)
  setSceneBackdropActive(document, 'wallpaper', false)

  frames = []
  cancelledFrames = 0
  originalRaf = window.requestAnimationFrame
  originalCancelRaf = window.cancelAnimationFrame
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }) as typeof window.requestAnimationFrame
  window.cancelAnimationFrame = ((handle: number) => {
    if (handle > 0 && frames[handle - 1] !== undefined) {
      frames[handle - 1] = null
      cancelledFrames += 1
    }
  }) as typeof window.cancelAnimationFrame
})

afterEach(() => {
  setSceneBackdropActive(document, 'skin', false)
  setSceneBackdropActive(document, 'wallpaper', false)
  window.requestAnimationFrame = originalRaf
  window.cancelAnimationFrame = originalCancelRaf
  vi.restoreAllMocks()
})

describe('backdrop scene content marker', () => {
  it('coalesces the conversation-content check to one per frame without redundant writes', async () => {
    const scrollport = appendConversationRow()
    setSceneBackdropActive(document, 'skin', true)
    expect(document.body.getAttribute(BACKDROP_ACTIVE_ATTR)).toBe('true')
    expect(document.body.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(true)
    expect(document.documentElement.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(true)
    expect(document.head.querySelector(`style[${SCENE_NEUTRALIZER_ATTR}]`)).not.toBeNull()

    const bodyQuery = vi.spyOn(document.body, 'querySelector')
    const bodySet = vi.spyOn(document.body, 'setAttribute')
    const bodyRemove = vi.spyOn(document.body, 'removeAttribute')
    const rootSet = vi.spyOn(document.documentElement, 'setAttribute')
    const rootRemove = vi.spyOn(document.documentElement, 'removeAttribute')

    // Streaming-like churn: every batch lands on its own microtask checkpoint
    // but the whole burst stays inside one animation frame.
    for (let i = 0; i < 30; i++) {
      scrollport.appendChild(document.createElement('div'))
      await Promise.resolve()
    }
    expect(frames.filter(callback => callback !== null)).toHaveLength(1)
    expect(bodyQuery).not.toHaveBeenCalled()

    flushFrames()
    expect(bodyQuery).toHaveBeenCalledTimes(1)
    // The marker already matched the desired state: no attribute writes.
    expect(bodySet).not.toHaveBeenCalled()
    expect(bodyRemove).not.toHaveBeenCalled()
    expect(rootSet).not.toHaveBeenCalled()
    expect(rootRemove).not.toHaveBeenCalled()
  })

  it('updates the marker once per frame when conversation rows appear and disappear', async () => {
    setSceneBackdropActive(document, 'skin', true)
    expect(document.body.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)

    const scrollport = appendConversationRow()
    await deliverMutations()
    expect(frames.filter(callback => callback !== null)).toHaveLength(1)
    flushFrames()
    expect(document.body.getAttribute(CONVERSATION_CONTENT_ATTR)).toBe('true')
    expect(document.documentElement.getAttribute(CONVERSATION_CONTENT_ATTR)).toBe('true')

    scrollport.remove()
    await deliverMutations()
    expect(frames.filter(callback => callback !== null)).toHaveLength(1)
    flushFrames()
    expect(document.body.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)
    expect(document.documentElement.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)
  })

  it('cancels a pending content check and cleans up when the last scene source clears', async () => {
    setSceneBackdropActive(document, 'skin', true)
    // A second source keeps the scene active until both report inactive.
    setSceneBackdropActive(document, 'wallpaper', true)
    expect(document.documentElement.getAttribute(BACKDROP_ACTIVE_ATTR)).toBe('true')

    appendConversationRow()
    await deliverMutations()
    expect(frames.filter(callback => callback !== null)).toHaveLength(1)

    const bodyQuery = vi.spyOn(document.body, 'querySelector')
    setSceneBackdropActive(document, 'skin', false)
    // One source remains: the scene and its pending check stay alive.
    expect(document.documentElement.getAttribute(BACKDROP_ACTIVE_ATTR)).toBe('true')
    expect(cancelledFrames).toBe(0)
    setSceneBackdropActive(document, 'wallpaper', false)

    expect(cancelledFrames).toBe(1)
    expect(document.body.hasAttribute(BACKDROP_ACTIVE_ATTR)).toBe(false)
    expect(document.documentElement.hasAttribute(BACKDROP_ACTIVE_ATTR)).toBe(false)
    expect(document.body.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)
    expect(document.documentElement.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)

    flushFrames()
    // The cancelled frame must not re-query the body or resurrect the marker.
    expect(bodyQuery).not.toHaveBeenCalled()
    expect(document.body.hasAttribute(CONVERSATION_CONTENT_ATTR)).toBe(false)

    // Later mutations cannot restart the disposed observer.
    document.body.appendChild(document.createElement('div'))
    await deliverMutations()
    expect(frames.filter(callback => callback !== null)).toHaveLength(0)
  })
})

/** The follower element the frost rides while a scene is active. */
function frostFollower(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-dsh-composer-frost]')
}

describe('composer frost follower (#1724)', () => {
  it('paints the frost on a body-level follower instead of the composer card', async () => {
    // Given an active conversation with a composer card
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    document.body.appendChild(card)
    const scrollport = appendConversationRow()
    expect(scrollport).not.toBeNull()

    // When the backdrop becomes visible
    setSceneBackdropActive(document, 'skin', true)

    // Then the card is NOT a containing block: the injected sheet carries no
    // containing-block property for it, which is what used to redirect the
    // shell's fixed tooltips into the scrollport and jolt the page
    const sheet = document.head.querySelector(`style[${SCENE_NEUTRALIZER_ATTR}]`)?.textContent ?? ''
    expect(sheet).not.toContain('[data-composer-card]')
    expect(sheet).toContain('[data-dsh-composer-frost]')

    // And the frost rides a body-level sibling: empty, inert, and outside the
    // scrollport that must never grow
    const follower = frostFollower()
    expect(follower?.getAttribute('aria-hidden')).toBe('true')
    expect((follower as HTMLElement).style.pointerEvents).toBe('none')
    expect((follower as HTMLElement).style.position).toBe('fixed')
    expect(follower?.parentElement).toBe(document.body)
    expect(scrollport.contains(follower)).toBe(false)
    expect(follower?.childElementCount).toBe(0)
  })

  it('removes the follower when the scene clears and leaves nothing behind', async () => {
    // Given a mounted follower
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    document.body.appendChild(card)
    appendConversationRow()
    setSceneBackdropActive(document, 'skin', true)
    expect(frostFollower()).not.toBeNull()

    // When the last backdrop source clears
    setSceneBackdropActive(document, 'skin', false)

    // Then no orphan element survives (the frost is fully owned by the scene)
    expect(frostFollower()).toBeNull()
  })

  it('sizes the follower to the composer card it tracks', async () => {
    // Given a card with a measured box and a skin-provided radius
    const card = document.createElement('div')
    card.setAttribute('data-composer-card', '')
    card.getBoundingClientRect = () => ({ top: 700, left: 320, width: 900, height: 140, right: 1220, bottom: 840, x: 320, y: 700, toJSON: () => ({}) }) as DOMRect
    card.style.borderRadius = '18px'
    document.body.appendChild(card)
    appendConversationRow()

    // When the scene activates and the queued frame runs
    setSceneBackdropActive(document, 'skin', true)
    flushFrames()

    // Then the follower covers the card's border box with the card's radius
    const follower = frostFollower()!
    expect(follower.style.top).toBe('700px')
    expect(follower.style.left).toBe('320px')
    expect(follower.style.width).toBe('900px')
    expect(follower.style.height).toBe('140px')
    expect(follower.style.borderRadius).toBe(card.style.borderRadius)
  })
})
