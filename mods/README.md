# mods — patches against `@linxin666/dsh-client-ui-skin-center` v0.4.4

Six unified diffs against **pristine upstream source**, with the pristine files
kept alongside so every change is reviewable without cloning upstream.

```
baseline/   pristine upstream files, exactly as published
patched/    the same files with all six patches applied
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

## Verification

Run in an upstream checkout with the patches applied:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 631 passed / 15 failed — **zero regressions**, see below |
| `pnpm build` | succeeds; every change marker present in the bundle |

Controlled experiment, both runs in the identical `skins/` state:

| | tests | failed | passed |
|---|---|---|---|
| pristine upstream | 639 | 15 | 624 |
| these patches | 646 | 15 | **631** |

Same failure set. All 15 are `ENOENT` / `Cannot find module` for the repository's
**market-skin test fixtures** (`matrix`, `maid-atelier`, `orca-link`, `whale-mom`,
`ice-princess`, `mint`, `phoebe-atelier`, `wallpaper-exclusive`, `last-exile`,
`porco-rosso`, `white-snake`) — those skins are not in the npm package (`files`
whitelists only `skins/blue-fantasy`), so they are absent from a source-only
checkout. **Zero AssertionError / TypeError / ReferenceError.** The seven added
tests all pass (631 − 624), and three of them were individually proven to fail
when the corresponding source fix is reverted.

Reproducibility: applying the six patches to the pristine files reproduces
`patched/` byte-for-byte (10 files).

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
