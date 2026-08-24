# LOOPCOM — "THE SPOKESMAN" — 9:16 PRODUCTION PROMPTS

> **Draft — under review.** Not approved copy. See `README.md` in this folder.
> Draft 3 from `AD-PROMPTS-60S-DRAFTS.md`, built out for WhatsApp Status.
> Characters are the Chassidic cast in `ad-characters/`.

---

## THE ENGINE, IN ONE PARAGRAPH

A man ignores a ringing phone. Shimon is there. He is always already there —
behind the plant, in the passenger seat, inside the elevator — and he never
explains it, never hurries, never smiles. He states one flat fact about the call
that was just missed and waits. Ari escalates; Shimon does not. **The joke is
the asymmetry**, and it dies the moment Shimon reacts.

Geico never explained the gecko. Do not explain Shimon.

### Four rules that hold the gag together

1. **Shimon never moves fast and never arrives.** He is discovered, not
   introduced. No door opens, no footsteps precede him.
2. **He never smiles and never raises his voice.** Same flat register in the
   parking garage as in the boardroom.
3. **He only ever says true, specific things.** "That was a customer." Not
   "Loopcom can help with that." The moment he sells, he becomes an ad.
4. **Ari carries all the emotion.** Startled, then annoyed, then resigned, then
   relieved. Shimon is the constant; Ari is the arc.

---

## WHY THIS IS THE ONE TO PICK IF THERE WILL BE MORE THAN ONE

The other four drafts are a single ad each. This is a **format**: any missed
call, anywhere, is another 30 seconds. Six more scenarios are listed at the
bottom of this file — they need no new script, only a new location. Shimon's
seed frame was generated with the rest of the cast for exactly this reason.

---

## STATUS SPLIT — TWO SEGMENTS, AND THE BREAK IS A GIFT

```
SEGMENT 1  (28s)  Shots 1–4   Pure escalation. Not one word of sell.
SEGMENT 2  (28s)  Shots 5–8   The pitch, the price, the release, the card.
```

**Segment 1 ends on the elevator** — doors open, Shimon is inside, alone,
centred, saying nothing. It is the only beat in the ad with no dialogue at all,
and it's the strongest image in the piece. A silent visual punchline is a far
better reason to tap through than an unfinished sentence.

Generate every clip at 8s, trim shots 1–4 to 7s. Segment 1 lands at 28s, under
the 30-second Status cap.

---

## SEEDING — THIS DRAFT NEEDS MORE WORK THAN DRAFT 2

Draft 2 lives in one room, so you chain last-frame-to-next-frame the whole way.
**This one moves through five environments**, and you cannot chain across a
location change — the model will melt one room into the next.

Build a seed frame per environment first, using **image-edit mode** so the faces
stay locked:

```
generate_image
  referenceImages: [
    { url: <02-shimon-spokesman-4k.png>, tag: "shimon" },
    { url: <05-ari-owner-4k.png>,        tag: "ari" }
  ]
  promptText: "@shimon and @ari <the new environment, 9:16, brand grade>"
```

That carries both faces into a car interior, an elevator lobby and a server
aisle without re-rolling the casting. Then chain within each location.

| Environment | Shots | Seed from |
|---|---|---|
| Ari's corner office | 1–2 | `05-ari-owner-4k.png` + `02-shimon-spokesman-4k.png` |
| Car, parking garage | 3 | new composite seed |
| Elevator lobby | 4 | new composite seed |
| Server aisle | 5–6 | new composite seed |
| Ari's office, resolved | 7 | last frame of shot 2, relit |

---

## CHARACTER DESCRIPTORS — USE VERBATIM

| Name | Descriptor (paste verbatim) |
|---|---|
| **SHIMON** | `a Chassidic Jewish man in his 40s, wide-brimmed black hat with a high crown, full untrimmed dark beard, sidecurls tucked behind his ears, round wire glasses, long black frock coat over an open-collar white shirt` |
| **ARI** | `a Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, black suit jacket over a crisp white dress shirt, tzitzis fringes visible at his waist` |
| **MENDY** | `a Chassidic Jewish man in his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, round wire-frame glasses, black over-ear headset with a boom microphone, white dress shirt under a black waistcoat` |

