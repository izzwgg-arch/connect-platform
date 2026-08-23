#!/usr/bin/env python3
"""
Build the PORTAL's browser favicon from the Loopcom icon-refinement kit.

    python scripts/portal-favicon-assets.py            # write the assets
    python scripts/portal-favicon-assets.py --check    # verify only, write nothing

WHAT THIS PRODUCES
------------------
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

THE FAVICON IS THE MARK WITH THE BACKGROUND CUT AWAY  (Izzy, 2026-08-23)
------------------------------------------------------------------------
"take away the background colour from inside those two peep holes, like eyes,
and around it. That's it, from inside there, inside the band. I didn't want you
to change anything."

So the band keeps EXACTLY what the designer drew - its blue fill, its white
outline and every tick mark. Only two things go: the plate outside the mark, and
the plate inside the two eyes. Nothing is recoloured and nothing is redrawn.

The kit ships that artwork only as a flattened tile (white ink painted over a
blue plate), so the three regions have to be recovered:

  1. The plate is a pure VERTICAL gradient (34,167,255 at the top to 30,79,214 at
     the bottom) and is horizontally uniform, and the mark never reaches the left
     edge - so column 0 IS the plate, row by row.
  2. Every pixel is therefore  C = a*White + (1-a)*Plate.  Solve `a` by least
     squares over the R and G channels ONLY: the plate's blue channel is pinned
     at 255 down the top half of the tile and carries no signal there.
  3. Flood fill the non-ink from the border to get OUTSIDE, then flood fill from
     the centre of each loop to get the two EYES. Whatever is left is the band.

`--check` re-derives all of that and compares each frame in the shipped .ico
byte-for-byte against it, so a change to the kit art cannot pass silently.

  #  Image.fromarray() returns a READ-ONLY image and ImageDraw.floodfill() writes
  #  into it doing NOTHING AT ALL, silently. The .copy() below is load-bearing.

WHY THE FLARE AT THE CENTRE STAYS
---------------------------------
It looks like decoration sitting on top of the crossing. It is not: the two loops
do not touch, and the flare is what bridges them. Measured by trimming its four
points in 1px steps and re-running the segmentation each time - past 76px (of
their ~105px) the background floods through into the band's blue fill and the
infinity comes apart. A trim to the safe floor shortens each point by 28%, which
at a 16px favicon is 2.1px -> 1.5px. Not worth touching the designer's artwork.

  #  The first version of that test checked the two EYES stayed equal, which they
  #  do long after the mark has been breached elsewhere. The invariant that
  #  actually catches it is the BLUE FILL between the ticks surviving.

WHY THE .ico IS ASSEMBLED BY HAND
---------------------------------
Pillow's Image.save(..., format="ICO", sizes=[...]) downsamples ONE source image
for every entry. Every frame here is rendered independently from the 1024 master.
Entries are BMP/DIB rather than PNG: Windows reads this same file for a pinned
site or a desktop shortcut, and several shell surfaces render a small PNG entry
BLANK - an all-PNG .ico opens fine in a viewer and ships an empty shortcut icon.
"""

from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[1]
KIT = REPO / "docs" / "brand" / "loopcom" / "icon-refinement-2026-08" / "new-apps-icons" / "blue-2b"
APP = REPO / "apps" / "portal" / "app"

ICO_PATH = APP / "favicon.ico"
APPLE_PATH = APP / "apple-icon.png"

MASTER = "ios-app-icon-1024.png"      # the tile the mark is cut out of
APPLE_SOURCE = "apple-touch-icon-180.png"
ICO_SIZES = (16, 32, 48)

# The mark is scaled EDGE TO EDGE - Izzy, 2026-08-23: "make it as big as you
# possibly can". It is 2.22:1, so filling the width is as large as it goes
# without distorting it; at 16px that is 16 wide and 7 tall.
MARGIN = 0.0

# Sanity floors for the segmentation, measured on the 2026-08 kit.
EXPECT_BLUE_FILL_PCT = 12.22          # blue showing between the ticks
EXPECT_EYE_PCT = 1.31                 # each eye, and they must match each other

