#!/usr/bin/env node
'use strict'

/**
 * dsh-skin — skin tooling for the DSH Web GUI (v2, issue #506).
 *
 * Skins are pure asset directories (skin.json + skin.css + optional
 * patches.css / hooks.mjs / assets/). The skin-center package is the only
 * loader; this CLI validates, installs and selects skins. It never touches
 * cordis.patch.yml — switching is a client-side atomic swap: an open page
 * follows the state file through the v2 active-state poll, and a page that
 * loads later picks the selection up through the tapIndex adapter.
 *
 * Commands:
 *   dsh-skin validate <dir>     validate a skin directory against the v2 contract
 *   dsh-skin install <dir>      validate, then copy into $DSH_HOME/skins/<id>/
 *                               [--force overwrites; hooks-bearing skins need --allow-hooks
 *                                and still only run their declarative parts (hooks require
 *                                in-repo review)]
 *   dsh-skin uninstall <id>     remove a user-installed skin (built-ins refuse)
 *   dsh-skin use <id>           select a skin (open pages follow within the poll interval)
 *   dsh-skin use official       restore the official stock look
 *   dsh-skin list               show the catalog (origin, warnings, diagnostics)
 *   dsh-skin current            print the selected skin id (or "none")
 *   dsh-skin bg get             print the effective background config (defaults filled in)
 *   dsh-skin bg set [flags]     merge-write background fields (values are clamped)
 *   dsh-skin bg reset           drop every background override (back to defaults)
 *
 * The validator/transformer are imported from the skin-center package's
 * built lib — never re-implemented here.
 */

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const LIB_PATH = path.join(__dirname, '..', 'lib', 'index.js')

/** One skin id: a plain directory name, never a path (mirrors the skin-center contract). */
const SKIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** One `bg` subcommand: a bare word, never a path or an option. */
const BG_SUBCOMMAND = /^[a-z][a-z-]{0,15}$/

/** Load the skin-center contract surface (ESM lib from this CJS CLI). */
async function loadLib() {
  try {
    return await import(pathToFileURL(LIB_PATH).href)
  } catch (error) {
    console.error('dsh-skin: cannot load the skin-center lib — run "pnpm --filter @linxin666/dsh-client-ui-skin-center build" first.')
    console.error(String(error && error.message ? error.message : error))
    process.exit(2)
  }
}

/**
 * The active-state and background helpers the `bg` group needs.
 *
 * Normally they come from the built lib above. A checkout can be one edit
 * ahead of its build, though (`scripts/` is never published, so this CLI only
 * ever runs from a checkout): when the lib predates these re-exports, read the
 * same helpers from their modules instead of failing the command. That is
 * still one implementation — the files the lib is built from, never a copy.
 * The source import needs Node's TypeScript type stripping (>= 22.18).
 */
async function loadStateLib(lib) {
  if (typeof lib.readActiveState === 'function' && typeof lib.normalizeSkinBackground === 'function') return lib
  const [state, background] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', 'src', 'active-state.ts')).href),
    import(pathToFileURL(path.join(__dirname, '..', 'src', 'core', 'background.ts')).href),
  ])
  return { ...lib, ...state, ...background }
}

