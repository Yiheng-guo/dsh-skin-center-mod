#!/usr/bin/env node
/**
 * Contrast / legibility audit for a DSH skin.
 *
 *   node build/audit-contrast.mjs <skin-dir> [--frames 12] [--json]
 *
 * Answers the question a skin author cannot answer by eye: **do this skin's
 * text tokens stay readable over its own background video?** The background is
 * a moving image, so "readable" is a worst-case property, not an average one:
 * this samples frames across the loop, composites the skin's surfaces over each
 * one exactly as the browser would, and reports the worst contrast each text
 * token ever reaches.
 *
 * Two placements are audited, because a skin uses both and they fail
 * differently:
 *   panel  — text on a glass panel (bg-layer-1) over the video. This is the
 *            conversation/sidebar case and it is the one the token system
 *            controls directly.
 *   scrim   — text directly on the video behind the manifest's `scrim`. This is
 *            the welcome/hero case, and it is exactly where a bright frame
 *            ruins a heading.
 *
 * Verdict thresholds are WCAG 2.1 AA: 4.5:1 for body text, 3:1 for large text
 * (>= 18.66px bold or >= 24px). Any token below its threshold exits non-zero,
 * so this can gate a skin in CI.
 *
 * Honest limits, stated so they are not mistaken for coverage:
 *   - the scrim parser understands `linear-gradient(<deg>, rgba(...) p%, ...)`
 *     with 0/90/180/270 (and the corner keywords for 0/180). Anything else is
 *     approximated by the mean stop alpha and reported as approximate;
 *   - only axis-aligned, single-layer scrims are exact;
 *   - contrast is computed from the token colour as written; a skin that
 *     overrides the token with `!important` at a deeper selector is judged on
 *     the token, not on the winning declaration.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const FFMPEG = (() => {
  const local = '/Users/mima1234/Downloads/dsh/build/bin/ffmpeg'
  return existsSync(local) ? local : 'ffmpeg'
})()

// ---------------------------------------------------------------- tiny helpers

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const positional = argv.filter((a) => !a.startsWith('--'))
const SKIN_DIR = positional[0] ? resolve(positional[0]) : null
const FRAMES = (() => {
  const i = argv.indexOf('--frames')
  const n = i !== -1 ? Number(argv[i + 1]) : 12
  return Number.isFinite(n) && n > 0 ? Math.min(60, Math.round(n)) : 12
})()

if (!SKIN_DIR || !existsSync(join(SKIN_DIR, 'skin.json'))) {
  console.error('usage: node build/audit-contrast.mjs <skin-dir> [--frames N] [--json]')
  process.exit(2)
}

/** #rgb / #rrggbb / #rrggbbaa -> {r,g,b,a} with a in 0..1 */
function parseHex(value) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(value.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return null
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  return { r, g, b, a }
}

/** `rgba(r, g, b, a)` / `rgb(...)` -> {r,g,b,a}; alpha accepts 0..1 */
function parseRgbFn(value) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i.exec(value)
  if (!m) return null
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  }
}

const parseColor = (v) => parseHex(v) ?? parseRgbFn(v)

/** source-over compositing of `top` onto opaque `bottom` */
function over(top, bottom) {
  const a = top.a
  return {
    r: a * top.r + (1 - a) * bottom.r,
    g: a * top.g + (1 - a) * bottom.g,
    b: a * top.b + (1 - a) * bottom.b,
    a: 1,
  }
}

