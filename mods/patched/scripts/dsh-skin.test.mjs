/**
 * Tests for scripts/dsh-skin (v2): validate / install / use / list / current /
 * bg against throwaway DSH_HOME / DSH_SKINS_HOME, so the real ~/.dsh is never
 * touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./dsh-skin.cjs', import.meta.url))

function fixtureSkin(root, id, extra = {}) {
  const dir = join(root, id)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'skin.json'), JSON.stringify({
    skinManifestVersion: 2,
    id,
    name: id,
    nameEn: id,
    version: '1.0.0',
    author: 'tester',
    contributes: { stylesheet: 'skin.css' },
    ...extra,
  }))
  writeFileSync(join(dir, 'skin.css'), ':root { --dsw-alias-bg-base: #112233; }\n')
  return dir
}

function run(args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-skin-cli-'))
  const fullEnv = { ...process.env, DSH_HOME: join(home, '.dsh'), ...env }
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { env: fullEnv, encoding: 'utf8' })
    return { code: 0, out, home }
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? ''), home }
  }
}

/** The v2 active-state document inside one throwaway DSH_HOME. */
function stateFile(home) {
  return join(home, '.dsh', 'skin-center-active.json')
}

test('validate passes a well-formed skin', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'demo')
  const r = run(['validate', dir])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /result: PASS/)
  rmSync(root, { recursive: true, force: true })
})

test('validate fails closed on a whitelist violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'evil')
  writeFileSync(join(dir, 'skin.css'), '.a { background: url(https://evil.example/x.png); }\n')
  const r = run(['validate', dir])
  assert.equal(r.code, 1)
  assert.match(r.out, /remote URL/)
  rmSync(root, { recursive: true, force: true })
})

test('install copies a valid skin into the user skins dir; uninstall removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'demo')
  const install = run(['install', dir])
  assert.equal(install.code, 0, install.out)
  const installed = join(install.home, '.dsh', 'skins', 'demo')
  assert.ok(existsSync(join(installed, 'skin.json')))
  // Second install refuses without --force.
  const again = run(['install', dir], { DSH_HOME: join(install.home, '.dsh') })
  assert.equal(again.code, 1)
  assert.match(again.out, /already exists/)
  const forced = run(['install', dir, '--force'], { DSH_HOME: join(install.home, '.dsh') })
  assert.equal(forced.code, 0, forced.out)
  const uninstall = run(['uninstall', 'demo'], { DSH_HOME: join(install.home, '.dsh') })
  assert.equal(uninstall.code, 0, uninstall.out)
  assert.ok(!existsSync(installed))
  rmSync(root, { recursive: true, force: true })
})

test('uninstall refuses a path-shaped id instead of removing the home that contains it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'demo')
  const install = run(['install', dir])
  assert.equal(install.code, 0, install.out)
  const home = join(install.home, '.dsh')
  const marker = join(home, 'settings.yaml')
  writeFileSync(marker, 'ui-onboarding: {}\n')

  const traversal = run(['uninstall', '..'], { DSH_HOME: home })
  const dot = run(['uninstall', '.'], { DSH_HOME: home })
  const nested = run(['uninstall', 'sub/../..'], { DSH_HOME: home })

  assert.equal(traversal.code, 1, traversal.out)
  assert.equal(dot.code, 1, dot.out)
  assert.equal(nested.code, 1, nested.out)
  assert.match(traversal.out, /not a path/)
  assert.ok(existsSync(marker), 'the home beside the skins dir must survive')
  assert.ok(existsSync(join(home, 'skins', 'demo', 'skin.json')), 'the installed skin must survive')
  rmSync(root, { recursive: true, force: true })
})

