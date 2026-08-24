# LOOPCOM — "NOBODY KNOWS THAT" — 9:16 PRODUCTION PROMPTS

> **Draft — under review.** Not approved copy. See `README.md` in this folder.
> Draft 2 from `AD-PROMPTS-60S-DRAFTS.md`, built out for WhatsApp Status.
> **Characters recast as Chassidic New Yorkers.** Seed images in `ad-characters/`.

---

## THREE THINGS THAT CHANGED GOING VERTICAL

**1. Status caps at 30 seconds. This posts as two segments, not one video.**
That is an advantage here, not a limitation. The natural break falls exactly
where the gag turns — **segment 1 ends on the unanswered question.** The viewer
taps through to segment 2 to get the answer. No other draft splits this well.

```
SEGMENT 1  (28s)  Shots 1–4   Four questions. Ends on "...in Yiddish?" — no answer.
SEGMENT 2  (28s)  Shots 5–8   The answer, the reveal, the button, the card.
```

Generate every clip at 8s, trim shots 1–4 to 7s in the edit. Do not ask the
model for 7-second clips; ask for 8 and cut the tail.

**2. The 16:9 side-by-side two-shot does not survive the crop.** Two men shoulder
to shoulder in a 9:16 frame gives you two slivers of face. The vertical version
stacks them in depth instead: **Ari low and near, Yossi high and far.** Both
faces stay readable, and the vertical column does the work the horizontal
width used to.

**3. Most Status views are muted, and this ad is 100% dialogue.** With the sound
off, this draft communicates nothing at all. Burned-in captions are not
optional here — they are the ad. They're at the bottom of this file,
composited, never generated.

---

## SEED IMAGES — `ad-characters/`

Generated in Runway (nano-banana-pro, 4K, 9:16), 3072×5504 each. These are the
image-to-video start frames, not just reference portraits.

| File | Character | Role in this ad |
|---|---|---|
| `01-mendy-operator-4k.png` | **MENDY** | The one who answers. Shot 6 |
| `02-shimon-spokesman-4k.png` | **SHIMON** | Not used in this draft — held for the campaign |
| `03-rebyidel-elder-4k.png` | **REB YIDEL** | The button line. Shot 7 |
| `04-yossi-ops-4k.png` | **YOSSI** | The punchline. Shots 1–6 |
| `05-ari-owner-4k.png` | **ARI** | Asks the four questions. Shots 1–4, 6 |

### Seeding order — do this or the faces drift

1. Seed shot 1 with **`05-ari-owner-4k.png`**.
2. Take the **last frame of shot 1**, use it as the start frame for shot 2.
3. Same for 3 and 4. The repetition gag depends on the frame not changing —
   if the camera or blocking drifts between takes, the joke dies.
4. Seed shot 5 with **`04-yossi-ops-4k.png`**.
5. Seed shot 6 from the last frame of shot 5.
6. Seed shot 7 with **`03-rebyidel-elder-4k.png`**.

---

## CHARACTER DESCRIPTORS — USE VERBATIM

Copy exactly, every time, in every shot. Changing one adjective between clips is
what makes a face drift. These are the **Chassidish** versions — they replace the
descriptors in `AD-PROMPTS-60S-DRAFTS.md`.

| Name | Descriptor (paste verbatim) |
|---|---|
| **MENDY** | `a Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, round wire-frame glasses, black over-ear headset with a boom microphone, white dress shirt under a black waistcoat` |
| **SHIMON** | `a Chassidic Jewish man in his 40s, wide-brimmed black hat with a high crown, full untrimmed dark beard, sidecurls tucked behind his ears, round wire glasses, long black frock coat over an open-collar white shirt` |
| **REB YIDEL** | `a Chassidic Jewish man in his 60s, wide-brimmed black hat with a high crown, full untrimmed white beard, long white sidecurls, long black frock coat over an open-collar white shirt` |
| **YOSSI** | `a Chassidic Jewish man in his late 20s, black velvet yarmulke, full untrimmed dark beard, curled sidecurls, round wire glasses, white dress shirt under a black waistcoat, tzitzis fringes visible at his waist, holding a closed silver laptop` |
| **ARI** | `a Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark beard, curled sidecurls, black suit jacket over a crisp white dress shirt, dark trousers, tzitzis fringes visible at his waist` |

**Weekday dress only.** No shtreimel anywhere in this campaign — it's Shabbos and
Yom Tov wear, and putting it in a Tuesday-afternoon office ad is the single
fastest way to tell this market the ad wasn't made by anyone who knows them.