/** Validate one skin directory; returns a report object. */
async function validateDir(lib, dir) {
  const report = { ok: true, errors: [], warnings: [], manifest: null }
  const manifestPath = path.join(dir, 'skin.json')
  if (!fs.existsSync(manifestPath)) {
    report.ok = false
    report.errors.push('skin.json not found')
    return report
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    report.ok = false
    report.errors.push(`skin.json is not valid JSON: ${error.message}`)
    return report
  }
  const result = lib.validateSkinManifestV2(raw)
  report.warnings.push(...result.warnings)
  if (!result.ok || !result.manifest) {
    report.ok = false
    report.errors.push(...result.errors)
    return report
  }
  report.manifest = result.manifest
  const dirName = path.basename(path.resolve(dir))
  if (result.manifest.id !== dirName) {
    report.warnings.push(`manifest id "${result.manifest.id}" differs from the directory name "${dirName}"`)
  }
  const stylesheets = [
    ['stylesheet', result.manifest.contributes.stylesheet],
    ['patches', result.manifest.contributes.patches],
  ]
  const auditEntries = []
  for (const [label, rel] of stylesheets) {
    if (!rel) continue
    const abs = path.join(dir, rel)
    if (!fs.existsSync(abs)) {
      report.ok = false
      report.errors.push(`${label}: ${rel} not found`)
      continue
    }
    const css = fs.readFileSync(abs, 'utf8')
    auditEntries.push({ filename: rel, css })
    try {
      const { warnings } = lib.transformSkinCss(css, {
        skinId: result.manifest.id,
        filename: rel,
      })
      report.warnings.push(...warnings)
    } catch (error) {
      report.ok = false
      if (error && Array.isArray(error.violations)) report.errors.push(...error.violations)
      else report.errors.push(`${label}: ${error.message}`)
    }
  }
  // Primary-action token contract audit (warning-only; the loader completes
  // partial sets, so gaps never block an install).
  if (auditEntries.length > 0) {
    report.warnings.push(...lib.auditTokenContract(auditEntries).warnings)
  }
  return report
}

function printReport(dir, report) {
  console.log(`dsh-skin validate: ${dir}`)
  if (report.manifest) console.log(`  id: ${report.manifest.id}  version: ${report.manifest.version}`)
  for (const warning of report.warnings) console.log(`  warning: ${warning}`)
  for (const error of report.errors) console.log(`  error: ${error}`)
  console.log(`  result: ${report.ok ? 'PASS' : 'FAIL'}`)
}

async function cmdValidate(dir) {
  if (!dir) return usage(1)
  const lib = await loadLib()
  const report = await validateDir(lib, dir)
  printReport(dir, report)
  process.exit(report.ok ? 0 : 1)
}