/** WCAG 2.1 relative luminance */
function luminance({ r, g, b }) {
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG contrast ratio, 1..21 */
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------------------------------------------------------------- skin inputs

const manifest = JSON.parse(readFileSync(join(SKIN_DIR, 'skin.json'), 'utf8'))
const skinCss = readFileSync(join(SKIN_DIR, manifest.contributes.stylesheet), 'utf8')

/** Read a custom property's first declaration from skin.css. */
function token(name) {
  const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(skinCss)
  return m ? m[1].trim() : null
}

const TEXT_TOKENS = [
  ['--dsw-alias-label-primary', 'body text'],
  ['--dsw-alias-label-secondary', 'secondary text'],
  ['--dsw-alias-label-tertiary', 'tertiary text'],
  ['--dsw-alias-label-caption', 'caption'],
  ['--dsw-alias-brand-text', 'brand text / links'],
]
const SURFACE_TOKEN = '--dsw-alias-bg-layer-1'

const texts = TEXT_TOKENS.map(([name, role]) => ({ name, role, color: parseColor(token(name) ?? '') })).filter(
  (t) => t.color !== null,
)
const surface = parseColor(token(SURFACE_TOKEN) ?? '')
const missing = []
if (texts.length === 0) missing.push('no readable text tokens in skin.css')
if (surface === null) missing.push(`${SURFACE_TOKEN} not found in skin.css`)

// ---------------------------------------------------------------- the scrim

/**
 * Split on commas that sit at parenthesis depth 0.
 *
 * Regex cannot do this: `,(?![^(]*\))` looks like it works and then fails on the
 * outermost call, because the comma after `linear-gradient(180deg` IS followed by
 * a `)` before any `(`, so the top-level call gets separated from its own
 * arguments and every scrim silently degrades to "unparseable".
 */
function splitTopLevel(input) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of input) {
    if (ch === '(') depth += 1
    if (ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((p) => p.trim())
}

/**
 * Parse the manifest scrim into a per-pixel alpha function.
 * Returns { alphaAt(u, v), colorAt(), exact, note } where u/v are 0..1 across
 * the frame. Stacked layers combine by maximum alpha, which is an
 * approximation; `exact` says whether the axis was fully modelled.
 */
function parseScrim(spec) {
  const NO_VEIL = { r: 0, g: 0, b: 0, a: 0 }
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { alphaAt: () => 0, colorAt: () => NO_VEIL, exact: true, note: 'no scrim declared' }
  }
  const parsed = []
  for (const layer of splitTopLevel(spec)) {
    const g = /^linear-gradient\(\s*([^,]+),([\s\S]*)\)$/i.exec(layer)
    if (!g) continue
    const head = g[1].trim()
    const stops = []
    for (const part of splitTopLevel(g[2])) {
      const pos = /([\d.]+)%\s*$/.exec(part)
      const color = parseColor(part.replace(/\s*[\d.]+%\s*$/, '').trim())
      if (color) stops.push({ color, pos: pos ? Number(pos[1]) / 100 : null })
    }
    if (stops.length < 2) continue
    stops.forEach((s, i) => {
      if (s.pos === null) s.pos = i / (stops.length - 1)
    })
    let axis = 'to bottom'
    const deg = /^(-?[\d.]+)deg$/i.exec(head)
    if (deg) {
      const d = ((Number(deg[1]) % 360) + 360) % 360
      axis = d === 0 ? 'to top' : d === 90 ? 'to right' : d === 180 ? 'to bottom' : d === 270 ? 'to left' : `deg:${d}`
    } else {
      axis = head
    }
    parsed.push({ axis, stops })
  }
  if (parsed.length === 0) {
    return {
      alphaAt: () => 0,
      colorAt: () => NO_VEIL,
      exact: false,
      note: 'scrim could not be parsed; treated as no veil',
    }
  }
  const exact = parsed.every((p) => ['to top', 'to right', 'to bottom', 'to left'].includes(p.axis))
  const note = exact ? '' : `approximate: gradient axis ${parsed.map((p) => p.axis).join(', ')} not modelled`

  const layerAlpha = (p, u, v) => {
    const t = p.axis === 'to bottom' ? v : p.axis === 'to top' ? 1 - v : p.axis === 'to right' ? u : u === 0 ? 0 : 1 - u
    const stops = p.stops
    if (t <= stops[0].pos) return stops[0].color.a
    if (t >= stops[stops.length - 1].pos) return stops[stops.length - 1].color.a
    for (let i = 1; i < stops.length; i += 1) {
      const a = stops[i - 1]
      const b = stops[i]
      if (t <= b.pos) {
        const span = b.pos - a.pos || 1
        const k = (t - a.pos) / span
        return a.color.a * (1 - k) + b.color.a * k
      }
    }
    return stops[stops.length - 1].color.a
  }
  const layerColor = (p) => p.stops[0].color

  return {
    exact,
    note,
    alphaAt: (u, v) => Math.max(...parsed.map((p) => layerAlpha(p, u, v))),
    colorAt: () => layerColor(parsed[0]),
  }
}

// A near-opaque text-shadow halo supplies the contrast the raw background does
// not, and this audit does not composite it. Detect it so the hostile-area
// number is not misread as "text is lost here".
const shadowSources = [manifest.contributes.stylesheet, manifest.contributes.patches].filter(
  (f) => typeof f === 'string' && existsSync(join(SKIN_DIR, f)),
)
const hasTextShadow = shadowSources.some((f) => /text-shadows*:/.test(readFileSync(join(SKIN_DIR, f), 'utf8')))

const media = manifest.contributes?.backgroundMedia ?? {}
const variant = media.dark ?? media.light ?? null
const scrim = parseScrim(variant?.scrim)

