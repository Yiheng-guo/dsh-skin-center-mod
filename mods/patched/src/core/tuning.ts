/**
 * Per-skin tuning sidecar (fork extension).
 *
 * A skin may ship `tuning.json` next to its `skin.json` describing the
 * background values that suit its own artwork and, optionally, scoped token
 * overrides. This exists because the v2 manifest schema is
 * `additionalProperties: false`: a new field inside `skin.json` would be a hard
 * validation error for every existing reader, so a skin using it would be
 * REJECTED by any skin-center build that does not know the field. A sidecar
 * carries the same information while staying invisible to every other reader,
 * and it keeps the repository's invariant that a skin is pure data.
 *
 * Nothing here executes. The values are consumed as data two ways:
 *
 *  - `background` seeds the skin center's background controls when the user has
 *    not configured them (see the resolution note in `src/active-state.ts`);
 *    user values always win, and `dsh-skin bg reset` returns to these.
 *  - `tokens` are emitted as one scoped rule,
 *    `html[data-dsh-skin="<id>"]{--token:value}`, so a local legibility fix
 *    survives a skin reinstall instead of being a hand edit of `skin.css`.
 *
 * Token values are injected into a stylesheet, so they are validated
 * fail-closed: a value that could terminate the declaration or open a new rule
 * is dropped, and the drop is reported rather than silently ignored.
 *
 * @module @linxin666/dsh-client-ui-skin-center/core/tuning
 */

import { normalizeSkinBackground } from './background.ts'
import type { SkinBackgroundConfig } from './background.ts'

/** The sidecar's file name inside a skin directory. */
export const TUNING_FILENAME = 'tuning.json'

/** Background values a skin recommends, plus scoped token overrides. */
export interface SkinTuning {
  background?: SkinBackgroundConfig
  tokens?: Record<string, string>
}

export interface SkinTuningParse {
  /** Null when the sidecar carries nothing usable. */
  tuning: SkinTuning | null
  /** Human-readable reasons a value was dropped, for catalog diagnostics. */
  problems: string[]
}

/** A custom property name we are willing to define. */
const TOKEN_NAME = /^--[a-z0-9-]{1,64}$/i

/** Longest value we accept; real values are colours, lengths and font stacks. */
const TOKEN_VALUE_MAX = 160

/**
 * Characters and sequences that must never reach the stylesheet.
 *
 * `;` ends the declaration and `{}` opens or closes a rule, so any of them lets
 * a value escape the scope this module is building. Comments can be used to
 * swallow the closing brace, and `url()`/`@import`/`expression()` reach the
 * network, the CSS loader, or (historically) script. Backslashes are rejected
 * because they are the CSS escape hatch.
 */
const FORBIDDEN = [';', '{', '}', '<', '>', '\\', '/*', '*/', 'url(', '@', 'expression(']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkTokenValue(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== 'string') return { ok: false, reason: 'not a string' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (trimmed.length > TOKEN_VALUE_MAX) return { ok: false, reason: `longer than ${TOKEN_VALUE_MAX} characters` }
  const control = /[\u0000-\u001f\u007f]/.exec(trimmed)
  if (control !== null) return { ok: false, reason: 'contains a control character' }
  const hit = FORBIDDEN.find((token) => trimmed.includes(token))
  if (hit !== undefined) return { ok: false, reason: `contains ${JSON.stringify(hit)}` }
  return { ok: true, value: trimmed }
}

/**
 * Parse a `tuning.json` document. Never throws: a malformed sidecar yields a
 * null tuning plus problems, so a skin with a broken sidecar still installs and
 * still renders exactly as it would without one.
 */
export function parseSkinTuning(raw: unknown): SkinTuningParse {
  const problems: string[] = []
  if (!isRecord(raw)) {
    return { tuning: null, problems: [`${TUNING_FILENAME} must be a JSON object`] }
  }

  const tuning: SkinTuning = {}

  if (raw.background !== undefined) {
    const background = normalizeSkinBackground(raw.background)
    if (Object.keys(background).length === 0) {
      problems.push(`${TUNING_FILENAME}: "background" has no usable field`)
    } else {
      tuning.background = background
      if (isRecord(raw.background)) {
        for (const key of Object.keys(raw.background)) {
          if (!(key in background)) problems.push(`${TUNING_FILENAME}: background.${key} ignored`)
        }
      }
    }
  }

  if (raw.tokens !== undefined) {
    if (!isRecord(raw.tokens)) {
      problems.push(`${TUNING_FILENAME}: "tokens" must be an object`)
    } else {
      const tokens: Record<string, string> = {}
      for (const [name, value] of Object.entries(raw.tokens)) {
        if (!TOKEN_NAME.test(name)) {
          problems.push(`${TUNING_FILENAME}: tokens key ${JSON.stringify(name)} is not a custom property name`)
          continue
        }
        const checked = checkTokenValue(value)
        if (!checked.ok) {
          problems.push(`${TUNING_FILENAME}: tokens.${name} dropped (${checked.reason})`)
          continue
        }
        tokens[name] = checked.value
      }
      if (Object.keys(tokens).length > 0) tuning.tokens = tokens
    }
  }

  if (tuning.background === undefined && tuning.tokens === undefined) {
    return { tuning: null, problems }
  }
  return { tuning, problems }
}

/**
 * The scoped rule that applies this tuning's token overrides, or null when
 * there is nothing to apply.
 *
 * The selector is the same scope attribute the runtime stamps and the CSS
 * safety pipeline scopes under, so an override can only ever affect the skin it
 * was shipped with.
 */
export function tuningTokenCss(skinId: string, tuning: SkinTuning | null): string | null {
  const tokens = tuning?.tokens
  if (tokens === undefined) return null
  const declarations = Object.entries(tokens)
    .map(([name, value]) => `${name}:${value}`)
    .join(';')
  if (declarations === '') return null
  return `html[data-dsh-skin="${skinId}"]{${declarations}}`
}
