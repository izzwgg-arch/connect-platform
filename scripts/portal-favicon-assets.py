#!/usr/bin/env python3
"""
Build the PORTAL's browser favicon from the Loopcom icon-refinement kit.

    python scripts/portal-favicon-assets.py            # write the assets
    python scripts/portal-favicon-assets.py --check    # verify only, write nothing

WHAT THIS PRODUCES, and why each file is where it is
----------------------------------------------------
  apps/portal/app/favicon.ico    the browser TAB icon (16 + 32 + 48)
  apps/portal/app/apple-icon.png the 180px "Add to Home Screen" icon

Both are Next.js App Router FILE CONVENTIONS, so Next emits the <link rel="icon">
and <link rel="apple-touch-icon"> tags into every page's <head> by itself. There
is deliberately NO icon markup in app/layout.tsx and none should be added - two
mechanisms for one tag is how they drift.

  #  Do NOT put these under apps/portal/public/. A file at public/favicon.ico is
  #  served as /favicon.ico too, but it bypasses Next's metadata layer entirely,
  #  so it ships WITHOUT a <link> tag and without the content hash that busts a
  #  browser's very sticky favicon cache.

WHICH ARTWORK
-------------
Blue 2B - the variant Izzy picked on 2026-08-22, the same mark the Android
launcher and the Windows app ship. The kit also carries a navy-2a favicon and a
third top-level one; navy is the DARK-THEME app icon and the top-level pair is
the pre-refinement design. Neither belongs in a browser tab.

  #  A single blue favicon is deliberate. A prefers-color-scheme favicon pair
  #  would follow the OPERATING SYSTEM, which routinely disagrees with the
  #  portal's own light/dark toggle - the exact mismatch that made the billing
  #  screens render a white slab inside a dark app. Blue 2B is the default
  #  everywhere else, so it is the honest single answer here.

WHY THE .ico IS ASSEMBLED BY HAND
---------------------------------
Pillow's Image.save(..., format="ICO", sizes=[...]) downsamples ONE source image
for every entry, so the 16px frame comes out of the largest render and the thin
strokes average into the plate. The designer drew 16 and 32 individually; those
are embedded VERBATIM and only the 48 is synthesised (a LANCZOS reduction of the
180 - large enough that a downsample holds up, and there is no designer 48).

Every entry is BMP/DIB rather than PNG. PNG-compressed entries are fine in every
modern browser, but Windows also reads this same file for a pinned site or a
desktop shortcut, and several shell surfaces render a small PNG entry BLANK - an
all-PNG .ico opens perfectly in an image viewer and ships an empty shortcut icon.
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
KIT = REPO / "docs" / "brand" / "loopcom" / "icon-refinement-2026-08" / "new-apps-icons" / "blue-2b"
APP = REPO / "apps" / "portal" / "app"

ICO_PATH = APP / "favicon.ico"
APPLE_PATH = APP / "apple-icon.png"

# size -> (kit file, how it was produced)
DESIGNER_FRAMES = {16: "favicon-16.png", 32: "favicon-32.png"}
SYNTHESISED = {48: ("apple-touch-icon-180.png", Image.LANCZOS)}
ICO_SIZES = sorted(list(DESIGNER_FRAMES) + list(SYNTHESISED))

APPLE_SOURCE = "apple-touch-icon-180.png"

_problems: list[str] = []
_written: list[Path] = []


def load(name: str) -> Image.Image:
    path = KIT / name
    if not path.exists():
        sys.exit("missing kit file: {}".format(path))
    return Image.open(path).convert("RGBA")


def build_frames() -> dict[int, Image.Image]:
    frames: dict[int, Image.Image] = {}
    for size, name in DESIGNER_FRAMES.items():
        img = load(name)
        if img.size != (size, size):
            sys.exit("{} is {}, expected {}x{}".format(name, img.size, size, size))
        frames[size] = img
    for size, (name, filt) in SYNTHESISED.items():
        frames[size] = load(name).resize((size, size), filt)
    return frames


def write_ico(images: dict[int, Image.Image], path: Path) -> None:
    entries = []
    for size in sorted(images):
        buf = io.BytesIO()
        images[size].save(buf, format="DIB")
        blob = buf.getvalue()
        # An icon DIB declares DOUBLE its real height, because the format reserves
        # the lower half of the bitmap for the 1-bit AND mask. 32bpp icons carry
        # transparency in the alpha channel and Windows synthesises the mask, so no
        # mask bytes are appended - but the doubled biHeight is still mandatory or
        # every entry renders squashed into the top half of its box.
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


def check(frames: dict[int, Image.Image]) -> None:
    if not ICO_PATH.exists():
        _problems.append("missing: {}".format(ICO_PATH.relative_to(REPO)))
    else:
        with Image.open(ICO_PATH) as ico:
            have = set(s[0] for s in ico.info.get("sizes", set()))
        missing = sorted(set(ICO_SIZES) - have)
        if missing:
            _problems.append(
                "{}: missing sizes {}".format(ICO_PATH.relative_to(REPO), missing)
            )
        else:
            # The frames must match the kit, not merely exist at the right size -
            # that is the whole point of embedding them independently.
            for size in ICO_SIZES:
                with Image.open(ICO_PATH) as ico:
                    ico.size = (size, size)
                    got = ico.convert("RGBA")
                if got.tobytes() != frames[size].tobytes():
                    _problems.append(
                        "{}: the {}px frame does not match the kit".format(
                            ICO_PATH.relative_to(REPO), size
                        )
                    )

    if not APPLE_PATH.exists():
        _problems.append("missing: {}".format(APPLE_PATH.relative_to(REPO)))
    else:
        with Image.open(APPLE_PATH) as img:
            if img.size != (180, 180):
                _problems.append(
                    "{}: is {}, expected (180, 180)".format(
                        APPLE_PATH.relative_to(REPO), img.size
                    )
                )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()

    frames = build_frames()

    if args.check:
        check(frames)
    else:
        write_ico(frames, ICO_PATH)
        APPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
        load(APPLE_SOURCE).save(APPLE_PATH, optimize=True)
        _written.append(APPLE_PATH)

    for path in _written:
        print("wrote {}".format(path.relative_to(REPO)))
    for problem in _problems:
        print("PROBLEM: {}".format(problem))
    if _problems:
        return 1
    if args.check:
        print("favicon assets OK ({} sizes)".format(len(ICO_SIZES)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
