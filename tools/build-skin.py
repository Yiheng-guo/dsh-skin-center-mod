#!/usr/bin/env python3
"""Skin palette -> skin.css generator (one generator, N skins).

    python3 build/build-skin.py <skin-id>

Reads build/palettes/<skin-id>.json and writes <skin-id>/skin.css.

skin.css is the L1 token layer: every official `--dsw-*` COLOUR token the skin
centre knows about, remapped onto a palette measured off that skin's own
background loop. The shared `--skin-*` material variables at the top are what
patches.css (identical across skins) keys off, so a new skin is a palette file
plus a background asset — no CSS authoring.

Every palette value must be justified by measurement; see the `_provenance`
block each palette file carries.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGISTRY = pathlib.Path(__file__).resolve().parent / "official-tokens-v1.json"
PALETTE_DIR = pathlib.Path(__file__).resolve().parent / "palettes"


def h(color: str, alpha: int) -> str:
    """8-digit hex: the skin ecosystem's convention for translucent values."""
    return f"{color}{alpha:02X}"


# --------------------------------------------------------------------------
# token mapping: official token name -> palette slot (+ alpha)
# Shared across skins: the *language* is the same (cold glass HUD), only the
# palette changes. alpha=None means the palette value is used verbatim.
# --------------------------------------------------------------------------
MAP: dict[str, tuple[str, int | None]] = {
    # background
    "bg-base": ("night", 0x1A),
    "bg-document-preview": ("layer1", 0xCC),
    "bg-layer-1": ("layer1", 0x80),
    "bg-layer-2": ("layer2", 0x8F),
    "bg-layer-3": ("layer3", 0x8F),
    "bg-layer-4": ("layer4", 0x8F),
    "bg-mask-1": ("night", 0xCC),
    "bg-mask-2": ("night", 0x99),
    "bg-mask-3": ("night", 0x66),
    "bg-mask-drop": ("night", 0x80),
    "bg-mask-photo": ("night", 0xA6),
    "bg-module-platform": ("layer2", 0x80),
    "bg-multi-select": ("brand", 0x4D),
    "bg-overlay": ("layer1", 0xEB),
    "bg-skeleton": ("inkDim", 0x1F),
    # border
    "border-inverted": ("night", None),
    "border-inverted2": ("layer2", None),
    "border-l1": ("line", 0x4D),
    "border-l2": ("line", 0x73),
    "border-l2-darkmode-thin": ("line", 0x4D),
    "border-l3": ("line", 0x99),
    "border-l4": ("line", 0xCC),
    # brand
    "brand-primary": ("brand", None),
    "brand-primary-invert": ("night", None),
    "brand-primary-new-colorprimary-new-color": ("brand", None),
    "brand-text": ("brandText", None),
    # buttons
    "button-contrast-fill": ("ink", None),
    "button-elevated-fill": ("layer1", 0x8F),
    "button-floating-fill": ("layer1", 0x8F),
    "button-floating-hover": ("layer3", None),
    "button-ghost-active-border": ("brand", 0x4D),
    "button-ghost-active-fill": ("brand", 0x1F),
    "button-ghost-active-hover": ("brand", 0x2E),
    "button-info-fill": ("brand", None),
    "button-info-hover": ("brandHover", None),
    "button-primary-dimmed": ("brand", 0x59),
    "button-primary-fill": ("brand", None),
    "button-primary-hover": ("brandHover", None),
    "button-tool-bar-fill": ("layer1", 0x85),
    "button-tool-bar-fill-invisible": ("layer1", 0x00),
    "button-tool-bar-hover": ("layer3", None),
    # diff
    "code-diff-added": ("success", None),
    "code-diff-deleted": ("danger", None),
    "file-diff-added-bg": ("success", 0x1F),
    "file-diff-added-gutter": ("success", 0x33),
    "file-diff-added-marker": ("success", None),
    "file-diff-deleted-bg": ("danger", 0x1F),
    "file-diff-deleted-gutter": ("danger", 0x33),
    "file-diff-deleted-marker": ("danger", None),
    # interactive
    "interactive-bg-active": ("brand", 0x38),
    "interactive-bg-hover": ("brand", 0x24),
    "interactive-bg-hover-accent": ("accent", 0x38),
    "interactive-bg-hover-danger": ("danger", 0x29),
    "interactive-bg-hover-solid": ("layer3", None),
    # labels
    "label-caption": ("caption", None),
    "label-dimmed": ("dimmed", None),
    "label-document-preview": ("inkDim", None),
    "label-error": ("danger", None),
    "label-primary": ("ink", None),
    "label-primary-bluish": ("brandText", None),
    "label-primary-dimmed": ("inkDim", None),
    "label-primary-foreground": ("onBrand", None),
    "label-primary-inverted": ("night", None),
    "label-secondary": ("inkDim", None),
    "label-tertiary": ("caption", None),
    "link": ("accent", None),
    # markdown
    "markdown-citation": ("accent", None),
    "markdown-code-block": ("layer2", 0x94),
    "markdown-code-block-banner": ("layer3", None),
    "markdown-code-segment-selected": ("night", 0x99),
    "markdown-code-segment-unselected": ("inkDim", 0x2E),
    "markdown-inline-code": ("brand", 0x29),
    "markdown-placeholder": ("dimmed", None),
    "markdown-tag": ("brand", 0x33),
    # scrollbar
    "scrollbar-bg-l1": ("inkDim", 0x1A),
    "scrollbar-bg-l2": ("inkDim", 0x24),
    "scrollbar-hover-l1": ("inkDim", 0x3D),
    "scrollbar-hover-l2": ("inkDim", 0x4D),
    # state
    "state-business-primary": ("brand", None),
    "state-business-tertiary": ("brand", 0x29),
    "state-error-primary": ("danger", None),
    "state-error-secondary": ("danger", 0x2E),
    "state-idle-primary": ("caption", None),
    "state-success-primary": ("success", None),
    "state-success-secondary": ("success", 0x33),
    "state-success-tertiary": ("success", 0x24),
    "state-warn-label": ("warnLabel", None),
    "state-warn-primary": ("warn", None),
    "state-warn-secondary": ("warn", 0x33),
    "state-warn-tertiary": ("warn", 0x24),
    # toast / tooltip
    "toast-bg": ("ink", None),
    "tooltip-bg": ("ink", None),
    # not in the 0.1.7-rc.1 registry, but the shell renders them (the shipped
    # blue-fantasy / whale-fantasy skins declare them too) — the ink that goes
    # on top of those two light fills.
    "toast-fg": ("night", None),
    "tooltip-fg": ("night", None),
}

