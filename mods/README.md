# mods — patches against `@linxin666/dsh-client-ui-skin-center` v0.4.4

Nine unified diffs against **pristine upstream source**, with the pristine files
kept alongside so every change is reviewable without cloning upstream.

```
baseline/   pristine upstream files, exactly as published
patched/    the same files with all nine patches applied
*.patch     diff -u baseline/... patched/...
```

Apply, in order:

```sh
cd <upstream checkout>            # github.com/zhu1090093659/dsh-skins, or a sparse checkout
patch -p1 < mods/01-runtime-occlusion.patch
patch -p1 < mods/02-occlusion-tests.patch
patch -p1 < mods/03-backdrop-media-policy.patch
patch -p1 < mods/04-legacy-bridge-before-seed.patch
patch -p1 < mods/05-skin-id-single-pattern.patch
patch -p1 < mods/06-stylesheet-link-leak.patch
patch -p1 < mods/07-provenance-hygiene.patch
patch -p1 < mods/08-http-caching-and-integrity.patch
patch -p1 < mods/09-frost-and-detector-consistency.patch
```

`-p1` because the diffs carry the `src/…` / `tests/…` prefix, not a leading
directory of their own.

---

## 01-runtime-occlusion.patch — `src/client/background.ts`

**Problem.** `backgroundOpacity` only produced a body CSS variable
(`--dsw-skin-scrim`, see `SCRIM_VAR`). Nothing in the runtime painted a veil, so
the control is inert unless the *skin's* CSS consumes the variable. Most skins do
not: the community skin used during development consumes it **0 times**, the
bundled `blue-fantasy` 16 times. The card still shows the slider whenever the
manifest declares `backgroundMedia`, so the UI advertises a control that does
nothing on most skins.

**Change.** The controller now paints the veil itself.

- new body-level fixed layer, `data-dsh-backdrop-scrim`, at the blur layer's own
  `z-index: -1`, inserted **before** the blur layer so the blur samples the
  veiled backdrop rather than the raw video
- `background: var(--dsw-skin-scrim-color, #000)` + `opacity: value/100` — a skin
  can tint the veil, black is the neutral default since the numeric control
  carries no hue
- reuses the blur layer's whole lifecycle: removed under the master switch,
  removed while a Wallpaper Engine wallpaper owns the background (it carries its
  own dimming — two veils would double it), removed at 0, and no style write when
  the value is unchanged (`appliedScrim` cache)
- also fixes a pre-existing leak: `dispose()` left `--dsw-skin-scrim` on `body`

**Design note.** `syncScrim()` is called from **both** `applyOcclusion()` (the
value changed) and `syncBlur()` (the wallpaper / master-switch state transition).
The first version only hooked `syncBlur()` — it has six call sites and looked like
the broadest coverage — and the upstream test suite caught the gap immediately:
`controller.set(opacity)` does not go through `syncBlur`, so the value changed
and the layer did not. The fix was to the design, not to the test: the code that
applies the occlusion value owns painting it.

## 02-occlusion-tests.patch — `tests/background.spec.ts`

Four tests for the above: the veil is painted with the right geometry and opacity;
it disappears at 0; it stays off under the master switch and under a wallpaper;
`dispose()` leaves neither layer nor the variable behind.

It also retargets the existing `blurElement()` helper. That helper looked up "the
body's first `aria-hidden` div with `position: fixed`" — which the new veil also
matches, so it started answering with the wrong element. Both runtime backdrop
layers now carry their own attribute (`data-dsh-backdrop-blur`,
`data-dsh-backdrop-scrim`) and the helper addresses the layer it means. Those two
attributes are also the stable hooks third-party CSS needs.

## 03-backdrop-media-policy.patch — `src/client/runtime/decoration-layers.ts`

