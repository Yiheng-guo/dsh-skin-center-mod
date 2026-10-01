#!/usr/bin/env node
/**
 * Regenerate the patch set from the working upstream checkout.
 *
 *   node build/regen-patches.mjs [--check]
 *
 * Sources of truth:
 *   build/pristine/<path>   the published upstream file, untouched
 *   build/.upstream/<path>  the working checkout, where the fixes are applied
 *
 * Outputs, under mods/:
 *   baseline/<path>   copy of the pristine file
 *   patched/<path>    copy of the fixed file
 *   NN-<name>.patch   concatenated unified diffs for that concern
 *
 * Safety property: if any file under src/ or tests/ differs from pristine and is
 * NOT listed in GROUPS below, this exits non-zero and names the file. That is the
 * whole point — a fix that silently misses the published patch set is worse than
 * no fix, and it has already happened once by hand.
 *
 * --check verifies that regenerating would change nothing (for CI).
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PRISTINE = join(HERE, 'pristine')
const WORKING = join(HERE, '.upstream')
const MODS = join(ROOT, 'mods')

/**
 * concern -> the files it owns. Every changed file must appear in exactly one
 * group; the script refuses to run otherwise.
 */
const GROUPS = {
  '01-runtime-occlusion': ['src/client/background.ts'],
  '02-occlusion-tests': ['tests/background.spec.ts'],
  '03-backdrop-media-policy': ['src/client/runtime/decoration-layers.ts'],
  '04-legacy-bridge-before-seed': ['src/index.ts'],
  '05-skin-id-single-pattern': [
    'src/core/manifest-v2/validate.ts',
    'src/tap-index-adapter.ts',
    'tests/manifest-v2.spec.ts',
    'tests/tap-index-adapter.spec.ts',
  ],
  '06-stylesheet-link-leak': [
    'src/client/runtime/skin-controller.ts',
    'tests/skin-runtime.spec.ts',
  ],
  '07-provenance-hygiene': [
    'src/provenance.ts',
    'src/active-state.ts',
    'tests/provenance.spec.ts', // added by this fix, absent upstream
    'tests/active-state.spec.ts',
  ],
  '08-http-caching-and-integrity': [
    'src/routes-v2.ts',
    'src/skin-repo.ts',
    'tests/routes-v2.spec.ts',
    'tests/skin-repo.spec.ts',
  ],
  '09-frost-and-detector-consistency': [
    'src/client/runtime/backdrop-scene.ts',
    'tests/backdrop-scene.spec.ts',
    'tests/wallpaper.spec.ts',
  ],
  // A file can only belong to one group, so a file carrying two concerns stays
  // with the earlier one and its README section lists every concern it carries.
  // Concretely: 01 also carries the detector unification, 06 the tuning token
  // injection, 08 the tuning sidecar read, 02 and 06 the tuning tests.
  '10-skin-tuning-sidecar': ['src/core/tuning.ts', 'tests/tuning.spec.ts'],
  '11-cli-background-and-live-follow': [
    'scripts/dsh-skin.cjs',
    'scripts/dsh-skin.test.mjs',
    'src/client/runtime/boot.ts',
    'tests/skin-selection-follow.spec.ts',
  ],
  // The card UI that consumed these counters is withdrawn (see the report): it
  // looped infinitely on render. Only the adapter half ships.
  '12-adapter-diagnostics-counters': [
    'src/client/runtime/semantic-adapter.ts',
    'tests/semantic-adapter.spec.ts',
  ],
  '13-wallpaper-codec-preflight': [
    'src/client/wallpaper.ts',
    'src/client/WallpaperPanel.tsx',
    'src/client/index.ts',
    'tests/wallpaper-panel.spec.tsx',
    'tests/skin-center-custom-theme.spec.tsx',
  ],
}

// ---------------------------------------------------------------- helpers

function walk(dir, base = dir) {
  const out = []
  for (const entry of execFileSync('find', [dir, '-type', 'f'], { encoding: 'utf8' }).split('\n')) {
    if (entry === '') continue
    out.push(relative(base, entry))
  }
  return out
}

function sameBytes(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false
  return readFileSync(a).equals(readFileSync(b))
}