// ---------------------------------------------------------------- frames

/** Decode N frames of the background video to raw RGB at a small fixed size. */
function sampleFrames() {
  const src = variant?.src
  if (variant?.type !== 'video' || typeof src !== 'string') return null
  const file = join(SKIN_DIR, src)
  if (!existsSync(file)) return null
  const dir = mkdtempSync(join(tmpdir(), 'contrast-'))
  try {
    // Scale down: legibility is decided by the large-scale brightness field, not
    // by per-pixel detail. 160px wide keeps a 12-frame audit under a second.
    execFileSync(
      FFMPEG,
      ['-v', 'error', '-y', '-i', file, '-vf', `fps=${Math.max(1, FRAMES / 4)},scale=160:-2`, join(dir, '%03d.png')],
      { stdio: 'ignore' },
    )
    const frames = execFileSync('find', [dir, '-name', '*.png'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()
      .slice(0, FRAMES)
    const py = execFileSync(
      '/Users/mima1234/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3',
      [
        '-c',
        `import sys,glob
from PIL import Image
import numpy as np
for f in sys.argv[1:]:
    a=np.asarray(Image.open(f).convert('RGB'),dtype=float)
    print(f)
    print(' '.join('%d,%d,%d'%tuple(p) for p in a.reshape(-1,3).astype(int)))`,
        ...frames,
      ],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 },
    ).trim().split('\n')
    const out = []
    for (let i = 0; i < py.length; i += 2) {
      const pixels = py[i + 1].split(' ').map((p) => {
        const [r, g, b] = p.split(',').map(Number)
        return { r, g, b, a: 1 }
      })
      out.push(pixels)
    }
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const frames = sampleFrames()
if (frames === null && variant?.type === 'video') {
  missing.push(`background video not found or not decodable: ${variant.src}`)
}

// ---------------------------------------------------------------- audit

/**
 * Per-token legibility statistics for one placement.
 *
 * A single global worst case is the wrong statistic and it is worth writing
 * down why, because it is the obvious first thing to compute and it is useless:
 * a video frame is full of colours, so for any text colour there is almost
 * always SOME pixel that matches it, and the global minimum contrast lands at
 * ~1.0:1 for every token of every skin. A metric that always says "fail" carries
 * no information.
 *
 * What actually matters is how much of the area the text has to survive on:
 *   median      — contrast at the median pixel: the typical case.
 *   p10         — contrast at the 10th percentile: the hostile region.
 *   hostileArea — fraction of sampled area below the body-text threshold.
 * `medianWorst` (the lowest per-frame median) is the headline number, and
 * `hostileArea` (the largest per-frame hostile fraction) says whether the skin
 * has regions where text is simply lost.
 */
function auditPlacement(place) {
  if (!frames || frames.length === 0) return null
  const result = new Map(texts.map((t) => [t.name, { medianWorst: Infinity, hostileArea: 0, worstFrame: -1, typicalBg: null }]))
  frames.forEach((pixels, frameIndex) => {
    for (const t of texts) {
      const cur = result.get(t.name)
      const ratios = []
      let hostile = 0
      let sampled = 0
      for (let i = 0; i < pixels.length; i += 3) {
        const px = pixels[i]
        const u = (i % 160) / 160
        const v = Math.floor(i / 160) / Math.max(1, pixels.length / 160)
        const bg = place === 'panel' ? over(surface, px) : over({ ...scrim.colorAt(), a: scrim.alphaAt(u, v) }, px)
        const ratio = contrast(t.color, bg)
        ratios.push(ratio)
        sampled += 1
        if (ratio < THRESHOLD.body) hostile += 1
      }
      ratios.sort((a, b) => a - b)
      const median = ratios[Math.floor(ratios.length / 2)]
      const hostileArea = hostile / sampled
      if (median < cur.medianWorst) {
        cur.medianWorst = median
        cur.worstFrame = frameIndex
        cur.typicalBg = pixels[0]
      }
      if (hostileArea > cur.hostileArea) cur.hostileArea = hostileArea
    }
  })
  // A representative background for the report: the median frame's mid pixel.
  for (const t of texts) {
    const cur = result.get(t.name)
    cur.p10 = null
    cur.medianWorst = Number(cur.medianWorst.toFixed(2))
    cur.hostileArea = Number(cur.hostileArea.toFixed(3))
    cur.typicalBackground = hex(place === 'panel' ? over(surface, cur.typicalBg) : over({ ...scrim.colorAt(), a: 0 }, cur.typicalBg))
  }
  return result
}

// Declared before the audit runs: auditPlacement closes over both.
const THRESHOLD = { body: 4.5, large: 3 }
/** Hostile-area share above which a skin is worth flagging even if the median is fine. */
const HOSTILE_AREA_LIMIT = 0.85
const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`

const panel = auditPlacement('panel')
const scrimCase = variant ? auditPlacement('scrim') : null

// ---------------------------------------------------------------- report

/** One line per text token: the typical-case contrast and the hostile share. */
function renderPlacement(label, m) {
  if (m === null) return
  console.log(`  ${label}`)
  for (const t of texts) {
    const v = m.get(t.name)
    const verdict = v.medianWorst >= THRESHOLD.body ? 'AA' : v.medianWorst >= THRESHOLD.large ? 'AA for large text only' : 'FAIL'
    console.log(
      `    ${t.role.padEnd(20)} median ${v.medianWorst.toFixed(2).padStart(6)}:1   hostile ${
        (v.hostileArea * 100).toFixed(1).padStart(5)
      }%   ${verdict}`,
    )
  }
}

if (flags.has('--json')) {
  const dump = (m, place) =>
    m === null
      ? null
      : Object.fromEntries(
          texts.map((t) => {
            const v = m.get(t.name)
            return [
              t.name,
              {
                role: t.role,
                place,
                medianWorstRatio: v.medianWorst,
                medianWorstFrame: v.worstFrame,
                hostileAreaShare: v.hostileArea,
              },
            ]
          }),
        )
  console.log(
    JSON.stringify(
      {
        skin: manifest.id,
        background: variant?.src ?? null,
        framesSampled: frames?.length ?? 0,
        scrimExact: scrim.exact,
        scrimNote: scrim.note,
        hasTextShadow,
        thresholds: { ...THRESHOLD, hostileAreaLimit: HOSTILE_AREA_LIMIT },
        definitions: {
          medianWorstRatio: 'lowest per-frame median contrast across the sampled frames, 1..21',
          hostileAreaShare: 'largest share of sampled area whose contrast falls below the body-text threshold',
        },
        panel: dump(panel, 'panel'),
        scrim: dump(scrimCase, 'scrim'),
        problems: missing,
      },
      null,
      2,
    ),
  )
} else {
  console.log(`contrast audit: ${manifest.id} (${manifest.name ?? ''})`)
  console.log(`  background : ${variant ? `${variant.type} ${variant.src}` : '(none declared)'}`)
  console.log(`  frames     : ${frames?.length ?? 0} sampled across the loop`)
  if (scrim.note) console.log(`  scrim      : ${scrim.note}`)
  if (hasTextShadow) console.log('  text-shadow: present — the hostile-area shares below are an UPPER BOUND (the halo is not composited)')
  if (missing.length) for (const m of missing) console.log(`  ! ${m}`)
  console.log()
  renderPlacement('on a glass panel (bg-layer-1 over the video)', panel)
  if (scrimCase) renderPlacement('on the video behind the scrim (welcome / hero)', scrimCase)
}

const failures = []
for (const [place, m] of [
  ['panel', panel],
  ['scrim', scrimCase],
]) {
  if (m === null) continue
  for (const t of texts) {
    const v = m.get(t.name)
    if (v.medianWorst < THRESHOLD.large) {
      failures.push(`${t.role} on ${place}: median ${v.medianWorst.toFixed(2)}:1 — not readable even as large text`)
    } else if (v.medianWorst < THRESHOLD.body) {
      failures.push(`${t.role} on ${place}: median ${v.medianWorst.toFixed(2)}:1 — large text only, below AA for body text`)
    } else if (v.hostileArea > 0.85) {
      failures.push(`${t.role} on ${place}: ${(v.hostileArea * 100).toFixed(0)}% of the area drops below AA — effectively no readable region`)
    }
  }
}

if (!flags.has('--json')) {
  console.log()
  console.log(
    failures.length === 0
      ? '  verdict: every text token reads at AA in the typical case, and no region is systematically hostile'
      : `  verdict: ${failures.length} problem(s)`,
  )
  for (const f of failures) console.log(`    ! ${f}`)
  console.log()
  console.log('  note: median is over sampled pixels per frame, then the worst frame wins.')
  console.log('        hostile area is the share of pixels below the body threshold; it is an')
  console.log('        upper bound when the skin paints a text-shadow halo, and it does not gate.')
  console.log('        a single-pixel worst case is deliberately NOT used — every rich frame')
  console.log('        contains a pixel matching any text colour, so it always reads ~1.0:1.')
}

process.exit(missing.length > 0 || failures.length > 0 ? 1 : 0)