# The mark is dropped BELOW the geometric middle of the icon box on purpose, so
# that it reads level with the tab TITLE rather than with the box.
#
# Chrome's tab title on Windows is Segoe UI 12px, whose fontBoundingBox is
# ascent 13 / descent 3 - exactly a 16px line box, so the baseline lands at
# y=13 and the ink of a lowercase string runs rows 4..16. Its optical centre
# measures y=10.0 three independent ways (ink bbox, x-height band, and mass
# centroid of the rendered string). A mark centred at y=8 therefore sits 2px
# HIGH against the word, and this mark is only ~7px tall, so it is a thin band
# floating in the upper half of the text's ink instead of straddling it.
# Izzy reported it twice. A full 2/16 drop puts the ink centroid exactly on
# that 10.0, and he called it "a tiny bit too much" - so the SHIPPED value is
# 1.5/16 (centroid 9.49). That is deliberate and it is not a rounding slip:
# the eye compares a mark against the x-height BODIES of the word, and a form
# reads as centred when it sits a touch ABOVE the arithmetic middle. Chosen by
# rendering 1.0/1.25/1.5/1.75/2.0 against text rasterised by Chrome itself and
# looking at them; 1.75 and 2.0 both hang low against the letter bodies.
# ⛔ Do not "correct" this back to 2/16 to make it match the measured 10.0.
#
# The offset is a FRACTION so every frame agrees - Chrome picks the 32px frame
# on a HiDPI display, and the tab must look right at any device pixel ratio.
# COST, stated plainly: a surface that shows the icon with NO text beside it -
# a pinned tab, or a Windows pinned-site shortcut, which reads this same .ico -
# will show the mark sitting low in its box. That is the deliberate trade:
# the favicon's job is overwhelmingly tab strip and bookmarks bar, both of
# which pair it with text. The desktop app has its OWN icon set
# (scripts/desktop-loopcom-windows-assets.py) and is not affected, and
# apple-icon.png is generated from a different source and is untouched.
OPTICAL_DROP_FRAC = 1.5 / 16.0

# How far the ink's vertical centroid may sit from its TARGET (the box middle
# plus OPTICAL_DROP_FRAC). 0.06px is a hair over the rounding floor of
# source-resolution padding and far under anything an eye can see; the bug this
# catches was 0.55px at 16.
MAX_CENTRE_OFFSET_PX = 0.06

_problems: list[str] = []
_written: list[Path] = []


def load(name: str) -> Image.Image:
    path = KIT / name
    if not path.exists():
        sys.exit("missing kit file: {}".format(path))
    return Image.open(path).convert("RGBA")


def solve_ink(src: np.ndarray) -> np.ndarray:
    """Recover the white ink's coverage from the flattened tile."""
    h, w, _ = src.shape
    plate = src[:, :4, :].mean(axis=1)                       # column 0 IS the plate
    plate_img = np.repeat(plate[:, None, :], w, axis=1)
    num = np.zeros((h, w))
    den = np.zeros((h, w))
    for ch in (0, 1):                                        # R and G only - see the header
        head = 255.0 - plate_img[:, :, ch]
        num += (src[:, :, ch] - plate_img[:, :, ch]) * head
        den += head * head
    alpha = np.clip(num / np.maximum(den, 1e-9), 0.0, 1.0)

    rebuilt = alpha[..., None] * 255.0 + (1 - alpha[..., None]) * plate_img
    err = float(np.abs(rebuilt - src).mean())
    if err > 4.0:
        sys.exit("the plate model no longer fits this artwork (mean error %.2f)" % err)
    return alpha


def segment(alpha: np.ndarray):
    """Split the tile into outside / the two eyes / the band."""
    nonink = alpha < 0.5
    # .copy() is load-bearing - see the header.
    work = Image.fromarray(np.where(nonink, 0, 255).astype(np.uint8), "L").copy()

    ImageDraw.floodfill(work, (0, 0), 80)
    outside = np.array(work) == 80
    if not outside.any():
        sys.exit("flood fill did nothing - the working image is read-only again")

    ys, xs = np.where(alpha > 0.02)
    x0, x1 = int(xs.min()), int(xs.max())
    cy = (int(ys.min()) + int(ys.max())) // 2
    for i, seed in enumerate([(int(x0 + 0.25 * (x1 - x0)), cy),
                              (int(x0 + 0.75 * (x1 - x0)), cy)]):
        if outside[seed[1], seed[0]] or not nonink[seed[1], seed[0]]:
            sys.exit("eye seed %s did not land inside a loop" % (seed,))
        ImageDraw.floodfill(work, seed, 160 + i)

    arr = np.array(work)
    eyes = (arr == 160) | (arr == 161)
    band = ~outside & ~eyes

    e0, e1 = 100 * (arr == 160).mean(), 100 * (arr == 161).mean()
    fill = 100 * (band & nonink).mean()
    if abs(e0 - e1) > 0.02:
        sys.exit("the two eyes came out different sizes (%.3f%% vs %.3f%%)" % (e0, e1))
    if abs(fill - EXPECT_BLUE_FILL_PCT) > 0.5:
        sys.exit("the band's blue fill is %.2f%%, expected ~%.2f%% - the background "
                 "has leaked into the band" % (fill, EXPECT_BLUE_FILL_PCT))
    return band.astype(np.float64)


def build_master():
    src = np.asarray(load(MASTER).convert("RGB")).astype(np.float64)
    band = segment(solve_ink(src))
    ys, xs = np.where(band > 0.5)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return src / 255.0, band, box


