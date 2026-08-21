#!/usr/bin/env python3
"""
Regenerate the Windows desktop app's icon set from the Loopcom brand kit.

    python scripts/desktop-loopcom-windows-assets.py            # writes the files
    python scripts/desktop-loopcom-windows-assets.py --check    # verifies, writes nothing

Why this exists
---------------
Same reason as scripts/mobile-loopcom-android-assets.py: the geometry decision
lives in code, in ONE number, so a future regeneration cannot silently change
how much of the frame the mark occupies. The 2026-08-20 Android pass generated
its icons by hand and recorded the scale only in prose; nobody could tell
afterwards what it had been.

The Windows icon is not the Android icon
----------------------------------------
An Android adaptive icon is a 108dp canvas of which only the central 72dp is
ever shown, so the mark is drawn small (MARK_SCALE 0.70) to keep its outer glow
clear of the circular mask. Windows applies NO mask - the whole square is shown
- so the same visual result needs the mark drawn much larger here. The number
that has to match across the two platforms is the mark's INK width as a
fraction of what the user actually SEES:

    Android:  MARK_SCALE(0.70) x 108/72 x ink-fraction-of-source(0.854) = 0.897
    Windows:  MARK_INK_W                                                = 0.84

i.e. this file's 0.84 is deliberately a hair smaller than Android's effective
0.897, because Windows has no mask eating the outer glow.

The plate is OPAQUE and that is load-bearing. A transparent glowing-blue mark
is invisible against a light Windows 11 taskbar, a light Start menu, or a light
notification toast. The dark plate is the same #0C1218 the Android launcher icon
uses, so the two fleets show the same icon.

Requires Pillow: pip install Pillow
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageEnhance
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required:  pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "docs" / "brand" / "loopcom"
ASSETS = REPO / "apps" / "desktop" / "assets"

# -- The brand's own tokens (docs/brand/loopcom/README.md) -------------------
GROUND = (0x0C, 0x12, 0x18)          # == the Android adaptive-icon background

# THE SPACING DECISION - the one place this number lives. It is the mark's INK
# width as a fraction of the icon square, NOT the source PNG's box width (the
# brand PNG carries transparent padding; see ink_crop below).
MARK_INK_W = 0.84

# Windows 11 draws app icons unmasked, but every first-party icon is a rounded
# square. 0 = a hard square. Expressed as a fraction of the icon's edge.
CORNER_RADIUS = 0.18

# Every size Windows asks for. 16/24/32 are the taskbar and title bar, 48 is
# Explorer's medium view, 256 is the Start menu / large tiles / alt-tab.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# The cross-platform BrowserWindow/tray fallback (macOS/Linux take a PNG).
GENERIC_PX = 512

# Small-size hinting. The mark is thin bright strokes on a dark plate, so
# downsampling to 16/24px averages each stroke with the plate and the whole logo
# goes dim and muddy - it reads as a smudge in the taskbar, which is the ONE
# size the owner looks at all day. Lifting the mark's luminance before the
# composite restores it. Measured against 1.0 and 1.7: 1.7 washes the brand blue
# out to cyan, 1.35 stays on-brand and legible.
SMALL_SIZE_PX = 32
SMALL_SIZE_GAIN = 1.35

SUPERSAMPLE = 4  # anti-aliases the corner radius and the mark's thin strokes

_written: list[Path] = []
_problems: list[str] = []


def load_mark() -> Image.Image:
    """The transparent Loopcom infinity mark, drawn for a dark ground."""
    p = BRAND / "app-icons" / "android-dark-512.png"
    if not p.exists():
        sys.exit("missing brand asset: {}".format(p))
    return Image.open(p).convert("RGBA")


def ink_crop(img: Image.Image, threshold: int = 24) -> Image.Image:
    """
    Crop to the mark's visible ink.

    NOT Image.getbbox() - the brand PNG carries a scatter of near-zero alpha
    pixels right out to the edges, so getbbox() returns the whole square and the
    crop silently does nothing, leaving the mark rendered ~20% small. Proven the
    hard way in the Android pass; the same source file is used here.
    """
    alpha = img.convert("RGBA").split()[-1].point(lambda v: 255 if v >= threshold else 0)
    box = alpha.getbbox()
    return img.crop(box) if box else img


def hint_small(mark_ink: Image.Image, px: int) -> Image.Image:
    """Lift the mark's luminance for the sizes that would otherwise go muddy."""
    if px > SMALL_SIZE_PX:
        return mark_ink
    r, g, b, a = mark_ink.split()
    lift = lambda ch: ImageEnhance.Brightness(ch).enhance(SMALL_SIZE_GAIN)
    return Image.merge("RGBA", (lift(r), lift(g), lift(b), lift(a)))


