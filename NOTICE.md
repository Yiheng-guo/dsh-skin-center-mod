# NOTICE

This repository contains a **modified fork** of a third-party DSH plugin, plus
two original skins and the tooling used to build them. This file records the
attribution and the exact scope of the modifications, as required by the
upstream license.

## Upstream

| | |
|---|---|
| Project | `@linxin666/dsh-client-ui-skin-center` (the DSH Web GUI "Skin Center") |
| Version forked | **0.4.4** |
| Repository | <https://github.com/zhu1090093659/dsh-skins> |
| Copyright | Copyright (c) 2026, zhu1090093659 |
| License | BSD 3-Clause — see [`LICENSE`](LICENSE) |

The Skin Center is the single loader and renderer for DSH "skins": pure asset
directories (`skin.json` + `skin.css` + `patches.css` + assets) that restyle the
DSH Web GUI, optionally over a looping video background.

Everything in [`mods/`](mods/) is a patch against that upstream source. The
built-in skin `skins/blue-fantasy` is upstream content and is **not** included
here (it ships inside the npm package).

## License discrepancy in the upstream project (read this before forking)

The upstream repository is **self-inconsistent**, and the two sources disagree:

| Source | Says |
|---|---|
| `LICENSE` file (shipped in the npm tarball and the repo) | **BSD 3-Clause** |
| `package.json` → `"license"` | `Apache-2.0` |
| GitHub's license detection | **BSD 3-Clause** |

This repository follows the **`LICENSE` file** (BSD 3-Clause), because the
license *text* is the actual grant. Note the practical difference: Apache-2.0
carries an express patent grant and a "state your changes" clause, BSD 3-Clause
carries neither. If the upstream maintainer intends Apache-2.0, they should
replace the `LICENSE` file; until then the safe reading is the `LICENSE` file.

If you fork this fork, do the same check.

## Scope of the modifications in this repository

Only two upstream source files are changed, plus one test file. The patches are
in [`mods/`](mods/) and each one is a unified diff against the pristine upstream
file (baseline copies are kept alongside for review).

| Patch | Upstream file | Change |
|---|---|---|
| `01-runtime-occlusion.patch` | `src/client/background.ts` | The runtime paints the background-occlusion veil itself instead of only writing a CSS variable that most skins never consume. |
| `02-occlusion-tests.patch` | `tests/background.spec.ts` | Adds four tests for the above; retargets the existing element lookup from a shape query to the new stable attributes. |
| `03-backdrop-media-policy.patch` | `src/client/runtime/decoration-layers.ts` | Lifecycle and accessibility policy for the backdrop `<video>`: pause while hidden, honour `prefers-reduced-motion`, `preload="metadata"`, explicit teardown, stable hook attribute. |

No other upstream file is modified. Nothing is renamed, no persisted
identifier, wire-protocol field or profile format changes, and no skin manifest
schema field is added or removed — the v2 manifest schema is
`additionalProperties: false`, so a new field would be a contract change and
none is made here.

## Original content in this repository

| Path | What | Rights |
|---|---|---|
| `skins/cyber-maiden/`, `skins/cyber-abyss/` | Two original v2 skins (CSS, manifests, palettes) authored for this repository. | Copyright (c) 2026, Yiheng-guo. |
| `skins/*/assets/*.mp4` | Looping background clips baked from the author's **own** source footage. | The generated character art belongs to the author. Not covered by any upstream license. |
| `tools/` | Build, bake, validate and preview tooling. `tools/validator/` is a byte copy of upstream validator sources, kept for honest local verification. | Tooling: Yiheng-guo. `tools/validator/`: upstream, BSD 3-Clause. |
| `MODDING-REPORT.md`, `docs/` | Analysis and write-ups. | Yiheng-guo. |

The skins' video art is **not** licensed for redistribution by anyone else.
If you reuse this repository, treat `skins/*/assets/` as all-rights-reserved
third-party-looking art and do not republish it.

## No warranty

These patches are a fork, not an upstream release. The upstream authors have
not reviewed them. The tests were run against the upstream suite, but you are
installing a modified plugin — keep a rollback path.