**Weekday dress throughout. No shtreimel.**

## GLOBAL STYLE LINE — APPEND TO EVERY PROMPT

```
Cinematic commercial photography, vertical 9:16 composition, anamorphic
character, shallow depth of field, crushed near-black shadows. Lit by cold
blue-cyan practical lights around 8000K, no warm tones and no wood or brown
surfaces anywhere in frame. Night. Performances natural, dry and understated —
deadpan, never mugging, no broad comedy faces. Photographed with dignity and
realism, never caricature, never costume. Faces kept clear of the extreme top
and bottom of frame. No on-screen text, no letters, no numbers, no logos, no
signage, no readable screen content.
```

## GLOBAL NEGATIVE PROMPT

```
text, letters, words, writing, captions, subtitles, watermark, logo, signage,
numbers, UI, readable screens, garbled text, gibberish characters, purple,
violet, magenta, lavender, pastel, pink, warm orange tint, wood panelling,
brown furniture, beige walls, domestic interior, shtreimel, fur hat, prayer
shawl, synagogue, caricature, exaggerated features, jump scare, horror
lighting, sitcom lighting, broad slapstick, wide grins, stock photo smiling,
bright white background, overexposed, low contrast, horizontal letterboxing,
black bars, distorted hands, extra fingers, morphing faces, changing clothing,
changing hat, jitter, flicker
```

---
---

# SEGMENT 1 — HE IS ALREADY THERE

## SHOT 1 of 8 — 8s, trim to 7 — the vertical dead space becomes the joke

```
Vertical 9:16 composition. In the lower half of frame, a Chassidic Jewish man in
his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled
sidecurls, black suit jacket over a crisp white dress shirt, tzitzis fringes
visible at his waist, sits at a dark desk in a modern corner office at night,
city far below through glass. His phone lights up and buzzes on the desk. He
silences it with his thumb without looking at it.

The upper half of frame is empty dark office. Slowly and silently, a Chassidic
Jewish man in his 40s, wide-brimmed black hat with a high crown, full untrimmed
dark beard, sidecurls tucked behind his ears, round wire glasses, long black
frock coat over an open-collar white shirt, rises into that empty upper space
from behind a low credenza in the mid-ground until he is standing full height.
The seated man has not noticed. Camera locked off, no movement at all.

Standing man, flat, from behind: "That was a customer."

Audio: his line, phone vibration, room tone, no music. No stinger, no horror
cue — the reveal is dry, not frightening.
```

## SHOT 2 of 8 — 8s, trim to 7 — stacked, and the height is the point

```
Vertical 9:16 composition, stacked in depth. Lower third: a Chassidic Jewish man
in his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled
sidecurls, black suit jacket over a crisp white dress shirt, has spun his chair
around and is looking up, startled, mouth slightly open. Filling the entire
upper two-thirds of frame, standing over him and shot from a low angle so he
reads very tall, a Chassidic Jewish man in his 40s, wide-brimmed black hat with
a high crown, full untrimmed dark beard, sidecurls tucked behind his ears, round
wire glasses, long black frock coat over an open-collar white shirt, calm,
unhurried, adjusting one cuff. He does not smile. Dark modern office at night,
cold blue-cyan practicals. Camera locked off.

Standing man, level: "They're calling your competitor. Right now."

Audio: dialogue, room tone, no music.
```

## SHOT 3 of 8 — 8s, trim to 7 — seed: new car composite

```
Vertical 9:16 composition, camera low in the rear passenger footwell of a parked
car, looking up and forward between the front seats at night. In the driver's
seat, lower in frame and nearer to camera, a Chassidic Jewish man in his mid-20s,
black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, black
suit jacket over a crisp white dress shirt, holds a buzzing phone, exhausted,
eyes closed for a second. Higher in frame beyond him in the passenger seat,
already seat-belted and facing forward through the windscreen, a Chassidic
Jewish man in his 40s, wide-brimmed black hat with a high crown, full untrimmed
dark beard, sidecurls tucked behind his ears, round wire glasses, long black
frock coat over an open-collar white shirt. Neither man looks at the other. Cold
cyan strip lighting of an underground garage outside the glass. Camera locked
off, no movement.

Passenger, still facing forward, flat: "Still ringing."

Audio: his line, phone buzz, low garage hum, no music.
```

