#!/usr/bin/env python3
"""
Put the REAL Loopcom logo on the desktop Coworker bubble.

The bubble (apps/desktop/assets/coworkerWidget.html) is a 64px transparent window,
so its artwork is embedded as a data: URI — no second file, no network, and a CSP
of `img-src data:`. This script renders that artwork from the brand kit and writes
it into the html between `data:image/png;base64,` and the closing quote.

Source: the Blue 2B tile Izzy chose on 2026-08-22 (the same artwork as the app's
own launcher icon, docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/
blue-2b/android-app-icon-512.png), cut to a circle. It is 128px so a 58px bubble
on a 1.25–2.0 DPR screen stays sharp.

  python scripts/desktop-coworker-bubble-asset.py          # regenerate + embed
  python scripts/desktop-coworker-bubble-asset.py --check  # fail if the html drifted

⛔ The first bubble shipped a hand-drawn SVG infinity glyph instead of the logo.
Izzy: "it doesn't have the real Loopcom logo." Do not hand-draw a substitute again.
"""
from __future__ import annotations

import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/blue-2b/android-app-icon-512.png"
HTML = ROOT / "apps/desktop/assets/coworkerWidget.html"
SIZE = 128
SUPERSAMPLE = 4
MARKER = re.compile(r'(src="data:image/png;base64,)([A-Za-z0-9+/=_]*)(")')  # `_` admits the template placeholder


def render_bubble_png() -> bytes:
    src = Image.open(SOURCE).convert("RGBA")
    if src.size != (512, 512):
        raise SystemExit(f"unexpected source size {src.size}; expected the 512px Blue 2B tile")
    big = src.resize((SIZE * SUPERSAMPLE, SIZE * SUPERSAMPLE), Image.LANCZOS)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    big.putalpha(mask)
    out = big.resize((SIZE, SIZE), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def embedded_png(html: str) -> bytes | None:
    m = MARKER.search(html)
    if not m or not m.group(2):
        return None
    try:
        return base64.b64decode(m.group(2))
    except Exception:
        return None


def main(argv: list[str]) -> int:
    check = "--check" in argv
    html = HTML.read_text(encoding="utf-8")
    if not MARKER.search(html):
        print(f"FAIL: no data:image/png;base64 img in {HTML}", file=sys.stderr)
        return 1
    fresh = render_bubble_png()
    current = embedded_png(html)
    if check:
        if current is None:
            print("FAIL: the bubble carries no embedded artwork", file=sys.stderr)
            return 1
        img = Image.open(io.BytesIO(current)).convert("RGBA")
        if img.size != (SIZE, SIZE):
            print(f"FAIL: embedded artwork is {img.size}, expected {(SIZE, SIZE)}", file=sys.stderr)
            return 1
        want = Image.open(io.BytesIO(fresh)).convert("RGBA")
        diff = sum(abs(a - b) for a, b in zip(img.tobytes(), want.tobytes())) / len(img.tobytes())
        if diff > 0.5:
            print(f"FAIL: embedded artwork differs from the Blue 2B render (mean channel diff {diff:.2f})", file=sys.stderr)
            return 1
        # Corner must be transparent (a circle), centre must be the brand blue plate.
        if img.getpixel((0, 0))[3] != 0:
            print("FAIL: the bubble is not cut to a circle (opaque corner)", file=sys.stderr)
            return 1
        print(f"coworker bubble artwork OK ({len(current)} bytes, {img.size[0]}px, Blue 2B)")
        return 0
    b64 = base64.b64encode(fresh).decode("ascii")
    html = MARKER.sub(lambda m: f"{m.group(1)}{b64}{m.group(3)}", html, count=1)
    HTML.write_text(html, encoding="utf-8", newline="\n")
    print(f"embedded {len(fresh)} bytes of Blue 2B artwork into {HTML.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