**Problem.** The manifest backdrop `<video>` (`buildBackgroundMedia`) had no
lifecycle policy at all: no pause while the document is hidden, no
`prefers-reduced-motion` handling (there is no `matchMedia` call anywhere in the
product except one button-transition query in CSS), no `poster`, no error path,
and no explicit `pause()` before detach.

This contradicts the repository's own performance contract
(`contracts/performance-guidelines-v1.md`, **R3**: "frame loops and infinite
animations must pause when hidden", with the prescribed `visibilitychange` +
`animation-play-state: paused` pattern) — and the Wallpaper Engine path already
does it (`src/client/wallpaper.ts`). One product, two standards.

**Change.**

- `clearLayer()` runs the media policy's teardown and calls `pause()` before
  detaching, so listeners cannot outlive the activation and a detached video
  cannot keep decoding
- `preload="metadata"` — a full-bleed loop can be several MB, and the default
  `auto` pulls all of it before first paint for a layer that may never be visible
- `data-dsh-backdrop-media`, a stable hook for `patches.css` and third parties
- `attachBackdropMediaPolicy()`: pause on `visibilitychange` hidden, resume on
  visible; under `prefers-reduced-motion: reduce`, do not autoplay — decode one
  frame and hold it, so a reduced-motion viewer still gets the artwork
- the listeners and the `MediaQueryList` are registered in a module-local
  `WeakMap` teardown (contract R6: every listener must be torn down in reverse)

---

## 04-legacy-bridge-before-seed.patch — `src/index.ts`

**Problem.** The plugin seeded the default skin *before* running the legacy v1→v2
bridge. The bridge reads the v2 selection first and stands down when one is
already persisted, but it strips the legacy section regardless. So on a v1
upgrade the seed wrote `blue-fantasy` into the empty v2 store, the bridge saw a
selection and skipped the id migration, and the legacy rows were deleted anyway:
**the user's chosen skin was silently lost, with no error anywhere.** The comment
above the seed claimed the opposite of what the code did.

**Change.** Run the bridge first, then the seed. Nothing else moves; the comment
now records why the order is semantic rather than incidental.

## 05-skin-id-single-pattern.patch — `validate.ts`, `tap-index-adapter.ts`, two specs

**Problem.** Two different skin-id patterns. The manifest validator accepted
`^[a-z][a-z0-9-]{0,31}$`, so `a-` and `x--y` validated; the index injector
required kebab-case and threw on them. The bootstrap catches that throw and
degrades to the stock look, so **such a skin installed cleanly and then never
rendered**, with no error the user could see.

**Change.** One exported `SKIN_ID_PATTERN`, read by both. Kebab-case is the shape
this project's own scaffolding produces, so the gate moves to match the renderer
and a bad id now fails validation with a readable message. All 53 published skin
ids were checked against both patterns before tightening; every one satisfies both.

## 06-stylesheet-link-leak.patch — `skin-controller.ts`, `skin-runtime.spec.ts`

**Problem.** `trackStylesheet` registered its teardown by *looking the link up
again by href*. The server pre-renders a link with the same href for first paint
(`tap-index-adapter`), and it sits earlier in `<head>`, so the lookup always
answered with **that** node: every activation removed the pre-rendered link and
leaked the one it had just created. The head grew by up to two links per switch,
each one an extra style recalculation, for the life of the page.

**Change.** The loader hands back the element it created and the teardown removes
that exact node. A void return stays legal, so an injected loader keeps the old
best-effort lookup.

**Correction to the survey.** The report claimed a leaked `patches` link could
keep painting under another skin. That is **wrong**: `transformSkinCss` force-scopes
every selector in both `skin.css` and `patches.css`, so a stale link's rules are
inert once `html[data-dsh-skin]` flips. The real cost is unbounded `<head>` growth
and style-recalculation work, which is what the new test pins (boundedness, not
emptiness — the pre-rendered link belongs to no activation and legitimately
survives).

---

## 07-provenance-hygiene.patch — `provenance.ts`, `active-state.ts`, two specs