## SHOT 4 of 8 — 8s, trim to 7 — **END OF SEGMENT 1. NO DIALOGUE.**

```
Vertical 9:16 composition, perfectly symmetrical, camera locked off and centred
on a pair of tall elevator doors in a dark lobby at night, lit by one cold cyan
practical. A Chassidic Jewish man in his mid-20s, black velvet yarmulke, full
untrimmed dark beard, long curled sidecurls, black suit jacket over a crisp
white dress shirt, stands in the lower foreground with his back to camera,
waiting.

The doors open. Inside the lift, alone, dead centre, facing out, hands folded in
front of him, stands a Chassidic Jewish man in his 40s, wide-brimmed black hat
with a high crown, full untrimmed dark beard, sidecurls tucked behind his ears,
round wire glasses, long black frock coat over an open-collar white shirt. He
does not move and does not speak.

The young man's shoulders drop. He steps in. The doors begin to close.

Audio: a single elevator chime, room tone, then silence. No dialogue whatsoever,
no music.
```

> Hold the last frame an extra beat in the edit. This is the strongest image in
> the ad and it is the reason anyone taps through to segment 2.

---
---

# SEGMENT 2 — THE ONLY THIRTY SECONDS THAT SELL

## SHOT 5 of 8 — 8s — seed: new server-aisle composite

```
Vertical 9:16 composition down a dark server room aisle at night, tall racks
towering on both sides to the top of frame, tiny cyan status LEDs, volumetric
haze. Walking briskly toward camera, a Chassidic Jewish man in his mid-20s,
black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, black
suit jacket over a crisp white dress shirt, frustrated, gesturing once. Keeping
pace beside him effortlessly and not remotely out of breath, a Chassidic Jewish
man in his 40s, wide-brimmed black hat with a high crown, full untrimmed dark
beard, sidecurls tucked behind his ears, round wire glasses, long black frock
coat over an open-collar white shirt. Camera tracks backward ahead of them at a
steady pace, holding both in frame.

Older man, level and unhurried: "Loopcom answers. Calls, texts, WhatsApp. All of it."

Audio: dialogue, footsteps, low server hum, no music.
```

## SHOT 6 of 8 — 8s

```
Vertical 9:16 composition in the same dark server aisle, both men stopped and
facing each other in profile, racks receding to the top of frame behind them.
Nearer camera and slightly lower, a Chassidic Jewish man in his mid-20s, black
velvet yarmulke, full untrimmed dark beard, long curled sidecurls, black suit
jacket over a crisp white dress shirt, finally out of argument. Facing him,
slightly higher in frame, a Chassidic Jewish man in his 40s, wide-brimmed black
hat with a high crown, full untrimmed dark beard, sidecurls tucked behind his
ears, round wire glasses, long black frock coat over an open-collar white shirt,
completely still. Cyan rack light between their faces. Camera locked off.

Young man, giving in: "Fine. How much?"
Older man, immediately, no pause at all: "Thirty dollars a month."

Audio: dialogue, server hum, no music.
```

## SHOT 7 of 8 — 8s — the release, and the proof

**This shot carries the sign-off.** "SOMEONE IS PAYING ATTENTION TO YOUR MISSED
CALLS" sits centred in the live area at 60–68px, so the frame has to be built
with a **dark empty band across the middle** for the type to land in. Ari goes
low, Mendy goes high, and the centre stays deliberately black. Compose for the
words or you will be shrinking them later to fit around a face.

