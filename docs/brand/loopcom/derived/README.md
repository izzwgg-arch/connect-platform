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

The 560 px version lives in the portal's public folder rather than here because
⛔ `apps/portal/public/` is **not** covered by `.easignore` — every file there is
uploaded on every mobile EAS build, so only what the app serves belongs in it.
It is sized for the login page's 252 px display at 2× device pixel ratio.

**The original tagline lockups are untouched** in `../masters/` and `../webapp/`
if the tagline is ever wanted again.
