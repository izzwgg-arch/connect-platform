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

THE SOURCE IS THE DESIGNER'S OWN WINDOWS FRAMES, VERBATIM
---------------------------------------------------------
2026-08-23, after the tile-resize build reached his taskbar, Izzy delivered a
SECOND kit: per-size icons MADE FOR WINDOWS (loopcom-win-16/32/48/64/256), one
set per variant, rounded corners with real transparency, each frame hand-tuned
at its exact size. His words: "the icon is not showing up here … I just made
two new ones to be made for Windows."

So this script no longer resizes anything it can avoid resizing: the five
designer frames are embedded VERBATIM, and only the two sizes Windows wants
that the kit does not carry (24 and 128) are synthesised - 24 from the 32,
128 from the 256, one LANCZOS step each, no sharpening. A designer-tuned 16px
beats any algorithmic downsample of a 1024 tile; that is the whole reason the
second kit exists.

The variant is still "use 2b" (Izzy, 2026-08-22). The navy-2a Windows set is
pinned beside it in git for the day he changes his mind.

Requires Pillow: pip install Pillow
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required:  pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "docs" / "brand" / "loopcom"
ASSETS = REPO / "apps" / "desktop" / "assets"

# The chosen refinement variant. ⛔ ONE name, one place - "use 2b" (Izzy,
# 2026-08-22). Changing the variant is changing this constant, never editing
# paths inline, so a future regeneration cannot silently mix variants.
# ⛔ TWO VARIANTS SHIP NOW (Izzy, 2026-08-23): "2A would be dark mode. 2B would
# be the light mode." blue-2b is the BAKED default (the exe icon cannot follow a
# theme - Windows reads one .ico out of the executable); navy-2a ships beside it
# as the -dark asset set, and the RUNNING app swaps tray + window icons live via
# nativeTheme (src/themeIcon.ts).
VARIANTS = {"blue-2b": "", "navy-2a": "-dark"}

def windows_frames_dir(variant: str) -> Path:
    return BRAND / "icon-refinement-2026-08" / "new-apps-icons" / variant / "windows-app"
# The sizes the designer supplied. Everything else is synthesised from these.
DESIGNER_SIZES = [16, 32, 48, 64, 256]
# size -> the designer frame it is derived from, when the kit lacks it.
SYNTHESISED_FROM = {24: 32, 128: 256}

# Every size Windows asks for. 16/24/32 are the taskbar and title bar, 48 is
# Explorer's medium view, 256 is the Start menu / large tiles / alt-tab.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# The cross-platform BrowserWindow/tray fallback (macOS/Linux take a PNG).
GENERIC_PX = 512


_written: list[Path] = []
_problems: list[str] = []


def load_designer_frames(variant: str) -> dict:
    """The designer's per-size Windows frames, verbatim. Refuses to run short."""
    frames = {}
    for px in DESIGNER_SIZES:
        p = windows_frames_dir(variant) / "loopcom-win-{}.png".format(px)
        if not p.exists():
            sys.exit("missing brand asset: {}".format(p))
        img = Image.open(p).convert("RGBA")
        if img.size != (px, px):
            sys.exit("{} is {}x{}, expected {0}px".format(px, *img.size))
        frames[px] = img
    return frames


# ink_crop() was deleted with the move to the refinement tile: the tile is the
# whole icon, so there is no ink to crop and nothing that function could do but
# harm. Its getbbox() lesson lives on in the Android generator, which still
# renders the bare mark.


def render_icon(frames: dict, px: int) -> Image.Image:
    """
    ⛔ A designer frame is returned UNTOUCHED. Only 24 and 128 are synthesised,
    each one LANCZOS step from the nearest designer frame, with no sharpening -
    the hand-tuned sizes are the point of the second kit, and any processing on
    them is a redesign wearing a helpful hat.
    """
    if px in frames:
        return frames[px]
    src = SYNTHESISED_FROM.get(px)
    if src is None:
        sys.exit("no designer frame and no synthesis rule for {}px".format(px))
    return frames[src].resize((px, px), Image.LANCZOS)


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

    for variant, suffix in VARIANTS.items():
        frames = load_designer_frames(variant)
        renders = dict((px, render_icon(frames, px)) for px in ICO_SIZES)
        write_ico(renders, ASSETS / "icon{}.ico".format(suffix), args.check)
        for px in ICO_SIZES:
            emit(renders[px], ASSETS / "icon{}-{}.png".format(suffix, px), args.check)
        # ⛔ The generic PNG is the designer 256 AS-IS, not an upscale: a 256 -> 512
        # blow-up is blur, and every consumer of icon.png scales down anyway.
        emit(frames[256], ASSETS / "icon{}.png".format(suffix), args.check)

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