```
Vertical 9:16 composition built in three horizontal bands, using deep receding
space up the frame.

LOWER BAND — nearest camera, occupying the bottom third: a Chassidic Jewish man
in his mid-20s, black velvet yarmulke, full untrimmed dark beard, long curled
sidecurls, black suit jacket over a crisp white dress shirt, sits at his desk in
a dark corner office and answers a ringing phone easily, unhurried, settling
back into the chair — the first time in the film he is not braced for something.
The chair beside him is empty. He is lit only by the cool glow of his own desk.

MIDDLE BAND — deliberately empty. A deep, unlit stretch of dark office floor and
wall between the two men. No furniture, no highlights, no detail. This negative
space is intentional and must stay clean and black.

UPPER BAND — far behind and above him, at a lit workstation in a dark operations
room, clearly readable but small in frame: a Chassidic Jewish man in his mid-20s,
black velvet yarmulke, full untrimmed dark beard, long curled sidecurls, round
wire-frame glasses, black over-ear headset with a boom microphone, white dress
shirt under a black waistcoat, is on a call — nodding, listening, working
steadily. Cyan monitor glow is the only light on him and it is the brightest
thing in the frame.

Very slow camera pull back, holding all three bands. No other movement.

Audio: room tone, a faint muffled one-sided phone conversation, no dialogue,
no music.
```

## SHOT 8 of 8 — 4s — **DO NOT GENERATE. COMPOSITE THIS.**

```
Static plate, 1080×1920. Near-black ground (#05080C–#0C1218). Soft cyan glow low
in frame. Centre of frame kept completely empty for the lockup.

The card plays in two states. Nothing moves in either — the change is a cut,
not an animation.

  0.0–1.2s   IT SHOULD BE US.        alone, centred, nothing else on screen

  1.2–4.0s   IT SHOULD BE US.        holds exactly where it was, no reflow
             LOOPCOM wordmark        centred, scaled by HEIGHT not width (4.53:1)
             $30/MONTH               below the mark
             WhatsApp +1 845 723 1213  below that, largest legible weight

The second sentence of the sign-off lands first and alone. The wordmark and the
number cut in underneath it on the music hit. Do not fade, do not slide, and do
not let "IT SHOULD BE US." move by a single pixel between the two states — it is
the anchor the rest of the card hangs off.

Then silence to 4.0s. No motion anywhere in the card.
```

> **The first half of the sign-off is on shot 7, not here.** See the captions
> table — "Someone is paying attention to your missed calls" runs over the
> footage of Mendy doing exactly that. The card only carries the turn.

---
---

# BURNED-IN CAPTIONS — THE SOUND-OFF VERSION

Composited, never generated. y≈1350–1550, IBM Plex Sans, all caps, 46–54px,
white on a 40%-opacity near-black slab with 45° chamfered corners.

**Segment 1**

| Clip | In | Caption |
|---|---|---|
| 1 | 3.8s | "THAT WAS A CUSTOMER" |
| 2 | 8.4s | "THEY'RE CALLING YOUR<br>COMPETITOR. RIGHT NOW." |
| 3 | 16.2s | "STILL RINGING" |
| 4 | — | *(none — the elevator plays silent)* |

**Segment 2**

| Clip | In | Caption |
|---|---|---|
| 5 | 1.4s | LOOPCOM ANSWERS<br>CALLS · TEXTS · WHATSAPP |
| 6 | 11.0s | $30 / MONTH |
| 7 | 17.5s | SOMEONE IS PAYING ATTENTION<br>TO YOUR MISSED CALLS |
| 8 | 24.0s | IT SHOULD BE US. *(then the lockup cuts in under it)* |

**The sign-off is split across the last two clips on purpose.** "Someone is
paying attention to your missed calls" runs over shot 7 — the footage of Mendy
on the headset, doing precisely that, while Ari takes a call in peace. The line
and the picture say the same thing, so the words are evidence rather than a
claim. Then the hard cut to black lands "It should be us." on its own.

Set it larger than the other captions — 60–68px, and it sits centred in the live
area rather than down at caption height, because on shot 7 it is the message,
not a subtitle.

**Shot 4 gets no caption on purpose.** A muted viewer watching the elevator doors
open on a motionless man in a black hat understands the joke completely without
a word. Captioning it would explain a visual gag, which kills it.

---

## PRODUCTION CHECKLIST

- [ ] Aspect ratio set to 9:16 **in the tool**, not just in the prompt
- [ ] Composite seed frames built for car, elevator and server aisle **before**
      any video generation — do not chain across a location change
- [ ] Shimon's hat, coat, glasses and beard identical in all five environments
- [ ] Shimon never smiles, never hurries, never reacts — check every clip
- [ ] Shots 1–4 trimmed 8s → 7s so segment 1 lands at 28s
- [ ] Shot 4 holds an extra beat on the last frame
- [ ] No generated text anywhere — check every frame, not just the first
- [ ] Watched once with the sound off, start to finish, before it goes anywhere

