/**
 * Renders the skin's preview images with headless Chrome.
 *
 * Honesty contract: the preview is an "over frame N of the loop" render of the
 * skin's real stylesheets. It is NOT a live DSH screenshot. The CSS that goes
 * into it is the *output of the skin-center's own transformSkinCss* — the exact
 * bytes the loader would inject — so what you see is what the loader paints,
 * including the fail-closed fallback derivations.
 *
 * Two variants are produced:
 *   preview/dark.jpg   the normal case (body[data-ds-dark-theme])
 *   preview/light.jpg  the same DOM with the dark attribute REMOVED, which is
 *                      the "a light-mode host leaked through" case. The skin
 *                      declares identical values in its light block, so the two
 *                      renders must be visually identical — that is the point
 *                      of shipping both.
 *
 *   node build/render-preview.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

import { transformSkinCss } from './validator/transform.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
// Which skin to render: node build/render-preview.mjs [skin-id]
const SKIN_ID = process.argv[2] ?? 'cyber-maiden'
const SKIN_DIR = join(ROOT, SKIN_ID)
const OUT = join(HERE, '.render', SKIN_ID)

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
if (!existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME}`)
  process.exit(1)
}

// ---------------------------------------------------------------- CSS
mkdirSync(OUT, { recursive: true })
const manifest = JSON.parse(readFileSync(join(SKIN_DIR, 'skin.json'), 'utf8'))

// Grab the still the preview is rendered over, straight out of the skin's own
// background asset — the preview must show the skin over the loop it ships,
// not over some hand-picked image that lives only on this machine.
const VIDEO = join(SKIN_DIR, manifest.contributes.backgroundMedia.dark.src)
const FF = existsSync(join(HERE, 'bin', 'ffmpeg')) ? join(HERE, 'bin', 'ffmpeg') : 'ffmpeg'
const FRAME_AT = '1.8'
execFileSync(FF, ['-v', 'error', '-y', '-ss', FRAME_AT, '-i', VIDEO, '-frames:v', '1', '-q:v', '2', join(OUT, 'frame.jpg')], {
  stdio: 'ignore',
})
console.log(`background still: ${FRAME_AT}s of ${VIDEO.replace(ROOT + '/', '')}`)

const main = transformSkinCss(readFileSync(join(SKIN_DIR, manifest.contributes.stylesheet), 'utf8'), {
  skinId: SKIN_ID,
  filename: manifest.contributes.stylesheet,
  deriveFallbacks: true,
})
const patches = transformSkinCss(readFileSync(join(SKIN_DIR, manifest.contributes.patches), 'utf8'), {
  skinId: SKIN_ID,
  filename: manifest.contributes.patches,
  deriveFallbacks: false,
})
writeFileSync(join(OUT, 'skin.scoped.css'), main.code)
writeFileSync(join(OUT, 'patches.scoped.css'), patches.code)
console.log(`transformed CSS: skin ${main.code.length} chars, patches ${patches.code.length} chars`)
for (const w of [...main.warnings, ...patches.warnings]) console.log(`  WARN ${w}`)

// ---------------------------------------------------------------- HTML
// A reduced but faithful stand-in for the official shell: same semantic
// attributes the compat adapter maintains, so patches.css really applies.
const WELCOME = '探索未至之境'
// Read the scrim from the manifest so the preview can never drift from what
// the loader will actually paint over the video.
const MOCK_SCRIM =
  manifest.contributes.backgroundMedia.dark.scrim ?? 'linear-gradient(180deg, rgba(4,7,14,0) 0%, rgba(4,7,14,0.26) 100%)'
const mock = (dark) => `<!doctype html>
<html lang="zh-CN" data-dsh-skin="${SKIN_ID}">
<head>
<meta charset="utf-8">
<style>
  /* The official shell's own opaque #root background is neutralised by the
     loader; the mock reproduces that so the backdrop stage is visible. */
  html, body { margin: 0; height: 100%; overflow: hidden; }
  #root { background: transparent; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 'Segoe UI Variable Text', DengXian, system-ui, sans-serif; }

  /* the skin's backdrop stage: the loop, cover-fitted, at frame t=1.8s */
  .stage { position: fixed; inset: 0; z-index: -1; }
  .stage img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .stage::after { content: ''; position: absolute; inset: 0;
    background: ${MOCK_SCRIM}; }

  .shell { display: grid; grid-template-columns: 264px 1fr; height: 100%; }

  /* ---- sidebar ---- */
  .side { display: flex; flex-direction: column; gap: 6px; padding: 12px 10px; }
  .brand { display: flex; align-items: center; gap: 7px; padding: 4px 6px 10px; color: #DCE7F5;
    font-weight: 600; letter-spacing: .2px; }
  .brand .whale { font-size: 15px; }
  .brand .tag { font-size: 9px; letter-spacing: 1.4px; padding: 2px 5px; border: 1px solid #2A477073;
    border-radius: 3px; color: #93A9C6; }
  .newsession { display: flex; align-items: center; justify-content: center; gap: 6px;
    height: 34px; border: 1px solid transparent; border-radius: 7px; color: #EAF2FF;
    font-size: 13px; font-weight: 600; }
  .icons { display: flex; gap: 6px; padding: 6px 4px 2px; color: #6A80A0; font-size: 14px; }
  .label { padding: 8px 6px 2px; font-size: 11px; letter-spacing: .6px; text-transform: uppercase; color: #6A80A0; }
  .tree { display: flex; flex-direction: column; }
  .ws { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 5px;
    color: #DCE7F5; background-color: #2A47704D; }
  .task { padding: 5px 8px 5px 26px; color: #93A9C6; border-radius: 5px; }
  .task.on { background-color: #2F63B81A; color: #DCE7F5; }
  .task .n { float: right; color: #4A5C7A; font-size: 11px; }
  .spacer { flex: 1; }
  .foot { display: flex; justify-content: space-between; padding: 8px 8px 4px; color: #6A80A0; }

  /* ---- center ---- */
  .center { position: relative; display: flex; flex-direction: column; }
  .chead { display: flex; align-items: center; gap: 8px; height: 46px; padding: 0 14px; }
  .chead .t { color: #DCE7F5; font-weight: 600; }
  .chead .pill { font-size: 10px; padding: 1px 6px; border-radius: 999px;
    background-color: #2F63B829; color: #6FA3E8; }
  .hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; }
  .hero h1 { margin: 0; display: flex; align-items: center; gap: 10px; font-size: 27px;
    font-weight: 600; color: #DCE7F5; letter-spacing: .5px; }
  .chips { display: flex; gap: 8px; }
  .chip { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px;
    border: 1px solid #2A477073; background-color: #080F1C80; color: #93A9C6; font-size: 12px; }
  .card { width: min(680px, 82%); border-radius: 12px; padding: 12px 12px 10px; }
  .card .ph { color: #4A5C7A; font-size: 14px; }
  .card .row { display: flex; align-items: center; gap: 8px; padding-top: 26px; color: #6A80A0; }
  .row .send { margin-left: auto; width: 26px; height: 26px; border-radius: 50%;
    background-color: #2F63B8; color: #EAF2FF; display: grid; place-items: center; font-size: 13px; }
  .cfoot { padding: 10px 14px; color: #4A5C7A; font-size: 11px; }
</style>
<link rel="stylesheet" href="skin.scoped.css">
<link rel="stylesheet" href="patches.scoped.css">
</head>
<body${dark ? ' data-ds-dark-theme' : ''}>
  <div class="stage"><img src="frame.jpg" alt=""></div>
  <div id="root">
    <div class="shell">
      <nav class="side" data-dsh-surface="sidebar">
        <div class="brand"><span class="whale">&#128011;</span>deepseek<span class="tag">HARNESS</span></div>
        <div class="newsession" data-dsh-part="new-session">&#8853; New Session</div>
        <div class="icons"><span>&#9635;</span><span>&#9636;</span></div>
        <div class="label">Workspaces</div>
        <div class="tree">
          <div class="ws">&#128193; dsh-web</div>
          <div class="task on" aria-current="page">Refactor the skin layer</div>
          <div class="task">Tidy up group README <span class="n">2d</span></div>
          <div class="task">Demo session <span class="n">3d</span></div>
          <div class="ws">&#128193; deepseek-harness</div>
          <div class="task">Fix deploy script <span class="n">1h</span></div>
          <div class="ws">&#128193; ${SKIN_ID}</div>
        </div>
        <div class="spacer"></div>
        <div class="foot"><span>&#9881; Plan</span><span>&#128222;</span></div>
      </nav>
      <main class="center" data-dsh-surface="conversation">
        <div class="chead" data-dsh-surface="session-header">
          <span class="t">${SKIN_ID}</span><span class="pill">Preview</span>
        </div>
        <div class="hero">
          <h1><span>&#128011;</span>${WELCOME}</h1>
          <div class="chips"><span class="chip">&#128193; 工作目录</span><span class="chip">&#129302; 模型</span></div>
          <div class="card" data-dsh-surface="composer">
            <div data-dsh-part="composer-input">
              <div class="ph">描述你想要构建的内容，或直接粘贴一个 URL</div>
              <div class="row"><span>+</span><span>&#128737;</span><span class="send">&#8593;</span></div>
            </div>
          </div>
        </div>
        <div class="cfoot">Enter 发送 · Shift+Enter 换行</div>
      </main>
    </div>
  </div>
</body>
</html>`

// ---------------------------------------------------------------- shoot
function shoot(dark, outFile, size) {
  const html = join(OUT, `mock-${dark ? 'dark' : 'light'}.html`)
  writeFileSync(html, mock(dark))
  const png = join(OUT, `${dark ? 'dark' : 'light'}.png`)
  rmSync(png, { force: true })
  // Chrome writes the PNG and then fails to exit cleanly under the harness
  // sandbox (its own sandbox cannot initialise, so crashpad retries forever).
  // We therefore ignore the exit status and only require the artefact.
  spawnSync(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-crash-reporter',
      '--disable-breakpad',
      `--crash-dumps-dir=${join(OUT, 'crash')}`,
      `--user-data-dir=${join(OUT, 'chrome-profile')}`,
      '--force-device-scale-factor=1',
      `--window-size=${size}`,
      `--screenshot=${png}`,
      '--virtual-time-budget=2500',
      `file://${html}`,
    ],
    { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' },
  )
  if (!existsSync(png)) throw new Error(`Chrome produced no screenshot for the ${dark ? 'dark' : 'light'} render`)
  // Chrome only writes PNG; the manifest (and the market) want real JPEG bytes.
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', png, '--out', outFile], {
    stdio: 'ignore',
  })
  console.log(`wrote ${outFile} (${size}, ${(statSync(outFile).size / 1024).toFixed(0)} KiB)`)
}

mkdirSync(join(SKIN_DIR, 'preview'), { recursive: true })
shoot(true, join(SKIN_DIR, 'preview', 'dark.jpg'), '1600,1000')
shoot(false, join(SKIN_DIR, 'preview', 'light.jpg'), '1600,1000')

// the light render must be byte-identical in look: compare the two PNGs
const a = readFileSync(join(OUT, 'dark.png'))
const b = readFileSync(join(OUT, 'light.png'))
console.log(
  a.equals(b)
    ? 'light render === dark render : no light-mode leak (identical bytes)'
    : 'WARNING: light and dark renders differ — a light-mode host would leak stock tokens',
)