def render_icon(mark_ink: Image.Image, px: int) -> Image.Image:
    """One square icon: the ink-cropped mark centred on the rounded dark plate."""
    mark_ink = hint_small(mark_ink, px)
    big = px * SUPERSAMPLE
    plate = Image.new("RGBA", (big, big), GROUND + (255,))
    if CORNER_RADIUS > 0:
        mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, big - 1, big - 1), radius=round(big * CORNER_RADIUS), fill=255
        )
        rounded = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        rounded.paste(plate, (0, 0), mask)
        plate = rounded

    w = max(1, round(big * MARK_INK_W))
    h = max(1, round(w * mark_ink.size[1] / mark_ink.size[0]))
    scaled = mark_ink.resize((w, h), Image.LANCZOS)
    plate.alpha_composite(scaled, ((big - w) // 2, (big - h) // 2))
    return plate.resize((px, px), Image.LANCZOS)


def write_ico(images, path: Path, check: bool) -> None:
    """
    A multi-size .ico, written by hand.

    Pillow's Image.save(..., format="ICO", sizes=...) downsamples ONE source
    image for every entry, so the 16px frame comes out of a 256px render and the
    thin strokes turn to mush. Each size here is rendered independently at 4x
    supersample and embedded verbatim.

    Entries <= 128px are BMP/DIB and only the 256 is PNG, which is the layout
    every well-formed .ico uses. PNG-compressed entries are only guaranteed on
    Vista+ at 256; some Windows shell surfaces (and rcedit, which is what embeds
    this file into the .exe) render a small PNG entry BLANK. An all-PNG .ico
    therefore opens fine in an image viewer and ships an empty taskbar icon.
    """
    if check:
        if not path.exists():
            _problems.append("missing: {}".format(path.relative_to(REPO)))
            return
        with Image.open(path) as ico:
            have = set(s[0] for s in ico.info.get("sizes", set()))
        missing = sorted(set(images) - have)
        if missing:
            _problems.append("{}: missing sizes {}".format(path.relative_to(REPO), missing))
        return

    entries = []
    for size in sorted(images):
        buf = io.BytesIO()
        if size >= 256:
            images[size].save(buf, format="PNG", optimize=True)
            blob = buf.getvalue()
        else:
            images[size].save(buf, format="DIB")
            blob = buf.getvalue()
            # An icon DIB declares DOUBLE its real height, because the format
            # reserves the lower half of the bitmap for the 1-bit AND mask.
            # 32bpp icons carry their transparency in the alpha channel and
            # Windows synthesises the mask, so no mask bytes are appended - but
            # the doubled biHeight is still mandatory or every entry renders
            # squashed into the top half of its box.
            blob = blob[:8] + struct.pack("<I", size * 2) + blob[12:]
        entries.append((size, blob))

    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = len(header) + 16 * len(entries)
    directory, payload = b"", b""
    for size, blob in entries:
        directory += struct.pack(
            "<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(blob), offset
        )
        payload += blob
        offset += len(blob)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + directory + payload)
    _written.append(path)


def emit(img: Image.Image, path: Path, check: bool) -> None:
    if check:
        if not path.exists():
            _problems.append("missing: {}".format(path.relative_to(REPO)))
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    _written.append(path)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    ap.add_argument("--preview", type=Path, help="also write a side-by-side preview PNG")
    args = ap.parse_args()

    mark_ink = ink_crop(load_mark())
    renders = dict((px, render_icon(mark_ink, px)) for px in ICO_SIZES)

    write_ico(renders, ASSETS / "icon.ico", args.check)
    for px in ICO_SIZES:
        emit(renders[px], ASSETS / "icon-{}.png".format(px), args.check)
    emit(render_icon(mark_ink, GENERIC_PX), ASSETS / "icon.png", args.check)

    if args.preview and not args.check:
        pad, cell = 16, 240
        strip = Image.new("RGBA", (cell * 4 + pad * 5, cell + pad * 2), (0x1E, 0x1E, 0x1E, 255))
        for i, px in enumerate([16, 24, 32, 256]):
            resample = Image.NEAREST if px < 64 else Image.LANCZOS
            strip.alpha_composite(renders[px].resize((cell, cell), resample), (pad + i * (cell + pad), pad))
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        strip.save(args.preview)

    if args.check:
        for p in _problems:
            print("  x {}".format(p))
        print("{}: {} problem(s)".format("FAIL" if _problems else "OK", len(_problems)))
        return 1 if _problems else 0

    for p in _written:
        print("  wrote {}".format(p.relative_to(REPO)))
    print("OK: {} file(s)".format(len(_written)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