# Tokens outside the --dsw-alias-* namespace. A str value is either a literal
# CSS value or the name of a palette slot.
EXTRA: dict[str, tuple[str, int | None] | str] = {
    "--dsw-specific-bubble": ("layer1", 0x8A),
    "--dsw-specific-bubble-highlight": "bubbleHighlight",
    "--dsw-specific-input-major": ("layer1", 0x80),
    "--dsw-specific-login-input": ("layer1", 0x80),
    "--dsw-specific-menu": "menuSolid",
    "--dsw-specific-selector": ("layer2", 0x8F),
    "--dsw-specific-sidebar-fill": ("layer1", 0x85),
    "--dsw-specific-sidebar-nav-item-active": ("brand", 0x2E),
    "--dsw-specific-sidebar-nav-item-active-accent": ("accent", None),
    "--dsw-specific-sidebar-nav-item-hover": ("brand", 0x1A),
    "--dsw-specific-tip": ("brand", 0x1F),
    "--dsw-hovercard-bg": "menuSolid",
    "--dsw-elevation-stroke-color": ("line", 0x73),
    "--dsw-shadow-lv1": "0 1px 2px #00000073",
    "--dsw-shadow-lv2": "0 4px 12px #00000080",
    "--dsw-shadow-lv3": "0 12px 32px #0000008C",
    "--dsw-shadow-lv1-blur": "3px",
    "--dsw-mask-blur": "10px",
}

# Material slots patches.css consumes. Emitted on :root/body so every rule in
# patches.css is palette-agnostic.
MATERIAL = {
    "--skin-night": "night",
    "--skin-glass": "layer1",
    "--skin-line": "line",
    "--skin-brand": "brand",
    "--skin-accent": "accent",
    "--skin-ink": "ink",
    "--skin-ink-dim": "inkDim",
}