---

## THE CAMPAIGN — SIX MORE, NO NEW SCRIPT

Each is one location and one line. Same two men, same rules, same tag card.

| Where Shimon is | His line |
|---|---|
| In the back of the delivery van, holding the clipboard | "Two missed calls since you loaded it." |
| At the far end of the shabbos table, seat nobody set | *(says nothing — just looks at the phone)* |
| Behind the counter of Ari's own shop, apron on | "I took a message. You should hire me." |
| In the passenger seat of a forklift in the warehouse | "Someone wanted a quote." |
| Sitting in the waiting-room chair at Ari's accountant | "He called you first. Then he called them." |
| Already in the driver's seat when Ari opens the door | "You're late. So was the callback." |

The apron one is the strongest — Shimon crossing from observer to *doing the job
Ari isn't doing* is the natural escalation, and it's the only one where he
almost breaks. Save it for the third or fourth in the run, not the second.

---

## SET TWO — FIVE BUILT SCENARIOS

Set one above is a list of places. **These five are built**, and each one is
picked for a *different reveal mechanism* — that's the thing that keeps a running
gag alive. Same location twice is forgivable; same mechanism twice and the
audience has your number by the third spot.

**Format for all five: a single 30-second Status segment. Not 60.** The flagship
two-segment cut earns its length because Ari has an arc. These don't — they're
one gag, one line, tag card. Four shots each, roughly 7s / 7s / 8s / 4s. A
running gag gets less funny the longer you hold it open.

---

### 1 · THE CAR WASH
**Mechanism: the environment performs the reveal.** Nobody appears — the frame
is simply uncovered.

Ari pulls into an automatic wash, alone, and lets his head fall back against the
headrest. Foam swallows the windscreen. The brushes pass. The rinse arch clears
the glass left to right — and in the passenger seat, dry, belted in, facing
forward, is Shimon.

> **"Three calls. You were in here four minutes."**

**Why it works:** the reveal costs nothing and can't glitch. No door, no walk-on,
no morph — the car wash does the edit for you, and image-to-video models handle
"foam clears to reveal" far better than they handle a person entering frame.

**Vertical staging:** camera on the dashboard looking back at both men, or from
the rear footwell as in shot 3 of the flagship. The windscreen is a natural 9:16
letterbox if you shoot through it from outside.

**Run position:** opener. It's the cleanest and the most purely visual.

---

### 2 · THE DENTIST
**Mechanism: Ari physically cannot answer back.** The one spot where the power
is entirely Shimon's.

Ari is reclined in the chair, bib on, mouth propped open, mid-procedure. The
overhead lamp swings away from his face. Leaning into frame from directly above,
upside down to camera, wearing the hat, no mask: Shimon.

> **"Rinse. They called twice."**

**Why it works:** every other spot lets Ari splutter something. Here he can only
make a noise. And "Rinse." delivered in the identical register as the sales fact
is the funniest thing in either set — Shimon treating a dental instruction and a
missed call as equally routine business.

**Vertical staging:** made for 9:16. Ari's face fills the lower frame, Shimon
enters from the top edge inverted. The frame is already vertical because he's
lying down.

**Run position:** second or third. It's the first real escalation.

---

### 3 · BEDIKAS CHOMETZ
**Mechanism: a search that finds the wrong thing.**

A dark house, all the lights off. Ari moves along a hallway with a candle and a
feather, checking, bending to a low cupboard. He opens the last closet door and
raises the candle. Standing inside it, upright, unbothered, holding a phone that
is ringing: Shimon.

> **"Not chometz. A customer."**

**Why it works:** it's the only one an outsider wouldn't get, which is exactly
why this market would love it. The line does double duty — it's a joke about the
search and a statement about the product in four words.

**Vertical staging:** the best-lit spot of the five. One candle, one face, deep
black everywhere else — it is already the brand's lighting scheme, achieved
practically.

