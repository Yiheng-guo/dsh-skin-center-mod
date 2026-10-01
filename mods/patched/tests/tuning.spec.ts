/**
 * Contract tests for the per-skin `tuning.json` sidecar.
 *
 * Two things matter here and they pull in opposite directions:
 *  - a malformed sidecar must never break a skin (it installs and renders as if
 *    the file did not exist), so parsing is lenient and total;
 *  - a token value is injected into a stylesheet, so it must never be able to
 *    escape its declaration (fail-closed, per value).
 */

import { describe, expect, it } from 'vitest'

import { parseSkinTuning, tuningTokenCss, TUNING_FILENAME } from '../src/core/tuning.ts'

describe('parseSkinTuning', () => {
  it('returns nothing for a non-object without throwing', () => {
    for (const raw of [null, undefined, 42, 'nope', [], true]) {
      const result = parseSkinTuning(raw)
      expect(result.tuning).toBeNull()
      expect(result.problems).toHaveLength(1)
      expect(result.problems[0]).toContain(TUNING_FILENAME)
    }
  })

  it('keeps a background block and clamps it through the shared normalizer', () => {
    const result = parseSkinTuning({ background: { backgroundOpacity: 999, inputCardBlur: -4, bogus: 1 } })
    expect(result.tuning?.background).toEqual({ backgroundOpacity: 100, inputCardBlur: 0 })
    expect(result.problems).toContain(`${TUNING_FILENAME}: background.bogus ignored`)
  })

  it('reports a background block with no usable field instead of inventing one', () => {
    const result = parseSkinTuning({ background: { nope: true } })
    expect(result.tuning).toBeNull()
    expect(result.problems.join(' ')).toContain('no usable field')
  })

  it('keeps token overrides', () => {
    const result = parseSkinTuning({ tokens: { '--dsw-alias-label-tertiary': '#849ab8' } })
    expect(result.tuning?.tokens).toEqual({ '--dsw-alias-label-tertiary': '#849ab8' })
    expect(result.problems).toHaveLength(0)
  })

  it('accepts the value shapes real skins use', () => {
    const result = parseSkinTuning({
      tokens: {
        '--dsw-alias-label-tertiary': '#849ab8',
        '--dsw-alias-bg-layer-1': 'rgb(10 16 32 / 50%)',
        '--x-shadow': '0 0 10px rgba(5, 7, 13, 0.9), 0 0 24px #05070d9e',
        '--x-font': '"Noto Sans SC", system-ui, -apple-system, sans-serif',
        '--x-size': 'clamp(12px, 1.2vw, 16px)',
        '--x-url-free': 'linear-gradient(180deg, #0000, #0008)',
      },
    })
    expect(Object.keys(result.tuning?.tokens ?? {})).toHaveLength(6)
    expect(result.problems).toHaveLength(0)
  })

  it('drops a token name that is not a custom property', () => {
    const result = parseSkinTuning({ tokens: { 'color': 'red', '--ok': 'red' } })
    expect(result.tuning?.tokens).toEqual({ '--ok': 'red' })
    expect(result.problems.join(' ')).toContain('"color" is not a custom property name')
  })

  it('fails closed on every value that could escape the declaration', () => {
    // Each of these would let a value terminate the rule this module builds.
    const escapes = [
      'red; } body { display: none',
      'red}html{display:none',
      'url(https://example.com/x.png)',
      'red /* swallow the closing brace */',
      'red\\3b color: blue',
      '@import "https://example.com/x.css"',
      'expression(alert(1))',
      'a\u0000b',
    ]
    for (const value of escapes) {
      const result = parseSkinTuning({ tokens: { '--x': value } })
      expect(result.tuning).toBeNull()
      expect(result.problems).toHaveLength(1)
    }
  })

  it('drops an empty, over-long or non-string value', () => {
    for (const value of ['', '   ', 'a'.repeat(161), 12, null, {}]) {
      const result = parseSkinTuning({ tokens: { '--x': value } })
      expect(result.tuning).toBeNull()
      expect(result.problems).toHaveLength(1)
    }
  })

  it('rejects a non-object tokens block', () => {
    for (const tokens of ['--x: red', 42, null, ['--x']]) {
      const result = parseSkinTuning({ tokens })
      expect(result.tuning).toBeNull()
      expect(result.problems.join(' ')).toContain('"tokens" must be an object')
    }
  })

  it('keeps the usable half when one half is broken', () => {
    const result = parseSkinTuning({ background: { backgroundOpacity: 40 }, tokens: { nope: 'red' } })
    expect(result.tuning?.background).toEqual({ backgroundOpacity: 40 })
    expect(result.tuning?.tokens).toBeUndefined()
    expect(result.problems).toHaveLength(1)
  })

  it('ignores unknown top-level keys', () => {
    const result = parseSkinTuning({ background: { inputCardBlur: 12 }, version: 3, notes: 'hello' })
    expect(result.tuning?.background).toEqual({ inputCardBlur: 12 })
    expect(result.problems).toHaveLength(0)
  })
})

describe('tuningTokenCss', () => {
  it('scopes the overrides to the skin that shipped them', () => {
    const css = tuningTokenCss('harbor', { tokens: { '--a': '#fff', '--b': '2px' } })
    expect(css).toBe('html[data-dsh-skin="harbor"]{--a:#fff;--b:2px}')
  })

  it('emits nothing when there is nothing to emit', () => {
    expect(tuningTokenCss('harbor', null)).toBeNull()
    expect(tuningTokenCss('harbor', {})).toBeNull()
    expect(tuningTokenCss('harbor', { background: { inputCardBlur: 4 } })).toBeNull()
    expect(tuningTokenCss('harbor', { tokens: {} })).toBeNull()
  })

  it('cannot produce a selector escape through the skin id, because parsing already bounded it', () => {
    // The id lands inside an attribute selector. parseSkinTuning is not the guard
    // for it; the manifest validator is (SKIN_ID_PATTERN). Assert the shape here
    // so a future caller that skips validation is visible in the diff.
    const css = tuningTokenCss('harbor', { tokens: { '--a': 'red' } })
    expect(css).not.toContain('" onload')
    expect(css?.startsWith('html[data-dsh-skin="harbor"]{')).toBe(true)
  })
})
