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
clipped by the circular mask on Pixel/Motorola). MARK_SCALE below is now the one
place that number lives. Change it here, re-run, and every density follows.

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
GROUND = (0x0C, 0x12, 0x18)          # adaptive-icon background, == @color/iconBackground
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

# ⛔ THE SPACING DECISION. Izzy picked "option A — mark with breathing room"
# from the 2026-08-21 mockup. The mark is drawn at this fraction of the 108dp
# adaptive canvas; Android only ever shows the central 72dp of that canvas, so
# a larger number pushes the mark's outer glow under the mask edge. The previous
# value was 0.85, which clipped on every circular-mask launcher.
MARK_SCALE = 0.70

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
SPLASH_MARK_INK_W = 0.27      # fraction of canvas width
SPLASH_GAP_DP = 34            # mark ink bottom -> wordmark cap top
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


def adaptive_canvas(mark: Image.Image, px: int) -> Image.Image:
    """The 108dp adaptive foreground: transparent, mark centred at MARK_SCALE."""
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    d = max(1, round(px * MARK_SCALE))
    scaled = mark.resize((d, d), Image.LANCZOS)
    off = (px - d) // 2
    canvas.alpha_composite(scaled, (off, off))
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
    canvas = adaptive_canvas(mark, round(big * ADAPTIVE_CANVAS_DP / ADAPTIVE_VISIBLE_DP))
    ground = Image.new("RGBA", canvas.size, GROUND + (255,))
    ground.alpha_composite(canvas)
    vis = visible_crop(ground)
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
    ink = ink_crop(mark)
    target_w = round(w * SPLASH_MARK_INK_W)
    ink = ink.resize((target_w, max(1, round(target_w * ink.size[1] / ink.size[0]))),
                     Image.LANCZOS)

    word_px = round(SPLASH_WORD_DP * scale)
    f_word, fake_bold = _font(word_px, bold=True)
    word = text_layer(WORDMARK_TEXT, f_word, WORDMARK_INK,
                      SPLASH_WORD_TRACKING_DP * scale,
                      stroke=max(1, round(word_px * 0.04)) if fake_bold else 0)

    sub_px = round(SPLASH_SUB_DP * scale)
    f_sub, _ = _font(sub_px, bold=False)
    sub = text_layer(TAGLINE_TEXT, f_sub, TAGLINE_INK, 0.4 * scale)

    gap1, gap2 = SPLASH_GAP_DP * scale, SPLASH_SUB_GAP_DP * scale
    group_h = ink.size[1] + gap1 + word.size[1] + gap2 + sub.size[1]
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
    for layer in (ink, word, sub):
        img.paste(layer, (round(cx - layer.size[0] / 2), round(y)), layer)
        y += layer.size[1] + (gap1 if layer is ink else gap2)
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
        print(f"ok — all Loopcom Android assets present (MARK_SCALE={MARK_SCALE})")
        return 0

    total = sum(p.stat().st_size for p in _written)
    for p in _written:
        print(f"{p.stat().st_size:>9,}  {p.relative_to(REPO)}")
    print(f"\n{len(_written)} files, {total/1024/1024:.2f} MB total (MARK_SCALE={MARK_SCALE})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