Three defects in the security-adjacent persistence layer.

**(a) A spin loop blocked the event loop.** `repairSkinFromMarket` waited for the
just-removed destination's directory entry to settle (Windows indexer/AV →
transient `EBUSY`/`EPERM`) with `while (Date.now() - start < 50) {}`. A synchronous
spin cannot help a synchronous syscall — it only freezes the host for up to 50 ms.
Replaced with an exported async `renameWithRetry`: awaited `setTimeout` backoff
(10 ms doubling, 1 s budget), retrying only transient codes, rethrowing others
immediately and the last transient after the budget. Same failure semantics.

**(b) Temporary directories leaked on crash.** The atomic write and the repair
paths create a sibling temp dir and remove it in a `finally`; a process that dies
mid-write leaves it forever and nothing swept them. Added `sweepStaleTempDirs`
with per-module exact name patterns, a 1 h staleness threshold, directory-only,
never recursing or throwing, throttled to one sweep per minute per directory so a
per-request write does not gain a directory listing.

**(c) The file that gates hook trust could assert market origin for local bytes.**
The repair path wrote `source: 'dsh-market.com'` provenance for a copy taken from
the package's **own** bundled `skins/` directory. Provenance is what later decides
whether a user-directory skin's `hooks.mjs` may execute, so locally-produced bytes
carried an origin claim that was false. New `LOCAL_PROVENANCE_SOURCE = 'local'` for
that path: a local document is still integrity-verifiable but is **not**
market-trusted, so its hooks are refused; a bundled copy is instead trusted
through the reviewed-hooks registry when its bytes match. Market installs keep
their trust, unchanged.

> The sweeper uses `opendirSync` rather than `readdirSync` because
> `tests/catalog-cache.spec.ts` counts global `readdirSync` calls to prove that a
> state write never rescans the skin catalog. The sweep only enumerates the state
> directory, never a catalog root, so the equivalent primitive keeps that
> assertion honest without editing a spec outside this change's scope.

## 08-http-caching-and-integrity.patch — `routes-v2.ts`, `skin-repo.ts`, two specs

**(a) Assets were fully buffered, uncacheable and unseekable.** Every
`assets/`/`preview/` request did a `readFileSync` into memory and answered
`200` + `cache-control: no-store`, with no `ETag`, no `Last-Modified` and no
`Range`. A 6.6 MiB background video was therefore re-downloaded in full on every
reload, and the host held a whole copy per request. Now: one `statSync` derives a
strong `ETag` and `Last-Modified`, `Accept-Ranges: bytes` is advertised,
`If-None-Match` (list, `*`, weak-tolerant; takes precedence over
`If-Modified-Since`) answers `304` with no body, a single `bytes=` range answers
`206` + `Content-Range: bytes s-e/size`, an unsatisfiable range answers `416` +
`bytes */size`, and the body streams via `createReadStream` + `pipeline` with the
descriptor lifetime tied to the response closing.

> `bytes=-N` is implemented as the **last N bytes**, deliberately diverging from
> the responder in `src/we-routes.ts`, whose `/(\d*)-(\d*)/` turns `bytes=-500`
> into `0-500`. That bug is still present there; this patch does not copy it.

**(b) The CSS transform ran again on every stylesheet request.** It is a pure
function of (skin id, filename, file bytes), so it is now memoised on
`(skinId, filename, mtimeMs, size)` with a hard cap of 64 entries (≈32 installed
skins × 2 stylesheets, a few MB worst case, cannot grow with request count),
evicting the least-recently-served key. Failures are never cached — a whitelist
violation still answers `422` on every request.

**(c) The integrity route auto-repaired by default.** `POST /v2/verify` defaulted
to `autoRepair: true`, so any caller could trigger a download from dsh-market.com
that **replaces user skin directories** without asking. The default is now a
read-only report; `{"autoRepair": true}` keeps working. `POST /verify` was also
missing from the header comment that enumerates the routes.