---

## SET THE ASPECT RATIO IN THE TOOL, NOT THE PROMPT

Veo, Sora, Kling and Runway all take 9:16 as a parameter. Writing "vertical" in
the prompt and leaving the tool on 16:9 gets you a horizontal video with the
word vertical ignored.

## SAFE ZONES — 1080×1920

```
TOP 230px      WhatsApp progress bars, sender name, timestamp. Nothing here.
BOTTOM 290px   Reply field and forward controls. No faces, no captions here.
LIVE AREA      The middle 1400px. All faces, all captions, all type.
```

## GLOBAL STYLE LINE — APPEND TO EVERY PROMPT

```
Cinematic commercial photography, vertical 9:16 composition, anamorphic
character, shallow depth of field, crushed near-black shadows. Lit by cold
blue-cyan practical lights around 8000K, no warm tones and no wood or brown
surfaces anywhere in frame. Dark modern office interior at night. Performances
natural, dry and understated — deadpan, never mugging, no broad comedy faces.
Photographed with dignity and realism, never caricature, never costume. Faces
kept clear of the extreme top and bottom of frame. No on-screen text, no
letters, no numbers, no logos, no signage, no readable screen content.
```

## GLOBAL NEGATIVE PROMPT — PASTE INTO EVERY GENERATION

```
text, letters, words, writing, captions, subtitles, watermark, logo, signage,
numbers, UI, readable screens, garbled text, gibberish characters, purple,
violet, magenta, lavender, pastel, pink, warm orange tint, wood panelling,
brown furniture, beige walls, domestic interior, shtreimel, fur hat, prayer
shawl, religious ceremony, synagogue, caricature, exaggerated features, sitcom
lighting, laugh track, broad slapstick, wide grins, stock photo smiling, bright
white background, overexposed, low contrast, horizontal letterboxing, black
bars, distorted hands, extra fingers, morphing faces, changing clothing,
changing hat, jitter, flicker, camera shake
```

---
---

# SEGMENT 1 — THE FOUR QUESTIONS

## SHOT 1 of 8 — 8s, trim to 7 — seed: `05-ari-owner-4k.png`

```
Vertical 9:16 composition, stacked in depth. In the lower third of frame, near
to camera and seen from a low three-quarter angle, a Chassidic Jewish man in his
mid-20s, black velvet yarmulke, full untrimmed dark beard, curled sidecurls,
black suit jacket over a crisp white dress shirt, dark trousers, tzitzis fringes visible at his waist,
sits at a dark desk in a modern corner office at night, turned to look back and
up over his shoulder. Behind him and higher in frame, standing in a lit doorway
deeper in the room, a Chassidic Jewish man in his late 20s, black velvet
yarmulke, full untrimmed dark beard, curled sidecurls, round wire glasses, white
dress shirt under a black waistcoat, tzitzis fringes visible at his waist,
holding a closed silver laptop, leans one shoulder against the doorframe. Cold
blue-cyan practicals, matte black surfaces, dark empty headroom above the
standing man. Camera locked off, no movement.

Seated man, direct and a little pleased with himself: "Did you know a missed
call is just a customer calling someone else?"
Standing man, flat and bored, not moving: "Everybody knows that."

Audio: dialogue, quiet room tone, no music.
```

## SHOT 2 of 8 — 8s, trim to 7 — seed: last frame of shot 1

```
Vertical 9:16 composition, identical locked-off framing to the previous shot,
nothing has moved. Lower third, near to camera, low three-quarter angle: a
Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark
beard, curled sidecurls, black suit jacket over a crisp white dress shirt, dark trousers, tzitzis fringes
visible at his waist, seated at a dark desk, turned back and up over his
shoulder. Upper third, deeper in the room, in a lit doorway: a Chassidic Jewish
man in his late 20s, black velvet yarmulke, full untrimmed dark beard, curled
sidecurls, round wire glasses, white dress shirt under a black waistcoat,
tzitzis fringes visible at his waist, holding a closed silver laptop, still
leaning on the doorframe in exactly the same position. Cold blue-cyan
practicals, matte black surfaces. Camera locked off, no reframing.

Seated man: "Did you know Loopcom answers your calls, texts and WhatsApp?"
Standing man, unmoved, same flat delivery: "Everybody knows that."

Audio: dialogue, quiet room tone, no music.
```

## SHOT 3 of 8 — 8s, trim to 7 — seed: last frame of shot 2