> ⚠️ **Check this one with someone before you shoot it.** I think the mitzvah
> itself isn't the butt of the joke — the joke is finding a *man* in the closet,
> and bedikas chometz is already playful. But I'm not the right judge of whether
> it reads as affectionate or as taking a liberty, and you are. If there's any
> hesitation, the sukkah version is the safe swap: Ari steps into his sukkah and
> Shimon is already sitting there with a slice of cake. Same warmth, no risk.

**Run position:** seasonal. Run it in the weeks before Pesach or not at all.

---

### 4 · THE CHEDER REPORT
**Mechanism: authority inversion.** The only spot where Shimon outranks Ari.

A classroom after hours. Ari is folded onto a child-sized chair, knees up,
across a low desk. On the other side, in the rebbe's seat with a folder open in
front of him, sits Shimon. He turns a page and reads from it in exactly the same
tone throughout.

> **"He's doing well in Chumash. You missed four calls."**

**Why it works:** the flatness is the whole joke — two completely unrelated facts
delivered with identical weight, from a man who has no business having either.
And a grown man on a child's chair does half the comic work before anyone speaks.

**Vertical staging:** low camera at desk height looking up slightly at Shimon,
with Ari's cramped knees in the bottom of frame. The height difference is the
gag, and vertical exaggerates it.

**Run position:** fourth. It's the most absurd of the four before the ending.

---

### 5 · THE FIRST RING
**Mechanism: the reveal that retires the format.** Run this last. Once.

Ari, alone at his desk at night, out of fight. He looks at his phone for a long
moment, then dials. It rings exactly once.

Cut to Shimon — at a workstation, headset on over the hat, cyan monitor glow, a
completely ordinary man doing a completely ordinary job.

> **"Loopcom. This is Shimon."**

And then, for the first and only time in the entire campaign, **he smiles.**

**Why it works:** it re-reads every spot that came before it. He was never a
ghost, never a haunting, never a bit — he is a man who answers the phone
extremely quickly, and he has been trying to tell Ari that for six commercials.
The joke resolves into the actual product claim without ever stating it.

**This is the one place the no-smiling rule is broken, and it only works because
it was never broken before.** Do not let him smile in any earlier spot, and do
not run this one until you've run at least four others. Spent early, it's just
an ending. Spent last, it's the whole campaign clicking shut.

**Vertical staging:** two locked-off singles, cut hard between them. No camera
movement anywhere in the spot.

**Run position:** the closer. There is no spot after this one.

---

### Three more, if you need depth on the bench (superseded — see SET THREE)

| Where | Line | Mechanism |
|---|---|---|
| In the toll booth as Ari pulls up | "Exact change. And call him back." | He occupies a *job* |
| Holding the camera at a chasunah, lowers it | "Three during the chuppah." | Hidden in plain sight |
| Sitting in Ari's own parked car in his driveway, headlights on | *(no line — just holds up Ari's ringing phone)* | Silent, and he has the phone |

---
---

## SET THREE — ONE SPOT, ONE SERVICE

**Sets one and two sold a single benefit ten different ways.** Every scenario was
a variation on *you missed a call*, while the CRM — roughly a third of the
product — never appeared once, and neither did the IVR, the reports, the shared
inbox, provisioning or billing. A running gag repeats; that repetition is only
worth having if each episode carries a different payload.

**The rule from here: one spot sells exactly one service.** A spot that sells two
things sells nothing. Shimon still turns up where he cannot be, still says one
flat true sentence — but what he *knows* changes every time, and what he knows
is the product.

Every line below is checked against `SERVICES-INVENTORY.md`. The **Part** column
says whether the service is shipped or still being switched on.

### The matrix

