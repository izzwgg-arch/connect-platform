# LOOPCOM AD — CHARACTER SEED FRAMES

Five Chassidic New York characters for the "Nobody Knows That" ad
(`../AD-DRAFT2-9x16-PROMPTS.md`). Generated 2026-08-24.

**These are image-to-video start frames, not just reference portraits.** Feed the
file into the video tool as the start frame for that character's first shot, then
chain each clip's last frame into the next.

| File | Character | Role |
|---|---|---|
| `01-mendy-operator-4k.png` | **MENDY**, mid-20s | The one who answers. Headset, ops room. Shot 6 |
| `02-shimon-spokesman-4k.png` | **SHIMON**, 40s | Deadpan spokesman. Not in this ad — held for the campaign |
| `03-rebyidel-elder-4k.png` | **REB YIDEL**, 60s | The veteran owner. Button line, shot 7 |
| `04-yossi-ops-4k.png` | **YOSSI**, late 20s | Dry ops man. The punchline. Shots 1–6 |
| `05-ari-owner-4k.png` | **ARI**, mid-20s | Young owner. Asks the four questions. Shots 1–4, 6 |

## Generation settings

```
Tool     Runway  →  nano-banana-pro (Gemini 3 Pro Image)
Size     4K tier  →  3072 × 5504 native
Ratio    9:16
Grade    near-black ground, cold blue-cyan practicals ~8000K, no warm tones
```

Full prompts are recoverable from the Runway task history; the descriptors that
must stay verbatim across every video clip are in the shot-list doc.

## Casting decisions

- **Weekday dress only. No shtreimel.** A shtreimel is Shabbos and Yom Tov wear.
  In a Tuesday-afternoon office ad it is the fastest possible way to tell this
  market that nobody who knows them made the ad.
- **No specific chassidus.** Broad wide-brim black hat and weekday rekel rather
  than a Satmar or Belz-specific silhouette — pinning one group narrows the
  audience for no gain.
- **Untrimmed beards, visible peyos, visible tzitzis.** These are the markers
  that separate Chassidish from yeshivish or modern Orthodox, and they were the
  main thing missing from the original reference photos for Yossi and Ari.
- **Dignified, never caricature.** Every prompt carried that instruction
  explicitly. Check any regeneration against it before using it.

## Known deviations from brief

- `03-rebyidel-elder-4k.png` — the model gave him a **mahogany-panelled office**.
  Warm wood is against the brand ground (`#05080C–#0C1218` + cyan only). It suits
  the "forty years, six phone companies" character, but it does not match the
  dark modern office the other four are in. Either grade the wood cold in post or
  regenerate with `no wood, no warm brown` in the negative prompt.
- `04-yossi-ops-4k.png` — warm wood doorframe, same issue, smaller area.
- `05-ari-owner-4k.png` — the model added a **black suit jacket** that the prompt
  didn't ask for. Kept, because it reads well for a young owner, and the
  descriptor in the shot list was updated to match. Do not drop it between clips.
- `05-ari-owner-4k-v1-REJECTED.png` — first pass. Cramped back office instead of a
  corner office, and a trimmed beard that read modern Orthodox next to the other
  four. Kept only for comparison; do not seed from it.

## These are ~17 MB each and are gitignored

`.gitignore` in this folder keeps them out of the repo — about 100 MB total, and
git history is unforgiving about large binaries. Delete that file if you
genuinely want them tracked, but consider object storage or the brand pack
instead.
