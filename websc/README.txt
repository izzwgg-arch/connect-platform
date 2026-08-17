LOOPCOM — WEB & APP ASSETS  ·  SIGNAL CORE colorway
====================================================
All PNG · transparent background (except the two store icons, which must be opaque)

COLOR: Signal Core — #22A8FF → #4F7BFF on #0C1218
       Gradient sweeps electric blue (left) to indigo (right) across the wordmark.
       Deep ink variants for light backgrounds: #052758 / #053874 (11–14:1 on white)

masters/    full-size logos in Signal Core
  loopcom-logo-dark.png ........... 1672×941  ★ primary
  loopcom-logo-light.png .......... 1672×941  light-background scene
  loopcom-logo-clear.png .......... 1536×1024 RGBA transparent, full canvas
  loopcom-logo-clear-tight.png .... 1424×315  RGBA cropped — use for layouts
  loopcom-icon-mark.png ........... 1254×1254 infinity mark

invoice/    600 @1x · 1200 @2x · 1800 (300dpi ≈152mm) — DARK INK for white paper
            + loopcom-invoice-600-onDark.png if your invoice template is dark
            place 45–65mm wide in the header

favicon/    512 192 180 96 64 48 32 16 + favicon.ico
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" href="/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/favicon-180.png">

email/      240 display · 480 @2x retina (set width="240" in HTML)
            + 480@2x-light.png for light emails · icon-128 for footers
            host these on your own domain; do not hotlink

webapp/     nav h32 / h40 (@1x) · h64 / h80 (@2x) · h64@2x-light
            square icons 32 40 64 128 256 for collapsed sidebar & tabs

splash/     iOS 1242×2688 · 1125×2436 · 1242×2208 · 828×1792
            Android 1080×1920 · 1440×2560 · iPad Pro 2048×2732
            logo is transparent — set background #0C1218 in your app config
            splash-logo-only-1200.png if your framework scales a single asset

app-icons/  ios-dark-*   1024 180 167 152 120 87 80 76 60 58 40 29
            ios-light-*  same sizes, deep ink for light tiles
            android-dark-* / android-light-*  512 192 144 96 72 48
            store-dark-1024-opaque.png / store-light-1024-opaque.png
            ⚠ App Store & Play Store REJECT transparent icons — submit the
              opaque files for listings, use transparent ones in-app.

CLEAR SPACE: margin equal to the infinity's height on all sides
MIN SIZE:    lockup 180px / 45mm wide · mark alone 24px / 8mm
