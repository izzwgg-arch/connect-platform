# Derived assets — wordmark without the tagline

Izzy's instruction, 2026-08-16: *"take away the words 'the AI communications
platform' … It should just be the logo."*

## How these were made

⛔ **By cropping, not by editing.** In `../masters/loopcom-logo-clear-tight.png`
(1424×315 RGBA) the artwork sits in two separate ink bands with a clean empty
gap between them:

| band | rows | what |
|---|---|---|
| 0 | y 13–238 | the LOOPCOM wordmark |
| — | y 239–265 | 27 px of nothing |
| 1 | y 266–303 | the "THE AI COMMUNICATIONS PLATFORM" tagline |

So the tagline comes off with a single crop at **y = 253**, the midpoint of the
gap. **The wordmark's own pixels are untouched** — not redrawn, not re-rendered,
not run through any background remover or AI erase. Verified after cropping:
corners still `alpha 0`, and max alpha on the top and bottom edges is `1`, so
nothing was clipped.

⛔ **Do not "improve" these with a background-removal tool.** The source is
already RGBA and 39.4% fully transparent — running a remover over it would only
re-encode and degrade the chrome gradients. This was checked before any tool was
considered: the dark background people see behind the logo in mockups is a panel
someone put *there*, never part of the file.

Reproduce with Pillow:

```python
from PIL import Image
src = Image.open("../masters/loopcom-logo-clear-tight.png").convert("RGBA")
src.crop((0, 0, src.size[0], 253)).save("loopcom-wordmark.png")
```

## Files

| file | size | use |
|---|---|---|
| `loopcom-wordmark.png` | 1424×253 | full-res master of the tagline-free wordmark |
| `loopcom-wordmark-h80@2x.png` | 901×160 | 2× nav height |
| `../../../apps/portal/public/brand/loopcom/loopcom-wordmark-560.png` | 560×99 | **the one the login page actually loads** (81 KB) |
| `../../../apps/api/src/billing/assets/loopcom-logo.png` | 640×114 | **the one the invoice + receipt PDFs embed** (103 KB) |

The 560 px version lives in the portal's public folder rather than here because
⛔ `apps/portal/public/` is **not** covered by `.easignore` — every file there is
uploaded on every mobile EAS build, so only what the app serves belongs in it.
It is sized for the login page's 252 px display at 2× device pixel ratio.

**The original tagline lockups are untouched** in `../masters/` and `../webapp/`
if the tagline is ever wanted again.

## The PDF one, and why it is its own size

`apps/api/src/billing/assets/loopcom-logo.png` is embedded in every invoice and
receipt PDF — documents customers print and file — so it is sized for PAPER, not
for a screen: 640 px across a 190 pt render is **243 DPI**.

⛔ It lives beside the code rather than being fetched, because a PDF is generated
server-side with no browser to load a URL. ⛔ And it is deliberately NOT the 560 px
login file: that one is 212 DPI here, which is under the ~200 DPI floor once a
printer scales it.

⛔ **Do not quantise it to save bytes.** Palette quantisation caps alpha at 253, so
the wordmark would print faintly translucent — the trap that already rejected a
9 KB email logo (see the email-rebrand handoff). It is 103 KB of the ~146 KB PDF,
and that is the honest cost of chrome artwork; the old flat Connect mark was 28 KB.

Reproduce with Pillow:

```python
from PIL import Image
src = Image.open("loopcom-wordmark.png").convert("RGBA")   # 1424×253, tagline-free
src.resize((640, 114), Image.LANCZOS).save(
    "../../../apps/api/src/billing/assets/loopcom-logo.png", optimize=True)
```

`billingPdfLogo.test.ts` pins that the file stays 8-bit non-interlaced RGBA
(PDFKit rejects interlaced PNGs) and that its aspect ratio is the tagline-free
~5.6:1 — a lockup carrying the tagline is ~4.5:1, so it can never pass by accident.