```
Vertical 9:16 composition, identical locked-off framing again, still nothing has
moved. Lower third, near to camera: a Chassidic Jewish man in his mid-20s, black
velvet yarmulke, full untrimmed dark beard, curled sidecurls, black suit jacket over a crisp white dress
shirt, dark trousers, tzitzis fringes visible at his waist, seated at a dark
desk, turned back and up over his shoulder. Upper third, in the lit doorway
behind him: a Chassidic Jewish man in his late 20s, black velvet yarmulke, full
untrimmed dark beard, curled sidecurls, round wire glasses, white dress shirt
under a black waistcoat, tzitzis fringes visible at his waist, holding a closed
silver laptop, leaning on the doorframe. Cold blue-cyan practicals, matte black
surfaces. Camera locked off, no movement.

Seated man: "Did you know it's only thirty dollars a month?"
Standing man hesitates for a half second, eyes flicking away and back, then
recovers: "...Everybody knows that."

Audio: dialogue, a beat of silence in the hesitation, room tone, no music.
```

## SHOT 4 of 8 — 8s, trim to 7 — **END OF STATUS SEGMENT 1**

```
Vertical 9:16 composition, same room, same two men, but the camera now pushes in
slowly and slightly, tightening on both. Lower third, near to camera: a
Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark
beard, curled sidecurls, black suit jacket over a crisp white dress shirt, dark trousers, tzitzis fringes
visible at his waist, seated at a dark desk, now leaning forward, more
deliberate. Upper third, in the lit doorway behind him: a Chassidic Jewish man
in his late 20s, black velvet yarmulke, full untrimmed dark beard, curled
sidecurls, round wire glasses, white dress shirt under a black waistcoat,
tzitzis fringes visible at his waist, holding a closed silver laptop. Cold
blue-cyan practicals, matte black surfaces. Very slow push in, no other
movement.

Seated man: "Did you know it writes out your voicemail? In Yiddish?"
The standing man says nothing at all. He straightens up off the doorframe and
holds still.

Audio: the seated man's line, then two full seconds of room tone and silence.
No music, no reply.
```

> Segment 1 ends here, on the silence. Do not answer the question in segment 1.

---
---

# SEGMENT 2 — THE ANSWER

## SHOT 5 of 8 — 8s — seed: `04-yossi-ops-4k.png`

```
Vertical 9:16 composition, tight vertical close-up filling the centre of frame.
A Chassidic Jewish man in his late 20s, black velvet yarmulke, full untrimmed
dark beard, curled sidecurls, round wire glasses, white dress shirt under a
black waistcoat, holding a closed silver laptop, stands in a dark office doorway
lit by a single cold blue-cyan practical from one side, the other side of his
face falling into near-black. He is looking directly at someone below and to the
left of camera. For the first time he is genuinely thrown — not shocked, just
recalculating. Dark headroom above him, clean dark space below his shoulders.
Camera locked off. Matte black and charcoal surfaces only, no wood.

Dialogue, quiet, flat, after a real pause: "No. Nobody knows that."

Audio: his line, room tone, no music.
```

## SHOT 6 of 8 — 8s — seed: last frame of shot 5

```
Vertical 9:16 composition using deep receding space up the frame. In the lower
third, backs and shoulders only, slightly out of focus: a Chassidic Jewish man
in his mid-20s, black velvet yarmulke, full untrimmed dark beard, curled
sidecurls, black suit jacket over a crisp white dress shirt, dark trousers, and a Chassidic Jewish man in
his late 20s, black velvet yarmulke, full untrimmed dark beard, curled
sidecurls, round wire glasses, white dress shirt under a black waistcoat,
holding a closed silver laptop. Far behind and above them, small in the upper
third of frame at a lit workstation in a dark operations room, a Chassidic
Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark beard,
long curled sidecurls, round wire-frame glasses, black over-ear headset with a
boom microphone, white dress shirt under a black waistcoat, is on a call —
nodding, working steadily, completely unaware of the two men in front. Cold cyan
monitor glow is the only light on him. Slow rack focus from the two men in the
foreground up to the man on the headset behind.

Audio: room tone, a faint muffled one-sided phone conversation, no music, no
dialogue.
```

## SHOT 7 of 8 — 8s — seed: `03-rebyidel-elder-4k.png`