test('install refuses hooks-bearing skins without --allow-hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'hooked', {
    facets: { client: { entry: 'hooks.mjs', apiVersion: 'x-org.linxin666.skin-center/v1alpha1' } },
  })
  writeFileSync(join(dir, 'hooks.mjs'), 'export default () => ({ apply() {} })\n')
  const r = run(['install', dir])
  assert.equal(r.code, 1)
  assert.match(r.out, /--allow-hooks/)
  const allowed = run(['install', dir, '--allow-hooks'], { DSH_HOME: join(r.home, '.dsh') })
  assert.equal(allowed.code, 0, allowed.out)
  rmSync(root, { recursive: true, force: true })
})

test('use writes the selection; current reads it; official clears it', () => {
  const use = run(['use', 'harbor'])
  assert.equal(use.code, 0, use.out)
  const env = { DSH_HOME: join(use.home, '.dsh') }
  const current = run(['current'], env)
  assert.equal(current.out.trim(), 'harbor')
  const off = run(['use', 'official'], env)
  assert.equal(off.code, 0, off.out)
  const after = run(['current'], env)
  assert.equal(after.out.trim(), 'none')
})

test('use reports the live apply instead of a reload', () => {
  // An open page converges through the v2 poll, so "reload the GUI to apply"
  // was wrong twice over: it undersold the follow and hid the no-page case.
  const use = run(['use', 'blue-fantasy'])
  assert.equal(use.code, 0, use.out)
  assert.match(use.out, /open GUI applies it within a couple of seconds/)
  assert.match(use.out, /a page opened later picks it up on load/)
  assert.ok(!/reload the GUI/.test(use.out), use.out)

  const off = run(['use', 'official'], { DSH_HOME: join(use.home, '.dsh') })
  assert.equal(off.code, 0, off.out)
  assert.match(off.out, /open GUI returns to it within a couple of seconds/)
  assert.match(off.out, /a page opened later starts there/)
  assert.ok(!/reload the GUI/.test(off.out), off.out)
})

test('bg get resolves field defaults and marks stored overrides', () => {
  const fresh = run(['bg', 'get'])
  assert.equal(fresh.code, 0, fresh.out)
  assert.match(fresh.out, /stored: none \(every field at its documented default\)/)
  assert.match(fresh.out, /enabled \(--enabled\): true \(default\)/)
  assert.match(fresh.out, /inputCardBlur \(--input-blur\): 10 \(default\)/)
  assert.match(fresh.out, /bubbleOpacity \(--bubble\): 50 \(default\)/)

  // An explicitly stored 0 must read differently from a field that was never
  // set, which is the whole reason the marker follows the document, not the
  // value.
  const env = { DSH_HOME: join(fresh.home, '.dsh') }
  const set = run(['bg', 'set', '--occlusion', '0'], env)
  assert.equal(set.code, 0, set.out)
  const after = run(['bg', 'get'], env)
  assert.match(after.out, /backgroundOpacity \(--occlusion\): 0 \(set\)/)
  assert.match(after.out, /inputCardBlur \(--input-blur\): 10 \(default\)/)
  assert.ok(!/stored: none/.test(after.out), after.out)
})

test('bg set clamps out-of-range values instead of rejecting them', () => {
  const r = run(['bg', 'set', '--occlusion', '150', '--blur', '40/-3', '--input-blur', '21', '--bubble', '999', '--bubble-blur', '99.6'])
  assert.equal(r.code, 0, r.out)
  const env = { DSH_HOME: join(r.home, '.dsh') }
  const get = run(['bg', 'get'], env)
  assert.match(get.out, /backgroundOpacity \(--occlusion\): 100 \(set\)/)
  assert.match(get.out, /backgroundBlurEmpty \(--blur a\/b\): 20 \(set\)/)
  assert.match(get.out, /backgroundBlurContent \(--blur a\/b\): 0 \(set\)/)
  assert.match(get.out, /inputCardBlur \(--input-blur\): 20 \(set\)/)
  assert.match(get.out, /bubbleOpacity \(--bubble\): 100 \(set\)/)
  assert.match(get.out, /bubbleBlur \(--bubble-blur\): 20 \(set\)/)
  // The document carries the clamped values, not the raw input.
  const document = JSON.parse(readFileSync(stateFile(r.home), 'utf8'))
  assert.deepEqual(document.background, {
    backgroundOpacity: 100,
    backgroundBlurEmpty: 20,
    backgroundBlurContent: 0,
    inputCardBlur: 20,
    bubbleOpacity: 100,
    bubbleBlur: 20,
  })
})