| # | Scenario | Reveal mechanism | Service it sells | Part | Shimon's line |
|---|---|---|---|---|---|
| 1 | **The car wash** — foam clears, he's in the passenger seat | Environment reveals | Missed-call records + push notification | 1 | "Three calls. You were in here four minutes." |
| 2 | **The dentist** — leans in upside down over the chair | Ari physically can't reply | IVR / auto-attendant | 1 | "Rinse. Your menu already took it." |
| 3 | **Erev Yom Tov** — Ari pulls the shutter down, Shimon is inside the dark shop | A locked space | After-hours & holiday routing | 1 | "You're closed. The phone isn't." |
| 4 | **Bedikas chometz** — candle finds him in the closet | A search that finds the wrong thing | CRM customer timeline | 1 | "Not chometz. Every call he ever made you." |
| 5 | **The cheder report** — rebbe's seat, folder open | Authority inversion | Call reports & dashboards | 1 | "Good in Chumash. Forty calls, eleven to voicemail." |
| 6 | **The barber's mirror** — Ari sees him in the reflection | Mirror reveal | Live-call cockpit — caller enrichment & screen-pop | 1 | "Next one's Berkowitz. He ordered in March." |
| 7 | **The new hire** — Shimon hands the kid a working phone on day one | He's doing Ari's job | Extension provisioning, QR pairing | 1 | "Scan it. He's on the phones." |
| 8 | **The chasunah** — beside Ari at the simcha, not dancing, holding a phone | Hidden in a crowd | Shared SMS inbox | 1 | "Sruly already answered. Same inbox." |
| 9 | **The 2am stocktake** — on the ladder above him in the warehouse | He is above | Bulk SMS with approval gate | 1 | "Four hundred texts are ready. They need your yes." |
| 10 | **The lead list** — Ari squints at a printout, Shimon already knows | He has the answer first | AI lead intelligence | 1 | "Third one down. Sixty percent. Don't call him." |
| 11 | **The shoebox** — Ari at the accountant with a box of paper receipts | Paper versus system | Invoicing & payments | 1 | "Or they could send themselves." |
| 12 | **The fourth take** — Ari re-recording a greeting badly, again | He's been listening the whole time | Voicemail greetings, recorded by phone | 1 | "Call in and record it. Ninety seconds." |

### The five that earn their place first

**3 · Erev Yom Tov** is the best spot in any of the three sets. The service —
holiday and after-hours routing — is genuinely shipped, genuinely useful, and
lands on a moment every single person in this market lives through several times
a year. "You're closed. The phone isn't." is the whole product in six words.
Shoot this one.

**5 · The cheder report** now has the mechanism and the service as the *same
object* — the folder he's reading from is the call report. That alignment is what
was missing before.

**7 · The new hire** is the only spot where Shimon does something helpful rather
than ominous, which makes it the right one to run mid-campaign as a tonal
breather.

**11 · The shoebox** is blocked on a scope decision, not a code one. Billing was
deliberately removed from all marketing, but the inventory calls it *"one of the
most mature parts of the platform"* and flags the removal as worth revisiting.
Your call — the spot is ready if the scope opens.

**12 · The fourth take** sells uploading or phoning in a greeting. It must
**never** be framed as choosing a voice. There is no text-to-speech anywhere in
the product.

### Guardrails — no spot in this campaign may claim these

Straight from Part 3 of the inventory. These are not judgement calls:

| Do not say | Why | Say instead |
|---|---|---|
| "We handle your WhatsApp" | Outbound is simulated in every configuration; no API client exists | Nothing yet. Using WhatsApp as *our* contact number is fine |
| "Yiddish voicemail transcription" | Lives in `apps/agent`, 2 of ~45 files, cannot compile | Nothing, until it builds |
| "An assistant that does everything" | No auto-reply, no tool-calling anywhere in the repo | Lead intelligence, AI email writing, call transcription |
| "Multiple voices for your recordings" | No TTS in the product at all | Upload your own, or record by phone |

> ⚠️ **Shot 5 of the flagship currently says "Loopcom answers. Calls, texts,
> WhatsApp. All of it."** That third word is on the do-not-say list. Change it to
> **"Loopcom answers. Calls, texts, voicemail. All of it."** before shooting —
> same rhythm, same three-item list, and all three are true.

---

## STILL OPEN

- **Shimon has no name on screen and shouldn't get one.** If someone asks who he
  is, the answer is that he's the man who knows about your missed calls. Naming
  him in a caption turns a running gag into a mascot with a backstory.
- **This draft never says the word Yiddish.** That's deliberate — it's the
  format ad, built to run repeatedly to a broad B2B audience. The Yiddish
  transcription line belongs in Draft 2, which is the one aimed squarely at the
  Yiddish-speaking market. Keep them as separate campaigns rather than merging.