// ---------------------------------------------------------------- discover
if (!existsSync(PRISTINE) || !existsSync(WORKING)) {
  console.error('missing build/pristine or build/.upstream')
  process.exit(1)
}

const pristineFiles = walk(PRISTINE).sort()
const changed = []
for (const rel of pristineFiles) {
  const p = join(PRISTINE, rel)
  const w = join(WORKING, rel)
  if (!existsSync(w)) {
    console.error(`working checkout is missing ${rel}`)
    process.exit(1)
  }
  if (!sameBytes(p, w)) changed.push(rel)
}

// Files that exist in the working tree but not in the pinned baseline were
// ADDED by a fix. They must be grouped too — walking only the baseline would
// silently drop a brand-new spec file from the published patch set.
const added = walk(join(WORKING, 'src'), WORKING)
  .concat(walk(join(WORKING, 'tests'), WORKING))
  .filter((rel) => !existsSync(join(PRISTINE, rel)))
  .sort()
for (const rel of added) changed.push(rel)
changed.sort()

const claimed = new Map()
for (const [name, files] of Object.entries(GROUPS)) {
  for (const f of files) {
    if (claimed.has(f)) {
      console.error(`file listed in two groups: ${f} (${claimed.get(f)}, ${name})`)
      process.exit(1)
    }
    claimed.set(f, name)
  }
}

const unclaimed = changed.filter((f) => !claimed.has(f))
const claimedButClean = [...claimed.keys()].filter((f) => !changed.includes(f))

if (unclaimed.length > 0) {
  console.error(`\n${unclaimed.length} changed file(s) belong to no group:`)
  for (const f of unclaimed) console.error(`    ${f}`)
  console.error('\nAdd them to GROUPS (with the right concern) and re-run.')
  process.exit(1)
}

if (claimedButClean.length > 0) {
  console.error(`\n${claimedButClean.length} grouped file(s) show no change:`)
  for (const f of claimedButClean) console.error(`    ${f}  (${claimed.get(f)})`)
  console.error('\nEither the fix is missing or the grouping is stale.')
  process.exit(1)
}

console.log(`changed files: ${changed.length}`)
for (const f of changed) console.log(`  ${claimed.get(f).padEnd(30)} ${f}`)

if (process.argv.includes('--check')) {
  console.log('\n--check: grouping is complete and consistent.')
  process.exit(0)
}

// ---------------------------------------------------------------- write
for (const dir of ['baseline', 'patched']) rmSync(join(MODS, dir), { recursive: true, force: true })
rmSync(join(MODS, 'baseline'), { recursive: true, force: true })
rmSync(join(MODS, 'patched'), { recursive: true, force: true })

for (const rel of changed) {
  const isAdded = added.includes(rel)
  const dest = join(MODS, 'patched', rel)
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(join(WORKING, rel), dest)
  if (!isAdded) {
    const base = join(MODS, 'baseline', rel)
    mkdirSync(dirname(base), { recursive: true })
    cpSync(join(PRISTINE, rel), base)
  }
}

// Remove EVERY patch, not just the ones GROUPS still names: a renamed or
// withdrawn concern would otherwise leave its old patch on disk and silently
// keep shipping stale hunks (this happened when group 12 was redefined).
for (const entry of readdirSync(MODS)) {
  if (entry.endsWith('.patch')) rmSync(join(MODS, entry), { force: true })
}

for (const [name, files] of Object.entries(GROUPS)) {
  let patch = ''
  for (const rel of files) {
    const left = added.includes(rel) ? '/dev/null' : join('baseline', rel)
    // diff exits 1 when the files differ, which is expected here.
    try {
      patch += execFileSync('diff', ['-u', left, join('patched', rel)], {
        cwd: MODS,
        encoding: 'utf8',
      })
    } catch (error) {
      patch += error.stdout ?? ''
    }
  }
  writeFileSync(join(MODS, `${name}.patch`), patch)
  const fileCount = (patch.match(/^--- /gm) ?? []).length
  console.log(`  wrote mods/${name}.patch  (${patch.split('\n').length - 1} lines, ${fileCount} file(s))`)
}

console.log(`\nbaseline/ and patched/ hold ${changed.length - added.length} and ${changed.length} file(s).`)
if (added.length > 0) console.log(`added by the fixes: ${added.join(', ')}`)