**(d) A manifest could reference an unservable path and 404 silently.** The
validator accepts any relative path, but only `assets/` and `preview/` are routed,
so `media/bg.webp` validated, installed, and then silently failed to load. The
catalog scan now emits a warning for such a reference. Warning only — the skin
still installs, and the validator's grammar is unchanged.

## 09-frost-and-detector-consistency.patch — `backdrop-scene.ts`, `background.ts` via patch 01, three specs

**(a) The master switch did not turn the composer frost off.** The composer frost
was applied by a **stylesheet** rule in the neutralizer sheet,
`blur(var(--dsh-input-card-blur, 10px)) !important`. Two consequences: the
`!important` sheet rule outranked any runtime value, and its 10 px fallback
survived the master switch — which *removes* the variable — so "off" blurred the
composer at 10 px, worse than an explicit 0. The rule is gone; the runtime now
reads `--dsh-input-card-blur` from `document.body`'s computed style and paints the
blur inline on the body-level follower. Absent variable ⇒ no follower, no blur;
present-but-unparseable ⇒ the 10 px compatibility default; otherwise clamped 0–20
with 0 meaning off. A body `style` attribute observation re-evaluates it live, so
the slider and the switch take effect without a remount.

The `#1724` invariant is preserved: the blur still lives on a separate body-level
sibling, never on the composer card (a non-none `backdrop-filter` on the card
makes it the containing block for the shell's `position:fixed` tooltips).

**(b) Two divergent "the conversation has content" detectors.** `background.ts`
matched a **bare** `[data-chat-anchor-key]` anywhere in the document, while
`backdrop-scene.ts` scoped to `[data-conversation-scroll]` and documented stale
topic-picker rows as the exact reason. Switching to an empty topic could therefore
leave the backdrop blur and the frost disagreeing. Both now read one exported,
scrollport-scoped selector; the bare form is gone while every official-shell row
suffix the old selector covered is retained in both scopes.

> One assertion pair in `tests/wallpaper.spec.ts` pinned the removed sheet rule
> and was updated to assert the sheet carries no frost rule.

---

## Verification

Run in an upstream checkout with the patches applied:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 652 passed / 15 failed — **zero regressions**, see below |
| `pnpm build` | succeeds; every change marker present in the bundle |

Controlled experiment, both runs in the identical `skins/` state:

| | tests | failed | passed |
|---|---|---|---|
| pristine upstream | 639 | 15 | 624 |
| these patches | 667 | 15 | **652** |

Same failure set. All 15 are `ENOENT` / `Cannot find module` for the repository's
**market-skin test fixtures** (`matrix`, `maid-atelier`, `orca-link`, `whale-mom`,
`ice-princess`, `mint`, `phoebe-atelier`, `wallpaper-exclusive`, `last-exile`,
`porco-rosso`, `white-snake`) — those skins are not in the npm package (`files`
whitelists only `skins/blue-fantasy`), so they are absent from a source-only
checkout. **Zero AssertionError / TypeError / ReferenceError** on both sides of the
experiment. The 28 added tests all pass (652 − 624), and every fix in this series
was individually proven to fail when its source change is reverted.

Reproducibility: applying the nine patches to the pristine files reproduces
`patched/` byte-for-byte (21 files, one of them new).

## Not included

The remaining items are in `../MODDING-REPORT.md` with location, effort and
whether they need a contract change. Three are deliberately held back rather than
overlooked:

- **Per-skin recommended background values** (`tuning` block in `skin.json`) — the
  field is additive, but the v2 schema is `additionalProperties: false`, so
  *older* skin-center versions would reject a skin that uses it. That is a
  compatibility decision for the maintainer, not a mechanical fix.
- **Contrast / legibility audit** against the real background media — a new
  analysis, not an optimisation of existing code.
- **Anchor robustness** across host rebuilds — an architectural change to the
  semantic adapter, and the largest item on the list.