def resolve(palette: dict[str, str], spec: tuple[str, int | None] | str) -> str:
    if isinstance(spec, str):
        return palette[spec] if spec in palette else spec
    name, alpha = spec
    value = palette[name]
    return value if alpha is None else h(value, alpha)


def declarations(palette: dict[str, str], indent: str = "  ") -> str:
    out: list[str] = []
    for token, spec in MAP.items():
        out.append(f"{indent}--dsw-alias-{token}: {resolve(palette, spec)};")
    for token, spec in EXTRA.items():
        out.append(f"{indent}{token}: {resolve(palette, spec)};")
    out.append(
        f"{indent}--dsw-linear-gradient-think: "
        f"linear-gradient(90deg, {h(palette['accent'], 0x3D)} 0%, {h(palette['brand'], 0x1F)} 100%);"
    )
    out.append(f"{indent}--dsw-linear-think-select: {h(palette['accent'], 0x47)};")
    return "\n".join(out)


HEADER = """/**
 * {name} ({nameEn}) — L1 token layer.
 *
 * GENERATED by build/build-skin.py from build/palettes/{id}.json, which is in
 * turn measured off this skin's own background loop. Do not hand-edit: change
 * the palette and rebuild.
 *
 * Light values (:root) and dark values (body[data-ds-dark-theme]) carry the SAME
 * values on purpose — the market renderer injects styles without running the
 * loader's :root -> body token clone, and would otherwise fall back to the
 * facade's own light tokens. The skin is dark-only by design.
 *
 * Translucent values are 8-digit hex, the convention the skin ecosystem uses.
 * The loader force-scopes every selector below under
 * html[data-dsh-skin="{id}"], so they are written unscoped.
 *
 * The --skin-* material variables are what patches.css keys off: they are the
 * only reason a new skin is a palette file plus a video, not a CSS project.
 */

:root,
body {{
  color: {ink};
  /* The fixed backdrop stage paints the canvas; html/body must stay
     transparent or they add two more coats on top of the video. */
  background-color: transparent;
  color-scheme: dark;

{material}

{declarations}
}}

body[data-ds-dark-theme] {{
  color: {ink};
  background-color: transparent;
  color-scheme: dark;

{material}

{declarations}
}}
"""


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: build-skin.py <skin-id>", file=sys.stderr)
        return 2
    skin_id = sys.argv[1]
    palette_path = PALETTE_DIR / f"{skin_id}.json"
    if not palette_path.exists():
        print(f"error: no palette at {palette_path}", file=sys.stderr)
        return 1
    skin_dir = ROOT / skin_id
    if not skin_dir.is_dir():
        print(f"error: no skin directory at {skin_dir}", file=sys.stderr)
        return 1

    doc = json.loads(palette_path.read_text(encoding="utf-8"))
    palette = doc["colors"]
    material = "\n".join(f"  {var}: {palette[slot]};" for var, slot in MATERIAL.items())
    css = HEADER.format(
        id=skin_id,
        name=doc.get("name", skin_id),
        nameEn=doc.get("nameEn", skin_id),
        ink=palette["ink"],
        material=material,
        declarations=declarations(palette),
    )
    (skin_dir / "skin.css").write_text(css, encoding="utf-8")

    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    official = set(registry["tokens"])
    covered = {f"--dsw-alias-{n}" for n in MAP} | set(EXTRA) | {
        "--dsw-linear-gradient-think",
        "--dsw-linear-think-select",
    }
    colourish = {
        t
        for t in official
        if not t.startswith("--dsw-font-")
        and not re.search(
            r"(corner-shape|elevation-(panel|prominent|soft|stroke)$|menu-backdrop-filter)", t
        )
    }
    missing = sorted(colourish - covered)
    print(f"{skin_id}: palette {palette_path.relative_to(ROOT)}")
    print(f"  registry colour tokens : {len(colourish)}")
    print(f"  declared by this skin  : {len(covered & official)}")
    print(f"  left to loader fallback: {len(missing)}")
    for t in missing:
        print(f"      {t}")
    print(f"  wrote {(skin_dir / 'skin.css').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