```
Vertical 9:16 composition. Lower half of frame: the dark out-of-focus shoulders
of two men in the foreground, unmoving. Upper half: an open lit doorway deeper
in the office. A Chassidic Jewish man in his 60s, wide-brimmed black hat with a
high crown, full untrimmed white beard, long white sidecurls, long black frock
coat over an open-collar white shirt, walks across the doorway from left to
right without stopping and without turning his head, already leaving frame as he
speaks. He is warm and entirely unhurried. Cold blue-cyan practicals, matte
black surfaces, dark headroom at the top of frame. Camera locked off.

Dialogue, thrown over his shoulder, easy and amused: "I knew that."

Audio: his line, unhurried footsteps, room tone, no music.
```

## SHOT 8 of 8 — 4s — **DO NOT GENERATE. COMPOSITE THIS.**

```
Static plate, 1080×1920. Near-black ground (#05080C–#0C1218). Soft cyan glow low
in frame. Centre of frame kept completely empty for the lockup.

Composited elements, in the live area between y=400 and y=1450:
  LOOPCOM wordmark            centred, scaled by HEIGHT not width (4.53:1)
  $30/MONTH                   below the mark
  WhatsApp +1 845 723 1213    below that, largest legible weight

Absolutely no motion for the full 4 seconds. One music hit as the mark lands,
then silence. Motion on a call-to-action costs you readers.
```

---
---

# BURNED-IN CAPTIONS — THE SOUND-OFF VERSION

Composited over the finished clips, never generated. These are **not** a
transcript — they're a shorter parallel version that has to stand alone for a
muted viewer. Set at y≈1350–1550, IBM Plex Sans, all caps, 46–54px, white on a
40%-opacity near-black slab with 45° chamfered corners. Nothing under 18px ever.

**Segment 1**

| Clip | Caption in | Caption |
|---|---|---|
| 1 | 0.6s | A MISSED CALL IS A CUSTOMER<br>CALLING SOMEONE ELSE |
| 1 | 4.4s | "EVERYBODY KNOWS THAT" |
| 2 | 7.6s | CALLS · TEXTS · WHATSAPP<br>ONE SYSTEM |
| 2 | 11.4s | "EVERYBODY KNOWS THAT" |
| 3 | 14.6s | $30 / MONTH |
| 3 | 18.4s | "...EVERYBODY KNOWS THAT" |
| 4 | 21.6s | YIDDISH VOICEMAIL,<br>WRITTEN OUT AUTOMATICALLY |
| 4 | 26.0s | *(no caption — hold the silence)* |

**Segment 2**

| Clip | Caption in | Caption |
|---|---|---|
| 5 | 1.2s | "NOBODY KNOWS THAT" |
| 6 | 9.0s | ONE PERSON ANSWERS EVERYTHING |
| 7 | 17.0s | "I KNEW THAT" |
| 8 | 24.0s | *(tag card type only)* |

The two quoted "EVERYBODY KNOWS THAT" cards should be **byte-identical** —
same position, same size, same slab. The repetition is the joke; a caption that
shifts 4px between repeats reads as sloppiness instead of rhythm.

**A Yiddish caption set is worth building.** The spoken track can stay English
while the captions run Yiddish — that costs one render, needs no voice talent,
and speaks to the 845 and Brooklyn audience in their own language on a muted
screen. If you go that way the Yiddish has to be set by someone who reads it;
do not let a translation tool near the punchline.

---

## PRODUCTION CHECKLIST

- [ ] Aspect ratio set to 9:16 **in the tool**, not just in the prompt
- [ ] Shots 1–4 chain-seeded from each other's final frame, framing locked
- [ ] Shots 1–4 trimmed 8s → 7s so segment 1 lands at 28s, under the Status cap
- [ ] No generated text anywhere in any clip — check every frame, not just the first
- [ ] Yarmulke, sidecurls, glasses and waistcoat identical across shots 1–6
- [ ] Weekday dress throughout — no shtreimel, no tallis, no ceremonial wear
- [ ] Captions clear the bottom 290px reply field on a real device, not in the NLE
- [ ] Tag card composited from the brochure template, logo scaled by height
- [ ] Watched once with the sound off, start to finish, before it goes anywhere

---

## STILL OPEN

- **The Yiddish claim is the punchline.** It is the payoff of the whole ad and it
  is the one thing `apps/agent` cannot currently do. Same call you made on the
  brochures — restated here because in this cut it isn't a bullet, it's the
  reason the ad works.
- **Segment 2 has to be posted immediately after segment 1**, in order. If Status
  reorders them or someone views them out of sequence the punchline lands before
  the setup. Post them back to back and check the order on a real device.