async function cmdInstall(dir, flags) {
  if (!dir) return usage(1)
  const lib = await loadLib()
  const report = await validateDir(lib, dir)
  printReport(dir, report)
  if (!report.ok) process.exit(1)
  if (report.manifest.facets && report.manifest.facets.client && !flags.has('--allow-hooks')) {
    console.error('dsh-skin: this skin declares hooks.mjs (trusted escape-hatch code).')
    console.error('  Hooks only execute for in-repo, same-review built-in skins; an installed copy')
    console.error('  will load its declarative parts only. Re-run with --allow-hooks to install anyway.')
    process.exit(1)
  }
  const target = path.join(lib.userSkinsDir(), report.manifest.id)
  if (fs.existsSync(target)) {
    if (!flags.has('--force')) {
      console.error(`dsh-skin: ${target} already exists (use --force to overwrite)`)
      process.exit(1)
    }
    fs.rmSync(target, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(path.resolve(dir), target, { recursive: true })
  console.log(`dsh-skin: installed ${report.manifest.id} -> ${target}`)
  console.log('dsh-skin: reopen the Skin Center card (or reload the GUI) to see it')
}

async function cmdUninstall(id) {
  if (!id) return usage(1)
  const lib = await loadLib()
  const userRoot = path.resolve(lib.userSkinsDir())
  const target = path.resolve(userRoot, id)
  // The id is raw argv: without this guard "uninstall .." resolves to $DSH_HOME
  // itself and the recursive delete below takes the whole home with it.
  if (!SKIN_ID.test(id) || !target.startsWith(userRoot + path.sep)) {
    console.error(`dsh-skin: refusing "${id}" — a skin id is a directory name, not a path`)
    process.exit(1)
  }
  if (!fs.existsSync(target)) {
    console.error(`dsh-skin: no user-installed skin "${id}" at ${target}`)
    process.exit(1)
  }
  fs.rmSync(target, { recursive: true, force: true })
  console.log(`dsh-skin: removed ${target}`)
}

async function cmdUse(id) {
  if (!id) return usage(1)
  const lib = await loadLib()
  const statePath = lib.defaultActiveStatePath()
  if (id === 'official') {
    lib.writeActiveSelection(statePath, null)
    console.log('dsh-skin: selection cleared (official stock look); an open GUI returns to it within a couple of seconds, a page opened later starts there')
    return
  }
  const catalog = lib.loadSkinCatalog()
  const entry = lib.findSkin(catalog, id)
  if (!entry) {
    console.error(`dsh-skin: unknown skin "${id}". Known: ${catalog.skins.map((s) => s.manifest.id).join(', ') || '(none)'}`)
    process.exit(1)
  }
  lib.writeActiveSelection(statePath, id)
  console.log(`dsh-skin: selected "${id}"; an open GUI applies it within a couple of seconds, a page opened later picks it up on load`)
}

async function cmdList() {
  const lib = await loadLib()
  const catalog = lib.loadSkinCatalog()
  const active = lib.readActiveSelection(lib.defaultActiveStatePath())
  console.log('dsh-skin list')
  for (const skin of catalog.skins) {
    const marker = skin.manifest.id === active ? ' (active)' : ''
    console.log(`  ${skin.manifest.id} [${skin.origin}] v${skin.manifest.version}${marker}`)
    for (const warning of skin.warnings) console.log(`    warning: ${warning}`)
  }
  for (const diag of catalog.diagnostics) {
    console.log(`  ! ${diag.subject} [${diag.origin}] excluded: ${diag.errors.join('; ')}`)
  }
  console.log(`active: ${active === null ? 'none (official)' : active}`)
}

/**
 * `dsh-skin doctor` — every problem the catalog found, and nothing else.
 *
 * `list` already prints the same warnings inline, and that is exactly how they
 * get skimmed past: an inventory reads as information, so a warning inside one
 * does too. This prints ONLY problems, exits non-zero when there are any, and is
 * therefore usable as a check in a script or a pre-commit hook. The skin-health
 * card was meant to be the in-GUI counterpart; it is not shipped (see
 * mods/README.md), so this is where a silent failure becomes visible today.
 */
async function cmdDoctor() {
  const lib = await loadLib()
  const catalog = lib.loadSkinCatalog()
  const active = lib.readActiveSelection(lib.defaultActiveStatePath())
  console.log('dsh-skin doctor')
  console.log(`  catalog: ${catalog.skins.length} skin(s), ${catalog.diagnostics.length} excluded`)
  console.log(`  active : ${active === null ? 'none (official look)' : active}`)

  let problems = 0
  for (const diag of catalog.diagnostics) {
    problems += 1
    console.log(`  ! excluded ${diag.subject} [${diag.origin}]`)
    for (const error of diag.errors) console.log(`      ${error}`)
  }
  for (const skin of catalog.skins) {
    if (skin.warnings.length === 0) continue
    problems += 1
    console.log(`  ! ${skin.manifest.id} [${skin.origin}]: ${skin.warnings.length} warning(s)`)
    for (const warning of skin.warnings) console.log(`      ${warning}`)
  }
  // A selection that is not in the catalog is silent in the GUI: the page simply
  // renders the official look, which reads as "the skin did nothing".
  if (active !== null && !catalog.skins.some((skin) => skin.manifest.id === active)) {
    problems += 1
    console.log(`  ! the active selection "${active}" is not in the catalog; the GUI falls back to the official look`)
  }
  console.log(problems === 0 ? '  no problems detected' : `  ${problems} problem(s)`)
  process.exit(problems === 0 ? 0 : 1)
}

async function cmdCurrent() {
  const lib = await loadLib()
  const active = lib.readActiveSelection(lib.defaultActiveStatePath())
  console.log(active === null ? 'none' : active)
}

/**
 * The background fields in the order `bg get` prints them, each with the flag
 * that writes it. The two per-state blurs share one flag because the GUI pairs
 * them in a single row.
 */
const BACKGROUND_FIELDS = [
  ['enabled', '--enabled'],
  ['backgroundOpacity', '--occlusion'],
  ['backgroundBlurEmpty', '--blur a/b'],
  ['backgroundBlurContent', '--blur a/b'],
  ['inputCardBlur', '--input-blur'],
  ['bubbleOpacity', '--bubble'],
  ['bubbleBlur', '--bubble-blur'],
]

/** One `bg set` flag mapped to the stored field it writes (the blurs are special). */
const BACKGROUND_VALUE_FLAGS = {
  '--enabled': 'enabled',
  '--occlusion': 'backgroundOpacity',
  '--input-blur': 'inputCardBlur',
  '--bubble': 'bubbleOpacity',
  '--bubble-blur': 'bubbleBlur',
}

/**
 * Parse one numeric flag value. Out-of-range input is accepted and clamped by
 * the shared normalizer later (the documented ranges are what the sliders
 * offer); a value that is not a finite number is rejected instead of silently
 * becoming 0.
 */
function parseBackgroundNumber(flag, raw) {
  if (raw.trim() === '') return { error: `${flag} needs a number` }
  const value = Number(raw)
  if (!Number.isFinite(value)) return { error: `${flag}: "${raw}" is not a number` }
  return { value }
}

/** Parse `bg set` argv into a background patch; `{ error }` on unusable input. */
function parseBackgroundPatch(args) {
  const patch = {}
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]
    const raw = args[i + 1]
    if (!flag.startsWith('--')) return { error: `unexpected argument "${flag}"` }
    if (raw === undefined || raw.startsWith('--')) return { error: `${flag} needs a value` }
    i += 1
    if (flag === '--blur') {
      const parts = raw.split('/')
      if (parts.length !== 2) return { error: `--blur takes <empty>/<content>, not "${raw}"` }
      const empty = parseBackgroundNumber('--blur (empty)', parts[0])
      if (empty.error) return empty
      const content = parseBackgroundNumber('--blur (content)', parts[1])
      if (content.error) return content
      patch.backgroundBlurEmpty = empty.value
      patch.backgroundBlurContent = content.value
      continue
    }
    const field = BACKGROUND_VALUE_FLAGS[flag]
    if (field === undefined) return { error: `unknown background flag "${flag}"` }
    if (field === 'enabled') {
      if (raw !== 'true' && raw !== 'false') return { error: `--enabled takes true or false, not "${raw}"` }
      patch.enabled = raw === 'true'
      continue
    }
    const parsed = parseBackgroundNumber(flag, raw)
    if (parsed.error) return parsed
    patch[field] = parsed.value
  }
  return { patch }
}

