# mods — patches against `@linxin666/dsh-client-ui-skin-center` v0.4.4

Three unified diffs against **pristine upstream source**, with the pristine files
kept alongside so the change is reviewable without cloning upstream.

```
baseline/   pristine upstream files, exactly as published
patched/    the same files with all three patches applied
*.patch     diff -u baseline/... patched/...
```

Apply, in order:

```sh
cd <upstream checkout>            # github.com/zhu1090093659/dsh-skins, or a sparse checkout of src/ tests/
patch -p1 < mods/01-runtime-occlusion.patch
patch -p1 < mods/02-occlusion-tests.patch
patch -p1 < mods/03-backdrop-media-policy.patch
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

## Verification

Run in an upstream checkout with the patches applied:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 628 passed / 15 failed — **zero regressions**, see below |
| `pnpm build` | succeeds; all four change markers present in `lib/client.js` |

Controlled experiment, both runs in the identical `skins/` state:

| | tests | failed | passed |
|---|---|---|---|
| pristine upstream | 639 | 15 | 624 |
| these patches | 643 | 15 | **628** |

Same failure set. All 15 are `ENOENT` / `Cannot find module` for the repository's
**market-skin test fixtures** (`matrix`, `maid-atelier`, `orca-link`, `whale-mom`,
`ice-princess`, `mint`, `phoebe-atelier`, `wallpaper-exclusive`, `last-exile`,
`porco-rosso`, `white-snake`) — those skins are not in the npm package (`files`
whitelists only `skins/blue-fantasy`), so they are absent from a source-only
checkout. **Zero AssertionError / TypeError / ReferenceError.** The four added
tests all pass (628 − 624).

Reproducibility: applying the three patches to the pristine files reproduces
`patched/` byte-for-byte.

## Not included

The highest-priority *defect* found in the survey is deliberately left out, because
it is a separate concern and mixing it in would make review harder:

- `src/client/runtime/skin-controller.ts` tracks its own stylesheet `<link>` by
  attribute selector (href) while the server pre-renders a link with the same href
  — so the first activation's teardown removes the preload link and leaves the
  JS-created one permanently, accumulating one orphan `<link>` per switch. Because
  `patches` is unscoped free-selector CSS by contract, a leaked link can keep
  painting under another skin.

Suggested as its own commit: `fix(skin-center): track the stylesheet by node
identity`. Details and 17 more items in `../MODDING-REPORT.md`.
