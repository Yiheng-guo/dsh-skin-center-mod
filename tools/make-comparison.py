#!/usr/bin/env python3
"""Compose the A / B / C comparison sheet.

    python3 build/make-comparison.py

Writes build/comparison.jpg: the three candidates stacked, each labelled, all
normalised to the same width so the eye can compare the *look* rather than the
resolution. Panel A is the skin author's own published preview; B and C are
renders of our skins over their own background asset via the skin centre's real
CSS transform.

This is a decision aid, not a deliverable — regenerating it needs network for
panel A.
"""

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "comparison.jpg"

WIDTH = 1280
LABEL_H = 46

PANELS = [
    (
        ROOT / "build/.cmp/wf-dark.jpg",
        "A   whale-fantasy  (community skin, author's own preview)  —  25.5s loop",
    ),
    (
        ROOT / "cyber-maiden/preview/dark.jpg",
        "B   cyber-maiden   (yours, from media/deepseek-brand-intro.mp4)  —  13.6s loop",
    ),
    (
        ROOT / "cyber-abyss/preview/dark.jpg",
        "C   cyber-abyss    (yours, from media/deepseek-startup-intro.mp4)  —  16.6s loop",
    ),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        if pathlib.Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def panel(path: pathlib.Path, label: str) -> Image.Image:
    if not path.exists():
        print(f"error: missing {path}", file=sys.stderr)
        sys.exit(1)
    im = Image.open(path).convert("RGB")
    h = round(im.height * WIDTH / im.width)
    im = im.resize((WIDTH, h), Image.LANCZOS)
    sheet = Image.new("RGB", (WIDTH, h + LABEL_H), (10, 12, 18))
    sheet.paste(im, (0, LABEL_H))
    d = ImageDraw.Draw(sheet)
    d.text((16, 14), label, font=load_font(21), fill=(226, 236, 250))
    return sheet


def main() -> int:
    sheets = [panel(p, l) for p, l in PANELS]
    total_h = sum(s.height for s in sheets) + 8 * (len(sheets) - 1)
    canvas = Image.new("RGB", (WIDTH, total_h), (0, 0, 0))
    y = 0
    for s in sheets:
        canvas.paste(s, (0, y))
        y += s.height + 8
    canvas.save(OUT, "JPEG", quality=88)
    print(f"wrote {OUT.relative_to(ROOT)}  {canvas.width}x{canvas.height}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