/**
 * Print the effective background config with every field's resolved value, so
 * an out-of-range or partial store never hides what is actually applied. The
 * marker says whether the field is an override at all: a field that is absent
 * resolves to its default, which is what distinguishes an explicitly stored 0
 * from a value that was never set.
 */
function printBackground(helpers, stored) {
  const effective = helpers.resolveSkinBackground(stored)
  if (stored === null) console.log('  stored: none (every field at its documented default)')
  for (const [field, flag] of BACKGROUND_FIELDS) {
    const marker = stored !== null && stored[field] !== undefined ? 'set' : 'default'
    console.log(`  ${field} (${flag}): ${effective[field]} (${marker})`)
  }
}

async function cmdBgGet(args) {
  if (args.length > 0) {
    console.error(`dsh-skin: bg get takes no arguments (got "${args[0]}")`)
    process.exit(1)
  }
  const helpers = await loadStateLib(await loadLib())
  const state = helpers.readActiveState(helpers.defaultActiveStatePath())
  console.log('dsh-skin bg get')
  printBackground(helpers, state.background)
}

async function cmdBgSet(args) {
  if (args.length === 0) return usage(1)
  const parsed = parseBackgroundPatch(args)
  if (parsed.error) {
    console.error(`dsh-skin: ${parsed.error}`)
    process.exit(1)
  }
  const helpers = await loadStateLib(await loadLib())
  const statePath = helpers.defaultActiveStatePath()
  const current = helpers.readActiveState(statePath).background ?? {}
  // Merge, then clamp through the shared normalizer: the CLI never invents a
  // range of its own, and an out-of-range value lands on the documented bound
  // instead of being rejected.
  const merged = helpers.normalizeSkinBackground({ ...current, ...parsed.patch })
  helpers.writeActiveState(statePath, { background: merged })
  console.log('dsh-skin: background updated')
  printBackground(helpers, merged)
}

