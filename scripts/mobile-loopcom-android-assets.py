#!/usr/bin/env python3
"""
Regenerate the Android launcher icon set and the splash artwork from the
Loopcom brand kit.

    python scripts/mobile-loopcom-android-assets.py            # writes the files
    python scripts/mobile-loopcom-android-assets.py --check    # verifies, writes nothing

Why this exists
---------------
The 2026-08-20 rebrand generated the launcher icons by hand and recorded the
scale only in prose, so nobody could tell afterwards how much of the frame the
mark was meant to occupy — and it turned out to be too much (the mark's glow was


Requires Pillow: pip install Pillow
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - environment guard
    sys.exit("Pillow is required:  pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
BRAND = REPO / "docs" / "brand" / "loopcom"
MOBILE = REPO / "apps" / "mobile"
RES = MOBILE / "android" / "app" / "src" / "main" / "res"

# ── The brand's own tokens (docs/brand/loopcom/README.md) ────────────────────
GROUND = (0x0C, 0x12, 0x18)          # the brand's flat ground; see ICON_GROUND below
SPLASH_STOPS = [                      # mirrors the LinearGradient in SplashScreen.tsx
    (0.00, (0x04, 0x08, 0x10)),
    (0.20, (0x06, 0x0C, 0x18)),
    (0.50, (0x0A, 0x10, 0x20)),
    (0.80, (0x08, 0x11, 0x1E)),
    (1.00, (0x04, 0x08, 0x10)),
]
WORDMARK_INK = (0xF0, 0xF6, 0xFF)
TAGLINE_INK = (0x8F, 0xC0, 0xF5)
GLOW = (0x22, 0xA8, 0xFF)

# ⛔⛔ THE ICON IS THE WHOLE LOGO ON WHITE ("W1"), chosen by Izzy on
# 2026-08-21 after three rounds. Two earlier attempts are worth knowing about so
# nobody repeats them:
#
#   1. The bare infinity mark on the brand's near-black ground. Sized by the
#      mark's PADDED SQUARE rather than its ink, so the glyph occupied a quarter
#      of the tile. Izzy: "tiny, barely visible, absolutely not." It shipped.
#   2. The whole logo on a BLUE tile. The logo's letters are a dark-blue chrome,
#      so on blue they have almost no contrast and the word vanishes at 60dp.
#
# White is what makes it work: the chrome letters were drawn for a light ground.
# The result reads next to Gmail, PayPal POS and eBay, which are white circles.
#
# ⛔ Judge any change here by rendering at 140-180px on a DARK background - a
# real launcher icon is ~60dp. Reviewing at 256px+ is exactly what hid the
# original problem; at that size the unreadable version looked fine.
#
# ⛔ The artwork is the WORDMARK (derived/loopcom-wordmark.png, ~6.2:1), not the
# infinity mark. It is very wide, so it is sized against the adaptive icon's
# VISIBLE 72dp area - anything wider is cropped away by the launcher's mask.
ICON_ART = BRAND / "derived" / "loopcom-wordmark.png"
ICON_ART_W = 0.92           # artwork width as a fraction of the VISIBLE 72dp area
ICON_ART_INK_THRESHOLD = 16
ICON_GROUND = ((0xFF, 0xFF, 0xFF), (0xFF, 0xFF, 0xFF))  # top -> bottom gradient
ICON_GLOW_ALPHA = 0         # radial accent glow behind the art, 0 disables
ICON_INK_BOOST = 1.0        # >1 brightens the art; only useful on a dark ground

# Android adaptive icons: 108dp canvas, 72dp guaranteed-visible centre.
ADAPTIVE_CANVAS_DP = 108
ADAPTIVE_VISIBLE_DP = 72

# Legacy (pre-API-26) launcher px per density, and the adaptive foreground px.
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}
DENSITY_SCALE = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}

# Splash canvas in dp. Portrait so a centre-crop on a tall phone barely crops.
SPLASH_W_DP, SPLASH_H_DP = 360, 780
# ⛔ Measured from the mark's INK, not its bounding box. The infinity glyph is
# wide and short with a lot of transparent padding around it, so sizing and
# spacing by the box puts a visually huge gap under the mark and makes it read
# far smaller than the number suggests.
SPLASH_LOGO_W = 0.74          # the REAL logo (wordmark), fraction of canvas width
# ⛔ 0.27 shipped on 2026-08-21 and was far too small on a real 6.2" screen -
# it read as nothing happening. Judge this from a screen recording of a real
# phone, never from a mockup: a browser mockup at 250px wide flatters it badly.
SPLASH_GAP_DP = 26            # logo bottom -> tagline cap top
SPLASH_WORD_DP = 34           # matches styles.appName fontSize
SPLASH_WORD_TRACKING_DP = 2.5  # matches styles.appName letterSpacing
SPLASH_SUB_GAP_DP = 14
SPLASH_SUB_DP = 13
SPLASH_GROUP_CENTRE = 0.45    # group's optical centre, as a fraction of height
WORDMARK_TEXT = "Loopcom"
TAGLINE_TEXT = "The AI communications platform"

SUPERSAMPLE = 4  # anti-aliases the mask edges; the icons are small and it shows

_written: list[Path] = []
_problems: list[str] = []


# ── helpers ─────────────────────────────────────────────────────────────────
def load_mark() -> Image.Image:
    """The transparent Loopcom infinity mark, drawn for a dark ground."""
    p = BRAND / "app-icons" / "android-dark-512.png"
    if not p.exists():
        sys.exit(f"missing brand asset: {p}")
    return Image.open(p).convert("RGBA")


def ink_crop(img: Image.Image, threshold: int = 24) -> Image.Image:
    """
    Crop to the mark's visible ink.

    ⛔ NOT Image.getbbox() — the brand PNG carries a scatter of near-zero alpha
    pixels right out to the edges, so getbbox() returns the whole square and the
    crop silently does nothing. That made the splash mark render ~20% smaller
    than the number in the config said.
    """
    alpha = img.convert("RGBA").split()[-1].point(lambda v: 255 if v >= threshold else 0)
    box = alpha.getbbox()
    return img.crop(box) if box else img


def emit(img: Image.Image, path: Path, check: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if check:
        if not path.exists():
            _problems.append(f"missing: {path.relative_to(REPO)}")
        return
    img.save(path, optimize=True)
    _written.append(path)


def icon_ground(px: int) -> Image.Image:
    """The adaptive icon's background, as a vertical gradient."""
    top, bottom = ICON_GROUND
    img = Image.new("RGB", (px, px), top)
    d = ImageDraw.Draw(img)
    for y in range(px):
        t = y / max(1, px - 1)
        d.line([(0, y), (px, y)],
               fill=tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.convert("RGBA")


def _boosted(ink: Image.Image) -> Image.Image:
    if ICON_INK_BOOST == 1.0:
        return ink
    r, g, b, a = ink.split()
    f = lambda v: min(255, int(v * ICON_INK_BOOST))
    return Image.merge("RGBA", (r.point(f), g.point(f), b.point(f),
                                a.point(lambda v: min(255, int(v * 1.3)))))


def adaptive_canvas(mark: Image.Image, px: int, with_ground: bool = False) -> Image.Image:
    """
    The 108dp adaptive foreground.

    ICON_ART_W is expressed against the VISIBLE 72dp area, so the artwork is
    scaled by 72/108 to land at that size once the launcher crops the canvas.

    `mark` is ignored: the icon artwork comes from ICON_ART. The parameter is
    kept so the call sites read the same as the splash ones.
    """
    del mark
    canvas = icon_ground(px) if with_ground else Image.new("RGBA", (px, px), (0, 0, 0, 0))
    if with_ground and ICON_GLOW_ALPHA:
        r = px // 2
        glow = Image.new("RGBA", (px, px), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for i in range(r, 0, -max(1, r // 120)):
            a = round(ICON_GLOW_ALPHA * (1 - i / r) ** 2.0)
            gd.ellipse((r - i, r - i, r + i, r + i), fill=GLOW + (a,))
        canvas.alpha_composite(glow)

    if not ICON_ART.exists():
        sys.exit(f"missing brand asset: {ICON_ART}")
    art = _boosted(ink_crop(Image.open(ICON_ART).convert("RGBA"),
                            threshold=ICON_ART_INK_THRESHOLD))
    w = round(px * ICON_ART_W * ADAPTIVE_VISIBLE_DP / ADAPTIVE_CANVAS_DP)
    h = max(1, round(w * art.size[1] / art.size[0]))
    art = art.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(art, ((px - w) // 2, (px - h) // 2))
    return canvas


def visible_crop(canvas: Image.Image) -> Image.Image:
    """What a launcher actually shows: the central 72 of the 108dp canvas."""
    s = canvas.size[0]
    v = round(s * ADAPTIVE_VISIBLE_DP / ADAPTIVE_CANVAS_DP)
    off = (s - v) // 2
    return canvas.crop((off, off, off + v, off + v))


def legacy_icon(mark: Image.Image, px: int, round_mask: bool) -> Image.Image:
    """
    Pre-API-26 launcher icon. Rendered from the SAME geometry the adaptive icon
    resolves to, so old and new Android show an identically-proportioned mark.
    """
    big = px * SUPERSAMPLE
    canvas = adaptive_canvas(mark, round(big * ADAPTIVE_CANVAS_DP / ADAPTIVE_VISIBLE_DP),
                             with_ground=True)
    vis = visible_crop(canvas)
    n = vis.size[0]
    if round_mask:
        mask = Image.new("L", (n, n), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, n - 1, n - 1), fill=255)
        out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
        out.paste(vis, (0, 0), mask)
        vis = out
    return vis.resize((px, px), Image.LANCZOS)


def _font(px: int, bold: bool):
    """
    Roboto is Android's UI face, so the splash image matches what the app draws.
    Only Roboto-Regular ships with Windows; bold is faked with a stroke, which
    is close enough for artwork nothing currently loads (see the note in the
    handoff about splashscreen_image being unreferenced).
    """
    for name in (("Roboto-Bold.ttf", "Roboto-Medium.ttf") if bold else ()) + ("Roboto-Regular.ttf",):
        for base in (Path("C:/Windows/Fonts"), Path("/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF")):
            p = base / name
            if p.exists():
                return ImageFont.truetype(str(p), px), (name == "Roboto-Regular.ttf" and bold)
    return ImageFont.load_default(), False


def text_layer(text, font, fill, tracking, stroke=0) -> Image.Image:
    """
    A tightly-cropped RGBA layer of `text`.

    PIL has no letter-spacing, so the glyphs are placed one at a time — and they
    MUST share a baseline (anchor "ls"). Anchoring by the glyph top ("lt")
    aligns cap-height letters with x-height letters and the word visibly
    staircases; that shipped once in this file's first draft.
    """
    pad = max(8, font.size)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    widths = [probe.textlength(ch, font=font) for ch in text]
    w = int(sum(widths) + tracking * max(0, len(text) - 1) + pad * 2)
    h = int(font.size * 3)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    x, baseline = float(pad), font.size * 2.0
    for ch, cw in zip(text, widths):
        d.text((x, baseline), ch, font=font, fill=fill,
               stroke_width=stroke, stroke_fill=fill, anchor="ls")
        x += cw + tracking
    box = img.getbbox()
    return img.crop(box) if box else img


def splash_image(mark: Image.Image, w: int, h: int, scale: float) -> Image.Image:
    img = Image.new("RGB", (w, h), SPLASH_STOPS[0][1])
    px = img.load()

    # vertical gradient
    for y in range(h):
        t = y / max(1, h - 1)
        row = SPLASH_STOPS[-1][1]
        for i in range(len(SPLASH_STOPS) - 1):
            t0, c0 = SPLASH_STOPS[i]
            t1, c1 = SPLASH_STOPS[i + 1]
            if t0 <= t <= t1:
                k = 0 if t1 == t0 else (t - t0) / (t1 - t0)
                row = tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
                break
        for x in range(w):
            px[x, y] = row

    # ── the three pieces, each cropped to its own ink ────────────────────────
    # the REAL logo, not the bare mark plus typed text
    logo_src = BRAND / "derived" / "loopcom-wordmark.png"
    if not logo_src.exists():
        sys.exit(f"missing brand asset: {logo_src}")
    ink = ink_crop(Image.open(logo_src).convert("RGBA"), threshold=16)
    target_w = round(w * SPLASH_LOGO_W)
    ink = ink.resize((target_w, max(1, round(target_w * ink.size[1] / ink.size[0]))),
                     Image.LANCZOS)

    sub_px = round(SPLASH_SUB_DP * scale)
    f_sub, _ = _font(sub_px, bold=False)
    sub = text_layer(TAGLINE_TEXT, f_sub, TAGLINE_INK, 0.4 * scale)

    gap1 = SPLASH_GAP_DP * scale
    group_h = ink.size[1] + gap1 + sub.size[1]
    top = h * SPLASH_GROUP_CENTRE - group_h / 2
    cx = w / 2

    # soft glow, centred on the mark
    mark_cy = top + ink.size[1] / 2
    glow_r = round(w * 0.60)
    glow = Image.new("RGBA", (glow_r * 2, glow_r * 2), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for i in range(glow_r, 0, -max(1, glow_r // 110)):
        a = round(30 * (1 - i / glow_r) ** 2.2)
        gd.ellipse((glow_r - i, glow_r - i, glow_r + i, glow_r + i), fill=GLOW + (a,))
    img.paste(glow, (round(cx - glow_r), round(mark_cy - glow_r)), glow)

    y = top
    for layer in (ink, sub):
        img.paste(layer, (round(cx - layer.size[0] / 2), round(y)), layer)
        y += layer.size[1] + gap1
    return img


# ── build ───────────────────────────────────────────────────────────────────
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()
    check = args.check

    mark = load_mark()

    # 1 · launcher icons
    for density, (legacy_px, fg_px) in DENSITIES.items():
        d = RES / f"mipmap-{density}"
        fg = adaptive_canvas(mark, fg_px * SUPERSAMPLE).resize((fg_px, fg_px), Image.LANCZOS)
        emit(fg, d / "ic_launcher_foreground.png", check)
        # ⛔ The adaptive BACKGROUND is its own layer. It used to be the flat
        # @color/iconBackground (#0C1218), which is why the icon vanished into a
        # dark wallpaper - the tile had no edge. A drawable lets it be a gradient
        # and keeps the launcher's parallax working.
        emit(icon_ground(fg_px * SUPERSAMPLE).resize((fg_px, fg_px), Image.LANCZOS),
             d / "ic_launcher_background.png", check)
        emit(legacy_icon(mark, legacy_px, round_mask=False), d / "ic_launcher.png", check)
        emit(legacy_icon(mark, legacy_px, round_mask=True), d / "ic_launcher_round.png", check)

    # 2 · the Expo source for the adaptive foreground.
    #    ⛔ This file held a copy of the old Connect SPLASH (1376x768) until
    #    2026-08-21 — a prebuild would have destroyed the launcher icon.
    emit(adaptive_canvas(mark, 1024 * 2).resize((1024, 1024), Image.LANCZOS),
         MOBILE / "assets" / "adaptive-icon.png", check)

    # 3 · the mark the app itself draws (SplashScreen.tsx).
    #    Cropped to its ink so a React Native width/height lays out honestly —
    #    the untrimmed square is mostly transparent padding.
    ink = ink_crop(mark)
    ink_w = 640
    emit(ink.resize((ink_w, max(1, round(ink_w * ink.size[1] / ink.size[0]))), Image.LANCZOS),
         MOBILE / "assets" / "loopcom-mark.png", check)

    # 4 · splash artwork
    base = splash_image(mark, SPLASH_W_DP * 4, SPLASH_H_DP * 4, 4.0)
    emit(base, MOBILE / "assets" / "splash.png", check)
    for density, s in DENSITY_SCALE.items():
        w, h = round(SPLASH_W_DP * s), round(SPLASH_H_DP * s)
        emit(base.resize((w, h), Image.LANCZOS),
             RES / f"drawable-{density}" / "splashscreen_image.png", check)

    if check:
        if _problems:
            print("\n".join(_problems))
            return 1
        print(f"ok - all Loopcom Android assets present (ICON_ART_W={ICON_ART_W})")
        return 0

    total = sum(p.stat().st_size for p in _written)
    for p in _written:
        print(f"{p.stat().st_size:>9,}  {p.relative_to(REPO)}")
    print(f"\n{len(_written)} files, {total/1024/1024:.2f} MB total (ICON_ART_W={ICON_ART_W})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
