/**
 * Runs the skin-center's REAL load-time gates against a skin directory:
 *
 *   1. validateSkinManifestV2   (skin.json, fail-closed)
 *   2. transformSkinCss         (skin.css,  deriveFallbacks: true)
 *   3. transformSkinCss         (patches.css, deriveFallbacks: false)
 *   4. manifest file references all exist on disk
 *
 * The validator sources under ./validator are byte-copies of
 * github.com/zhu1090093659/dsh-skins @ main
 * (src/core/manifest-v2/*, src/core/css-safety/*), so a pass here is the same
 * verdict the loader reaches.
 *
 *   node build/validate-skin.mjs cyber-maiden
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSkinManifestV2 } from './validator/validate.ts'
import { transformSkinCss, SkinCssSafetyError } from './validator/transform.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let failures = 0
const ok = (m) => console.log(`  \u001b[32mPASS\u001b[0m  ${m}`)
const bad = (m) => {
  failures += 1
  console.log(`  \u001b[31mFAIL\u001b[0m  ${m}`)
}

function checkManifest(dir) {
  console.log('\n[1] skin.json — validateSkinManifestV2')
  const path = join(dir, 'skin.json')
  if (!existsSync(path)) return bad('skin.json missing'), null

  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return bad(`skin.json is not valid JSON: ${error.message}`), null
  }

  const result = validateSkinManifestV2(parsed)
  if (result.ok) ok(`accepted (id="${result.manifest.id}", v${result.manifest.version})`)
  else for (const e of result.errors) bad(e)
  for (const w of result.warnings) console.log(`  \u001b[33mWARN\u001b[0m  ${w}`)
  return result.ok ? parsed : null
}

function checkCss(dir, relative, deriveFallbacks) {
  console.log(`\n[${relative === 'skin.css' ? 2 : 3}] ${relative} — transformSkinCss${deriveFallbacks ? ' (deriveFallbacks)' : ''}`)
  const path = join(dir, relative)
  if (!existsSync(path)) {
    console.log('  \u001b[33mSKIP\u001b[0m  not declared / not present')
    return
  }
  const css = readFileSync(path, 'utf8')
  try {
    const { code, warnings } = transformSkinCss(css, {
      skinId: MANIFEST?.id ?? 'unknown',
      filename: relative,
      deriveFallbacks,
    })
    ok(`whitelist clean, ${css.length} -> ${code.length} chars after scoping`)
    for (const w of warnings) console.log(`  \u001b[33mWARN\u001b[0m  ${w}`)
    for (const needle of [
      `html[data-dsh-skin="${MANIFEST?.id}"]`,
      '[id="root"] { background: transparent; }',
      '--shiki-background: var(--dsw-alias-markdown-code-block)',
    ]) {
      if (code.includes(needle)) ok(`loader rewrite present: ${needle}`)
      else bad(`loader rewrite MISSING: ${needle}`)
    }
  } catch (error) {
    if (error instanceof SkinCssSafetyError) {
      bad(`whitelist violation (fail-closed) — the skin would NOT load:`)
      for (const v of error.violations) console.log(`         - ${v}`)
    } else {
      bad(`transform threw: ${error.message}`)
    }
  }
}

function checkReferences(dir, manifest) {
  console.log('\n[4] manifest file references')
  const refs = []
  const walk = (value, label) => {
    if (typeof value === 'string' && /^[A-Za-z0-9._\-/]+$/.test(value) && /\.[a-z0-9]{2,5}$/i.test(value)) {
      refs.push([value, label])
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${label}.${k}`)
    }
  }
  walk(manifest, 'manifest')
  for (const [rel, label] of refs) {
    const p = join(dir, rel)
    if (!existsSync(p)) bad(`${label} -> ${rel} does not exist`)
    else if (statSync(p).size === 0) bad(`${label} -> ${rel} is empty`)
    else ok(`${label} -> ${rel} (${statSync(p).size.toLocaleString()} bytes)`)
  }
  // a video/image background must not be absurdly heavy: it loads on every boot
  const layer = manifest.contributes?.backgroundMedia?.dark ?? manifest.contributes?.backgroundMedia?.light
  if (layer?.type === 'video') {
    const size = statSync(join(dir, layer.src)).size
    if (size > 20 * 1024 * 1024) bad(`background video is ${(size / 1048576).toFixed(1)} MiB — over the 20 MiB comfort limit`)
    else ok(`background video ${(size / 1048576).toFixed(2)} MiB`)
  }
}

const skinName = process.argv[2]
if (!skinName) {
  console.error('usage: node build/validate-skin.mjs <skin-directory>')
  process.exit(2)
}
const DIR = join(ROOT, skinName)
console.log(`\n=== validating ${DIR} ===`)

const MANIFEST = checkManifest(DIR)
if (MANIFEST) {
  checkCss(DIR, MANIFEST.contributes.stylesheet, true)
  if (MANIFEST.contributes.patches) checkCss(DIR, MANIFEST.contributes.patches, false)
  checkReferences(DIR, MANIFEST)
}

console.log(
  failures === 0
    ? `\n\u001b[32mAll gates passed — this skin loads under the real skin-center pipeline.\u001b[0m\n`
    : `\n\u001b[31m${failures} gate(s) failed — the loader would refuse or degrade this skin.\u001b[0m\n`,
)
process.exit(failures === 0 ? 0 : 1)