test('bg set rejects values it cannot parse and writes nothing', () => {
  const cases = [
    [['--occlusion', 'abc'], /--occlusion: "abc" is not a number/],
    [['--occlusion', '1e999'], /--occlusion: "1e999" is not a number/],
    [['--blur', '3'], /--blur takes <empty>\/<content>, not "3"/],
    [['--enabled', 'maybe'], /--enabled takes true or false, not "maybe"/],
    [['--bogus', '1'], /unknown background flag "--bogus"/],
    [['--bubble'], /--bubble needs a value/],
    [['30'], /unexpected argument "30"/],
  ]
  for (const [args, pattern] of cases) {
    const r = run(['bg', 'set', ...args])
    assert.equal(r.code, 1, `${args.join(' ')} -> ${r.out}`)
    assert.match(r.out, pattern)
    assert.ok(!existsSync(stateFile(r.home)), `a rejected write must not touch the state file (${args.join(' ')})`)
  }
})

test('bg reset drops every override and keeps the selection', () => {
  const use = run(['use', 'blue-fantasy'])
  assert.equal(use.code, 0, use.out)
  const env = { DSH_HOME: join(use.home, '.dsh') }
  const set = run(['bg', 'set', '--occlusion', '30', '--blur', '4/6'], env)
  assert.equal(set.code, 0, set.out)

  const reset = run(['bg', 'reset'], env)
  assert.equal(reset.code, 0, reset.out)
  const after = run(['bg', 'get'], env)
  assert.match(after.out, /stored: none/)
  const fieldLines = after.out.trim().split('\n').filter((line) => line.startsWith('  ') && !line.includes('stored:'))
  assert.equal(fieldLines.length, 7, after.out)
  for (const line of fieldLines) assert.match(line, /\(default\)/, line)

  // The override key is gone entirely (that is what makes the next `bg get`
  // report defaults), and the selection it sat beside survives.
  const document = JSON.parse(readFileSync(stateFile(use.home), 'utf8'))
  assert.equal('background' in document, false)
  assert.equal(run(['current'], env).out.trim(), 'blue-fantasy')
})

test('bg refuses an unknown, path-shaped or over-argumented invocation', () => {
  const cases = [
    [['bg'], /bg needs a subcommand/],
    [['bg', '../etc'], /bare word/],
    [['bg', 'bogus'], /unknown bg command "bogus"/],
    [['bg', 'get', 'extra'], /bg get takes no arguments/],
    [['bg', 'reset', '--occlusion', '5'], /bg reset takes no arguments/],
  ]
  for (const [args, pattern] of cases) {
    const r = run(args)
    assert.equal(r.code, 1, `${args.join(' ')} -> ${r.out}`)
    assert.match(r.out, pattern)
  }
})

test('use rejects an unknown skin', () => {
  const r = run(['use', 'no-such-skin'])
  assert.equal(r.code, 1)
  assert.match(r.out, /unknown skin/)
})

test('list shows builtin skins and diagnostics', () => {
  const r = run(['list'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /harbor \[builtin\]/)
  assert.match(r.out, /active:/)
})
test('validate warns (not fails) on a partial primary-action token set', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skin-fixture-'))
  const dir = fixtureSkin(root, 'halftone')
  writeFileSync(join(dir, 'skin.css'), [
    ':root {',
    '  --dsw-alias-button-primary-fill: #2fbf8f;',
    '  --dsw-alias-button-primary-hover: #45cba0;',
    '}',
  ].join('\n'))
  const r = run(['validate', dir])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /warning: primary action contract: "label-primary-foreground" is not defined/)
  assert.match(r.out, /warning: primary action contrast/)
  rmSync(root, { recursive: true, force: true })
})