def render(side: int, src, band, box) -> Image.Image:
    """Premultiplied resize - without it the plate blue still sitting in the fully
    transparent area bleeds into every edge and prints a halo.

    The mark is centred by PADDING AT SOURCE RESOLUTION and then resizing once.
    Do NOT go back to resizing first and compositing at ``(side - nh) // 2``:
    that floor is only exact when the leftover gap is even, and the mark is
    2.22:1, so at 16px it is 7 tall in a 16 box - a gap of 9, which floored to
    4 above / 5 below and printed the tab icon 0.55px HIGH. 32 and 48 happened
    to land on even gaps, so the bug was invisible in every frame except the
    one the tab strip actually uses. Padding at 794px means the residual error
    is a fraction of a SOURCE pixel (~0.02px at 16px) instead of half a
    rendered one, and it costs nothing: this is still a single resample.
    """
    bw, bh = box[2] - box[0], box[3] - box[1]
    rgb = src[box[1]:box[3], box[0]:box[2]]
    a = band[box[1]:box[3], box[0]:box[2]]
    pm = rgb * a[..., None]

    # Square canvas in SOURCE units, with the mark centred inside it and then
    # dropped by OPTICAL_DROP_FRAC so it reads level with the tab title rather
    # than with the box. Doing the drop HERE, at 794px, keeps it subpixel-exact.
    span = int(round(max(bw, bh) / (1 - 2 * MARGIN)))
    ox = (span - bw) // 2
    oy = (span - bh) // 2 + int(round(OPTICAL_DROP_FRAC * span))
    if oy + bh > span:                      # never let the drop clip the mark
        raise SystemExit("OPTICAL_DROP_FRAC is too large - the mark would clip")
    pm_sq = np.zeros((span, span, 3), dtype=np.float64)
    a_sq = np.zeros((span, span), dtype=np.float64)
    pm_sq[oy:oy + bh, ox:ox + bw] = pm
    a_sq[oy:oy + bh, ox:ox + bw] = a

    p = np.asarray(Image.fromarray((pm_sq * 255).astype(np.uint8), "RGB")
                   .resize((side, side), Image.LANCZOS)).astype(np.float64) / 255.0
    al = np.asarray(Image.fromarray((a_sq * 255).astype(np.uint8), "L")
                    .resize((side, side), Image.LANCZOS)).astype(np.float64) / 255.0
    al = np.clip(al, 0.0, 1.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        col = np.where(al[..., None] > 1e-6, p / np.maximum(al[..., None], 1e-6), 0.0)

    return Image.fromarray((np.dstack([np.clip(col, 0, 1), al]) * 255).astype(np.uint8), "RGBA")


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
        directory += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32,
                                 len(blob), offset)
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
            _problems.append("{}: missing sizes {}".format(ICO_PATH.relative_to(REPO), missing))
        else:
            for size in ICO_SIZES:
                with Image.open(ICO_PATH) as ico:
                    ico.size = (size, size)
                    got = ico.convert("RGBA")
                if got.tobytes() != frames[size].tobytes():
                    _problems.append("{}: the {}px frame does not match the kit"
                                     .format(ICO_PATH.relative_to(REPO), size))

            # The tab strip centres a 16x16 icon box against the title text, so
            # the mark's own ink must sit on the centre of that box. This is a
            # SEPARATE failure from "does not match the kit": the frame can be
            # pixel-correct artwork and still be pasted a pixel high. It shipped
            # exactly that way - 16px sat 0.55px high while 32 and 48 were
            # perfect, because only 16 had an odd leftover gap to floor.
            for size in ICO_SIZES:
                with Image.open(ICO_PATH) as ico:
                    ico.size = (size, size)
                    alpha = np.asarray(ico.convert("RGBA")).astype(np.float64)[..., 3]
                if alpha.sum() <= 0:
                    continue
                rows = np.arange(size) + 0.5
                centroid = float((alpha.sum(axis=1) * rows).sum() / alpha.sum())
                off = centroid - size * (0.5 + OPTICAL_DROP_FRAC)
                if abs(off) > MAX_CENTRE_OFFSET_PX:
                    _problems.append(
                        "{}: the {}px frame sits {:+.2f}px off its target ({:+.1f}% of "
                        "the icon) - it will not look level with the tab title"
                        .format(ICO_PATH.relative_to(REPO), size, off, off / size * 100))

    if not APPLE_PATH.exists():
        _problems.append("missing: {}".format(APPLE_PATH.relative_to(REPO)))
    else:
        with Image.open(APPLE_PATH) as img:
            if img.size != (180, 180):
                _problems.append("{}: is {}, expected (180, 180)"
                                 .format(APPLE_PATH.relative_to(REPO), img.size))
            elif np.asarray(img.convert("RGBA"))[..., 3].min() != 255:
                # iOS composites a transparent touch icon onto BLACK, so this one
                # deliberately KEEPS its plate while the favicon does not.
                _problems.append("{}: must stay fully opaque".format(APPLE_PATH.relative_to(REPO)))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()

    src, band, box = build_master()
    bw, bh = box[2] - box[0], box[3] - box[1]
    frames = dict((s, render(s, src, band, box)) for s in ICO_SIZES)

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
    print("mark %dx%d (%.2f:1), scaled edge to edge; favicon frames %s"
          % (bw, bh, bw / bh, ", ".join(str(s) for s in ICO_SIZES)))
    if args.check:
        print("favicon assets OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
