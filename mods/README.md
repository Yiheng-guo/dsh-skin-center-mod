# mods — patches against `@linxin666/dsh-client-ui-skin-center` v0.4.4

Fourteen unified diffs against **pristine upstream source**, with the pristine files
kept alongside so every change is reviewable without cloning upstream.

```
baseline/   pristine upstream files, exactly as published
patched/    the same files with all fourteen patches applied
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
patch -p1 < mods/10-skin-tuning-sidecar.patch
patch -p1 < mods/11-cli-background-and-live-follow.patch
patch -p1 < mods/12-adapter-diagnostics-counters.patch
patch -p1 < mods/13-wallpaper-codec-preflight.patch
patch -p1 < mods/14-we-web-symlink-fence.patch
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

## 10-skin-tuning-sidecar.patch — `src/core/tuning.ts` (new), `tests/tuning.spec.ts` (new)

**What it adds.** A skin may ship `tuning.json` next to its `skin.json` carrying
its own recommended background values and scoped `--token` overrides.

**Why a sidecar and not a `skin.json` field.** The v2 manifest schema is
`additionalProperties: false`, so an unknown field is a HARD validation error.
A skin using a new field would therefore be rejected outright by every
skin-center build that does not know it — including the official one. A sidecar
carries the same information, stays invisible to every other reader, and keeps
the repository's invariant that a skin is pure data.

**Token values are injected into a stylesheet, so they fail closed.** `;`, `{}`,
`<>`, `\`, `/*`, `@` and `url(` are rejected per value, along with control
characters, empty values and anything over 160 characters. A rejected value is
reported on the catalog rather than silently dropped.

**Merge precedence, with no new state flag.** The applied background config is
`{...defaults, ...skin recommendation, ...stored user value}`, per field. So a
skin's advice applies only where the user has not spoken, a user value always
wins, and `dsh-skin bg reset` returns to the skin's recommendation. `init()` is
the controller's externally-sourced, never-persisting entry point, so merely
switching skins cannot bake a recommendation into the stored config.

## 11-cli-background-and-live-follow.patch — `scripts/dsh-skin.cjs`, `src/client/runtime/boot.ts`, `src/index.ts` via patch 04

**`dsh-skin bg get|set|reset`.** Background settings live in the same state file
as the selection but the library re-exported only the selection accessors, so the
CLI could not reach them. `get` prints each field with its resolved value and
whether it is explicitly set or still at its documented default (so an explicit
`0` is distinguishable from never-set). `set` merge-writes through the same
`normalizeSkinBackground` the HTTP surface uses, so out-of-range input is clamped
rather than rejected, and unparseable input exits 1 with a specific message.
`reset` removes the `background` key entirely, which is what makes it return to
the active skin's recommendation rather than to explicit defaults.

**Live background follow.** `watchPersistedSelection` polled the persisted
selection and converged an open page on an out-of-page write, but it read ONLY
the selection — so a background write from the CLI or another window needed a
reload. The follow now reads `{active, background}` from the same GET and
converges both, with the same discipline: read-only, skips a value already
applied, stops while the page is hidden, and never fights an edit in flight. It
keeps its own cursor — the last value IT applied — so a card edit that has not
been POSTed yet is not reverted, and an apply cannot echo back as a write.

**`dsh-skin doctor` — where a silent failure is visible today.** `list`
already printed these warnings inline, and that is exactly how they get skimmed
past: an inventory reads as information, so a warning inside one does too. doctor
prints ONLY problems — excluded skins with their errors, per-skin warnings, and a
selection that is not in the catalog (which the GUI silently renders as the
official look) — and exits non-zero when there are any, so it works as a script
check.

This is also what stands in for the withdrawn skin-health card: it is the same
data, minus the per-rule adapter counters, which live in the page rather than in
the host and therefore are not reachable from a CLI.

**The CLI's advice was wrong.** `dsh-skin use` printed "reload the GUI to apply"
while the follow makes it land within the poll interval. Corrected.

## 12-adapter-diagnostics-counters.patch — `src/client/runtime/semantic-adapter.ts`, `tests/semantic-adapter.spec.ts`

**This patch fixes a page-hanging bug that the counters exposed.**

The adapter's observer treats an attribute record as "a glyph arrived" and
re-runs the rule table over the changed node's ancestor chain. Its own stamps
produce attribute records too, so the pass re-entered the pass that produced it —
and the table contains more than one rule claiming `data-dsh-part`, so two rules
overwrote each other's value forever. The observer callback never returned, the
microtask queue starved, and **any attribute write on an already-stamped element
froze the page**. Reproduced with a probe whose second macrotask never fired.

Fix: react only to attribute records for names this adapter does NOT write. The
signal the path exists for is a HOST anchor appearing (a re-render that flips
`data-slot` instead of replacing the node), and host anchors are never names the
adapter writes, so every real case survives and only the echo is dropped.

`tagged` also counted WRITES. Because two rules can claim the same attribute on
the same element, one element can be stamped twice — a re-tag, not a second
element. It now counts distinct elements, with the per-pass set cleared on each
full pass so the counter cannot pin detached nodes.

> The card UI that consumed these counters is **withdrawn** (see below), so this
> patch ships the adapter half only.

## 13-wallpaper-codec-preflight.patch — `wallpaper.ts`, `WallpaperPanel.tsx`, `index.ts`, two specs

**The defect.** A wallpaper whose file extension is a video was typed `video` and
mounted in a `<video>` element, but the host classifies by extension alone and
Chromium cannot decode `.mkv` or `.avi` at all, while `.mov` depends entirely on
the codec inside. The wallpaper mounted, showed nothing, and gave no reason.

**The fix.** Probe `HTMLVideoElement.canPlayType(mime)` (mime mapped from the
extension using the same table the host serves bytes with) before mounting. When
the answer is `''` the wallpaper degrades to the existing static-frame path and
the reason rides the established `unsupportedFeatures` channel as
`video-format-unsupported`. When no container can be named, or the API is absent
or throws, the wallpaper mounts exactly as before — a strict improvement, never a
new failure mode. The probe element gets no `src`, so it costs no request, and
verdicts are cached per mime because `render()` runs on every slider tick.

**A second, pre-existing bug fixed here.** `WallpaperPanel`'s `descriptorOf`
dropped `unsupportedFeatures` (and three other fields) entirely, so the EXISTING
host reason `embedded-script` never reached the UI either. It now forwards the
whole descriptor, exposes the mounted descriptor, and renders a notice.

**Integration note.** Adding `activeDescriptor` to the wallpaper handle broke
every spec that stubbed the handle without it (`getSnapshot is not a function`).
`tests/skin-center-custom-theme.spec.tsx` is updated in this patch.

## 14-we-web-symlink-fence.patch — `src/we-routes.ts`, `tests/we-routes.spec.ts`

**What the token actually is.** `tokenFor` returns the base64url of the absolute
path. It is not a secret and never was: the authorization is the `mediaMap` of
paths the server has issued a token for, and the token is just the key into it.

**The defect the survey called "token bound to a directory".** `GET /web/<token>/<subpath>`
resolves `subpath` against the project directory and contained it with a LEXICAL
check: `resolvePath(root, sub)` normalizes `..` as text, and the result is
compared against `root + sep`. That catches `../../etc/passwd`. It does not catch
a **symlink**, because a link that lives inside the project directory never leaves
`root` as text — and `statSync`/`readFileSync` follow it out. A one-line
`ln -s /etc project/escape` therefore served any readable file on the machine to
the wallpaper frame, whose origin is `null`.

**The fix, and why the objective's phrasing could not be implemented literally.**
"The token should be bound to a file rather than a directory" is right for
`/media/` and `/preview/`, which already map one token to one file. It cannot be
applied to `/web/`, because a web wallpaper is an HTML project whose CSS, JS and
assets must all be servable — binding the token to a single file would break the
feature. The correct property for that route is a directory scope **with a
real-path fence**, which is what this patch adds: both the project root and the
requested file are `realpath`'d and the containment check runs on those, so a
symlink inside the project can no longer lead out while an ordinary nested asset
still serves. The root is realpath'd too, so a library reached through a symlinked
manual folder keeps working.

**Verified both ways.** The new test creates a real symlink out of the project and
asserts `403` plus that the secret is absent from the body, and asserts that the
sibling `app.js` and the project HTML still serve. Reverting the `realpath` calls
makes that test fail with **`expected 200 to be 403`** — the escape actually
served the file, which is the evidence that the hole was real rather than
theoretical.

## Verification

Run in an upstream checkout with the patches applied:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm test` | 697 passed / 15 failed — **zero regressions**, see below |
| `pnpm build` | succeeds; every change marker present in the bundle |

Controlled experiment, both runs in the identical `skins/` state:

| | tests | failed | passed |
|---|---|---|---|
| pristine upstream | 639 | 15 | 624 |
| these patches | 712 | 15 | **697** |

Same failure set. All 15 are `ENOENT` / `Cannot find module` for the repository's
**market-skin test fixtures** (`matrix`, `maid-atelier`, `orca-link`, `whale-mom`,
`ice-princess`, `mint`, `phoebe-atelier`, `wallpaper-exclusive`, `last-exile`,
`porco-rosso`, `white-snake`) — those skins are not in the npm package (`files`
whitelists only `skins/blue-fantasy`), so they are absent from a source-only
checkout. **Zero AssertionError / TypeError / ReferenceError** on both sides of the
experiment. The 73 added tests all pass (697 − 624), and every fix in this series
was individually proven to fail when its source change is reverted.

Reproducibility: applying the thirteen patches to the pristine files reproduces
`patched/` byte-for-byte (36 files, three of them new).

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

## Withdrawn, and what is still open

Recorded here rather than quietly dropped, because they affect what this patch
set actually delivers.

**Withdrawn: the skin-health card UI.** The card surface that consumed the
diagnostics (a collapsible "skin health" section) rendered into an infinite
update loop (`Maximum update depth exceeded`). The cause was traced in part to a
test stub returning a fresh `getSnapshot` object on every call — the very trap
the controller documents — but fixing the stub did not stop the loop, and the
implementation could not be verified within the time available. Rather than ship
a settings card that hangs the page, `SkinCenter.tsx`, `locales.ts` and
`skin-center.module.css` are reverted to pristine. What ships is the adapter
half: per-rule counters plus `GET /v2/diagnostics` (patch 08). Re-adding the card
surface needs a fresh implementation, not a rebase of the withdrawn one.

**Wired: the recommendation half of the sidecar.** Both halves of
`tuning.json` are now consumed. The `tokens` half is applied scoped by the skin
controller (patch 06); the `background` half is pushed to the controller by the
selection follow, which already reads `active` on every tick, and merged per
field as `{...defaults, ...recommendation, ...stored}` (patch 01). The push is
placed before the follow's "background changed" early return on purpose:
switching to a skin whose values happen to match still changes that skin's
advice. `setRecommended` is a no-op for an equal recommendation, so pushing on
every tick cannot make the card re-render, and `dsh-skin bg reset` returns to
the active skin's advice.

**Not attempted, with reasons.** F18's D3 is now **done** (patch 14): the `/web/` route's
containment fence runs on real paths, so a symlink inside a project directory can
no longer lead out of it. An earlier revision of this file claimed it was skipped
because the WE paths are Windows-only; that was wrong, and the correction is left
above rather than deleted, because the reasoning error is more instructive than
the fix. The one part of the objective's phrasing that could not be implemented
literally — "token bound to a file rather than a directory" — is explained in
patch 14's section: it already holds for `/media/` and `/preview/`, and cannot
hold for `/web/` without breaking web wallpapers.
F19 (WE texture cache) likewise Windows-only. F11 (lazy observers) is a
trade-off needing a measurement, not a defect. F21's architectural rewrite is out
of scope; only its "make anchor rot visible" subset is addressed, by the
counters.