async function cmdBgReset(args) {
  if (args.length > 0) {
    console.error(`dsh-skin: bg reset takes no arguments (got "${args[0]}")`)
    process.exit(1)
  }
  const helpers = await loadStateLib(await loadLib())
  const statePath = helpers.defaultActiveStatePath()
  // Drop the section instead of writing defaults back: the section means "the
  // user's overrides", and an absent key is what makes `bg get` report every
  // field as (default) again. writeActiveState omits a null background.
  helpers.writeActiveState(statePath, { background: null })
  console.log('dsh-skin: background overrides cleared')
  printBackground(helpers, null)
}

async function cmdBackground(sub, args) {
  if (sub === undefined) {
    console.error('dsh-skin: bg needs a subcommand (get, set or reset)')
    process.exit(1)
  }
  // The subcommand is raw argv: reject anything path- or option-shaped before
  // dispatching on it, the same way uninstall guards a skin id.
  if (!BG_SUBCOMMAND.test(sub)) {
    console.error(`dsh-skin: refusing "${sub}" — a bg subcommand is a bare word`)
    process.exit(1)
  }
  const run = { get: cmdBgGet, set: cmdBgSet, reset: cmdBgReset }[sub]
  if (run === undefined) {
    console.error(`dsh-skin: unknown bg command "${sub}" — get, set or reset`)
    process.exit(1)
  }
  return run(args)
}

function usage(exitCode) {
  console.log('dsh-skin — skin tooling for the DSH web GUI (v2)')
  console.log('')
  console.log('usage:')
  console.log('  dsh-skin validate <dir>          validate a skin directory against the v2 contract')
  console.log('  dsh-skin install <dir>           install into $DSH_HOME/skins/<id>/ [--force] [--allow-hooks]')
  console.log('  dsh-skin uninstall <id>          remove a user-installed skin')
  console.log('  dsh-skin use <id> | official     select a skin / restore the stock look (open pages follow in ~2s)')
  console.log('  dsh-skin list                    show the catalog with origins and diagnostics')
  console.log('  dsh-skin current                 print the selected skin id (or "none")')
  console.log('  dsh-skin bg get                  print the effective background config (defaults resolved,')
  console.log('                                   "(set)" marks a field that is an override)')
  console.log('  dsh-skin bg set [flags]          merge-write background fields (out-of-range values clamp)')
  console.log('                                     --enabled <true|false>   --occlusion <0-100>')
  console.log('                                     --blur <empty>/<content> (each 0-20)  --input-blur <0-20>')
  console.log('                                     --bubble <0-100>         --bubble-blur <0-20>')
  console.log('  dsh-skin bg reset                drop every background override (all fields back to defaults)')
  console.log('  dsh-skin doctor                  print only the problems the catalog found (excluded skins,')
  console.log('                                   warnings, a selection missing from the catalog); exits 1 if any')
  process.exit(exitCode)
}

async function main() {
  const [, , cmd, arg, ...rest] = process.argv
  const flags = new Set([arg, ...rest].filter((v) => typeof v === 'string' && v.startsWith('--')))
  const positional = arg !== undefined && arg.startsWith('--') ? undefined : arg
  switch (cmd) {
    case 'validate': return cmdValidate(positional)
    case 'install': return cmdInstall(positional, flags)
    case 'uninstall': return cmdUninstall(positional)
    case 'use': return cmdUse(positional)
    case 'list': return cmdList()
    case 'doctor': return cmdDoctor()
    case 'current': return cmdCurrent()
    case 'bg': return cmdBackground(arg, rest)
    default: return usage(cmd === undefined ? 0 : 1)
  }
}

module.exports = { validateDir, loadLib }

if (require.main === module) {
  main().catch((error) => {
    console.error(`dsh-skin: ${error && error.message ? error.message : error}`)
    process.exit(2)
  })
}
