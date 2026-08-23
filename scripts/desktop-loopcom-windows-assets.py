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

THE SOURCE IS THE CHOSEN REFINEMENT TILE, VERBATIM
--------------------------------------------------
2026-08-22, Izzy delivered "Icon refinement options" (two candidates, navy-2a
and blue-2b) and picked blue-2b: "use 2b". The icon is therefore that artwork
- a full-bleed Loopcom-blue tile with the white infinity mark - resized and
NOTHING ELSE. No plate added, no corners cut, no recolouring: the deliverable
IS the design, and the last time this repo redrew a delivered asset instead of
using it, the owner's answer was that he never approved other colours.

The master is the 1024px tile from the refinement kit, pinned into git at
docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/blue-2b/. It is
opaque and square edge to edge (checked pixel-by-pixel, not assumed - an
earlier probe misread the ALPHA channel as "white corners"; the corners are
brand blue). Windows applies no mask to app icons, so it ships as-is.

Because the mark is WHITE ON BLUE rather than strokes on transparency, the
small sizes fail differently than the old design: downsampling averages the
white strokes into the blue ground and the mark goes soft. The ≤32px frames
therefore get a gentle unsharp pass after the resize - measured as the
difference between a readable 16px taskbar icon and a blue smudge. That is a
LEGIBILITY aid on the delivered artwork, not a redesign of it.

Requires Pillow: pip install Pillow
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image, ImageFilter
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required:  pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "docs" / "brand" / "loopcom"
ASSETS = REPO / "apps" / "desktop" / "assets"

# The chosen refinement variant. ⛔ ONE name, one place - "use 2b" (Izzy,
# 2026-08-22). Changing the variant is changing this constant, never editing
# paths inline, so a future regeneration cannot silently mix variants.
REFINEMENT_VARIANT = "blue-2b"
REFINEMENT_MASTER = (
    BRAND / "icon-refinement-2026-08" / "new-apps-icons" / REFINEMENT_VARIANT / "ios-app-icon-1024.png"
)

# Every size Windows asks for. 16/24/32 are the taskbar and title bar, 48 is
# Explorer's medium view, 256 is the Start menu / large tiles / alt-tab.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# The cross-platform BrowserWindow/tray fallback (macOS/Linux take a PNG).
GENERIC_PX = 512

# The sizes at and below which the white-on-blue mark needs help staying
# crisp after the downsample. Above this, the resize alone is clean.
SHARPEN_AT_OR_BELOW = 32

_written: list[Path] = []
_problems: list[str] = []


def load_tile() -> Image.Image:
    """The chosen refinement tile, verbatim. Refuses to run without it."""
    if not REFINEMENT_MASTER.exists():
        sys.exit("missing brand asset: {}".format(REFINEMENT_MASTER))
    img = Image.open(REFINEMENT_MASTER).convert("RGBA")
    if img.size[0] != img.size[1]:
        sys.exit("refinement master is not square: {}".format(img.size))
    return img


# ink_crop() was deleted with the move to the refinement tile: the tile is the
# whole icon, so there is no ink to crop and nothing that function could do but
# harm. Its getbbox() lesson lives on in the Android generator, which still
# renders the bare mark.


def render_icon(tile: Image.Image, px: int) -> Image.Image:
    """
    One square icon: the tile, resized, nothing else.

    ⛔ Each frame is produced INDEPENDENTLY from the 1024 master (never by
    resizing another frame), and the ≤32px frames get one gentle unsharp pass
    - white-on-blue averages soft, and a soft 16px taskbar icon reads as a
    blue smudge. The pass is deliberately mild: radius 1, small percent, so it
    recovers edges without inventing halos that would read as a redesign.
    """
    out = tile.resize((px, px), Image.LANCZOS)
    if px <= SHARPEN_AT_OR_BELOW:
        out = out.filter(ImageFilter.UnsharpMask(radius=1, percent=110, threshold=2))
    return out


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

    tile = load_tile()
    renders = dict((px, render_icon(tile, px)) for px in ICO_SIZES)

    write_ico(renders, ASSETS / "icon.ico", args.check)
    for px in ICO_SIZES:
        emit(renders[px], ASSETS / "icon-{}.png".format(px), args.check)
    emit(render_icon(tile, GENERIC_PX), ASSETS / "icon.png", args.check)

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
