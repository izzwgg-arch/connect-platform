# LOOPCOM — 60-SECOND AD, GEICO FORMAT — 5 DRAFTS

> **Draft — under review.** Not approved copy. See `README.md` in this folder.
> Five competing concepts. Pick one, then we build only that one out properly.

---

## TWO THINGS TO DECIDE BEFORE READING

**1. This is a deliberate break from the brand voice.** The locked Loopcom voice
is "nocturnal, engineered, precise, calm — no jokes." Geico is the opposite:
deadpan comedy, a running gag, a punchline. The two can coexist only one way —
**the comedy carries the middle, the brand carries the last five seconds.**
Every draft below ends on the same still, silent, on-brand tag card. If you
don't want the tonal break, say so now and we go back to the 30-second cut in
`AD-PROMPTS.md`.

**2. Two of the punchlines are not deployed yet.** Yiddish transcription and the
do-everything assistant live in `apps/agent`, which does not currently build.
Drafts 1, 2 and 4 put Yiddish transcription in the funniest position in the ad —
the payoff. That's the strongest comedic choice and the largest exposure. Noted,
not re-litigated; it's your call as before.

---

## HOW TO GENERATE THIS (read once, applies to all five)

**Use image-to-video, seeded from your five photographs.** Feed the actual
headshot as the start frame for that character's first shot, then feed the last
frame of each clip as the start frame of the next. Text-to-video will give you
five different men across eight shots.

**Dialogue budget: 14 words per 8-second clip. Hard ceiling 18.** Video models
speak at roughly 2.5 words a second and need room for the beat before and after
the line. A 20-word line comes back rushed or clipped mid-word.

**One shot per clip. No cuts inside a prompt.** If a prompt describes two camera
positions the model will crossfade between them and it looks like a smear.

**Never let the model render text.** No wordmark, no phone number, no screen
content, no signage. The tag card is composited afterward from the brochure
templates. This rule has not changed and it is the one that ruins finished work.

**Structure:** 8 clips × 8s = 64s. Trim 4 seconds across the middle in the edit,
or generate clip 8 as a 4-second static plate. Don't try to make the model hit
60 exactly.

---

## CHARACTER SHEET — USE THESE DESCRIPTIONS VERBATIM

Copy the descriptor exactly, every time, in every shot. Changing one adjective
between clips is what makes a character's face drift.

| Name | Descriptor (paste verbatim) | Plays |
|---|---|---|
| **MENDY** | `a man in his mid-20s, black velvet yarmulke, dark beard, round wire-frame glasses, black over-ear headset with a boom microphone, white dress shirt under a black waistcoat` | The one who answers |
| **SHIMON** | `a man in his 40s, wide-brimmed black fedora, full dark beard, round wire glasses, navy two-piece suit over an open-collar white shirt` | The spokesman. Deadpan, never smiles |
| **REB YIDEL** | `a man in his 60s, wide-brimmed black fedora, full white beard, black suit over an open-collar white shirt` | The veteran owner. Warm, unhurried |
| **YOSSI** | `a man in his late 20s, small black yarmulke, short beard, round wire glasses, navy blazer over a navy crewneck sweater, holding a closed silver laptop` | Operations. Dry |
| **ARI** | `a man in his mid-20s, small black yarmulke, short trimmed beard, crisp white dress shirt, dark trousers` | The young owner. The one it happens to |

---

## GLOBAL STYLE LINE — APPEND TO EVERY PROMPT

```
Cinematic commercial photography, anamorphic lens, shallow depth of field,
crushed near-black shadows. Lit by cold cyan practical lights around 8000K
with no warm tones. Dark modern office interior at night. Natural performance,
dry and understated, never mugging for camera. No on-screen text, no letters,
no numbers, no logos, no signage, no readable screen content.
```

## GLOBAL NEGATIVE PROMPT — PASTE INTO EVERY GENERATION

```
text, letters, words, writing, captions, subtitles, watermark, logo, signage,
numbers, UI, readable screens, garbled text, gibberish characters, purple,
violet, magenta, lavender, pastel, pink, warm orange tint, sitcom lighting,
laugh track, broad slapstick, exaggerated facial expressions, stock photo
smiling, bright white background, overexposed, low contrast, distorted hands,
extra fingers, morphing faces, changing clothing, jitter, flicker
```

---
---

# DRAFT 1 — "IT'S WHAT YOU DO"

**Format:** Geico's most durable structure — a narrated chain of small
inevitabilities, each one true, ending on the one thing that isn't inevitable.

**Why this one:** it is the only draft with almost no lip-sync. Seven of eight
clips are a voiceover over people doing things, which is the single biggest
quality lever in AI video right now. It is also the most on-brand: the comedy is
in the writing, not in the performance, so the footage stays calm and dark.

**Cast:** Ari, Yossi, Reb Yidel, Mendy, Shimon (one line each at most).

**Voiceover — 96 words, one dry male read, unhurried:**

> If you run a business, your phone rings.
> And if your phone rings while you're already on the phone, it goes to voicemail.
> It's what it does.
> If it goes to voicemail, nobody checks it.
> It's what nobody does.
> And if nobody checks it, that customer calls somebody else.
> It's what they do.
> If you're Loopcom, you answer. Every call. Every text. Every WhatsApp.
> You write the voicemail out. In English. In Yiddish.
> It's what we do.

### Shot prompts

```
[8s | 1 of 8] A man in his mid-20s, small black yarmulke, short trimmed beard,
crisp white dress shirt, dark trousers, stands behind a dark desk in a corner
office at night, city lights far below through floor-to-ceiling glass. He is
talking on one phone held to his ear. A second phone on the desk beside him
lights up and vibrates. He glances at it and does not pick it up. Slow push in.
Audio: room tone, faint phone vibration, no music, no dialogue.
```

```
[8s | 2 of 8] Macro close-up of a smartphone face-up on a dark desk in an empty
office lit only by cold cyan light from one side. The screen edge glows, pulses,
and goes dark, unanswered. Dust drifts through the light. No people in frame.
Extremely shallow depth of field, slow subtle handheld drift.
Audio: distant office hum, a single vibration decaying to silence, no music.
```

```
[8s | 3 of 8] A man in his late 20s, small black yarmulke, short beard, round
wire glasses, navy blazer over a navy crewneck sweater, holding a closed silver
laptop, walks past a dark desk where a desk phone's message light blinks. He
does not turn his head. He keeps walking out of frame. Static wide shot, the
blinking light stays in frame after he leaves.
Audio: footsteps on hard floor, room tone, no music, no dialogue.
```

```
[8s | 4 of 8] A man in his 60s, wide-brimmed black fedora, full white beard,
black suit over an open-collar white shirt, stands alone at a dark window in an
executive office at night, hands in pockets, looking out at the city. He is
completely still. Slow lateral camera drift left to right behind him.
Audio: low room tone, the faintest street sound through glass, no music.
```

```
[8s | 5 of 8] A man in his mid-20s, black velvet yarmulke, dark beard, round
wire-frame glasses, black over-ear headset with a boom microphone, white dress
shirt under a black waistcoat, sits at a workstation in a dark operations room
lit by cyan monitor glow. He answers a call — a small nod, a half smile, already
listening. Calm and competent, not performing. Slow push in from a wide two-
monitor frame to a medium.
Audio: a single soft call-connect tone, room tone, no music, no dialogue.
```

```
[8s | 6 of 8] The same man in his mid-20s, black velvet yarmulke, dark beard,
round wire-frame glasses, black over-ear headset with a boom microphone, white
dress shirt under a black waistcoat, listening intently, head slightly tilted,
one hand resting on the desk. He nods once, slowly. Tight close-up, cyan rim
light on the side of his face, the rest of the frame near black.
Audio: room tone only. Silence. No music, no dialogue.
```

```
[8s | 7 of 8] A man in his 40s, wide-brimmed black fedora, full dark beard,
round wire glasses, navy two-piece suit over an open-collar white shirt, stands
alone in a dark empty office, facing camera directly, hands at his sides,
completely still. He does not smile. He looks straight down the lens for a long
beat, then says one short line and stops.
Dialogue, dry and flat: "It's what we do."
Audio: his line, room tone, no music.
```

```
[4s | 8 of 8 — DO NOT GENERATE. COMPOSITE THIS.]
Static plate: near-black frame, soft cyan glow low in the corner, empty centre.
Lay in the wordmark, $30/MONTH, and WhatsApp +1 845 723 1213.
No motion. One music hit as the logo lands, then silence.
```

**Risk note:** the Yiddish line lives only in the voiceover here, so if that
claim gets pulled the shot list survives — you re-record eight words. Every
other draft would need a reshoot.

---
---

# DRAFT 2 — "NOBODY KNOWS THAT"

**Format:** Geico's "Everybody knows that" two-hander, inverted. Four questions
get the same bored answer. The fifth one doesn't.

**Why this one:** it's the funniest, and the inversion does real strategic work —
the joke *is* the differentiator. The structure also front-loads the price into
a laugh line, which is the hardest thing to do in an ad. Highest ceiling,
highest generation difficulty: six of eight clips are lip-synced dialogue.

**Cast:** Ari (asks), Yossi (bored), Mendy (background), Reb Yidel (button).

### Shot prompts

```
[8s | 1 of 8] Two men in a dark modern office at night. Seated at the desk: a
man in his mid-20s, small black yarmulke, short trimmed beard, crisp white dress
shirt, dark trousers. Leaning in the doorway: a man in his late 20s, small black
yarmulke, short beard, round wire glasses, navy blazer over a navy crewneck
sweater, holding a closed silver laptop. Medium two-shot, cyan practicals.
Seated man: "Did you know a missed call is just a customer calling someone else?"
Doorway man, flat and bored: "Everybody knows that."
Audio: dialogue, room tone, no music.
```

```
[8s | 2 of 8] Same dark office, same medium two-shot. Seated: a man in his
mid-20s, small black yarmulke, short trimmed beard, crisp white dress shirt,
dark trousers. In the doorway: a man in his late 20s, small black yarmulke,
short beard, round wire glasses, navy blazer over a navy crewneck sweater,
holding a closed silver laptop. Neither has moved.
Seated man: "Did you know Loopcom answers your calls, texts and WhatsApp?"
Doorway man, unmoved: "Everybody knows that."
Audio: dialogue, room tone, no music.
```

```
[8s | 3 of 8] Same dark office, same medium two-shot, same two men — seated: a
man in his mid-20s, small black yarmulke, short trimmed beard, crisp white dress
shirt, dark trousers; doorway: a man in his late 20s, small black yarmulke,
short beard, round wire glasses, navy blazer over a navy crewneck sweater,
holding a closed silver laptop.
Seated man: "Did you know it's only thirty dollars a month?"
Doorway man hesitates a half-second, then: "...Everybody knows that."
Audio: dialogue, room tone, no music.
```

```
[8s | 4 of 8] Same dark office. Push in slightly tighter on both men. Seated: a
man in his mid-20s, small black yarmulke, short trimmed beard, crisp white dress
shirt, dark trousers, leaning forward now. Doorway: a man in his late 20s, small
black yarmulke, short beard, round wire glasses, navy blazer over a navy
crewneck sweater, holding a closed silver laptop.
Seated man: "Did you know it writes out your voicemail? In Yiddish?"
The other man says nothing. He straightens up off the doorframe.
Audio: dialogue, then two full seconds of room tone. No music.
```

```
[8s | 5 of 8] Tight close-up on a man in his late 20s, small black yarmulke,
short beard, round wire glasses, navy blazer over a navy crewneck sweater,
holding a closed silver laptop, in a dark office lit by cyan practicals. He
looks directly at the man off-camera, genuinely thrown for the first time.
Dialogue, quiet and flat: "No. Nobody knows that."
Audio: his line, room tone, no music.
```

```
[8s | 6 of 8] Wide shot of the same dark office, both men small in frame at the
right. Deep in the background at a lit workstation sits a man in his mid-20s,
black velvet yarmulke, dark beard, round wire-frame glasses, black over-ear
headset with a boom microphone, white dress shirt under a black waistcoat, on a
call, working steadily, nodding, completely unaware of the two of them. Rack
focus from the two men in front to the man on the headset behind.
Audio: room tone, faint muffled one-sided phone conversation, no music.
```

```
[8s | 7 of 8] The same dark office doorway. A man in his 60s, wide-brimmed black
fedora, full white beard, black suit over an open-collar white shirt, walks past
the open doorway in the background without stopping and without turning his
head. He is already leaving frame as he speaks.
Dialogue, warm, thrown over his shoulder: "I knew that."
Audio: his line, unhurried footsteps, room tone, no music.
```

```
[4s | 8 of 8 — DO NOT GENERATE. COMPOSITE THIS.]
Static plate: near-black frame, soft cyan glow low in the corner, empty centre.
Wordmark, $30/MONTH, WhatsApp +1 845 723 1213. No motion.
One music hit, then silence.
```

**Note:** shots 1–4 are the same locked frame. Generate shot 1, then use its
final frame as the start frame for 2, 3 and 4. If the framing drifts between
them the repetition gag stops working — the joke depends on nothing changing.

---
---

# DRAFT 3 — "THE SPOKESMAN"

**Format:** Geico's spokesman-appears-where-he-shouldn't. Shimon materialises
wherever a call goes unanswered. Escalating, never explained.

**Why this one:** it's the most memorable and the most repeatable — it's a
campaign, not an ad. If it works you can shoot six more of these forever.
Middle risk: four clips of lip-sync, but all of them are single-speaker.

**Cast:** Ari (victim), Shimon (spokesman), Mendy (payoff).

### Shot prompts

```
[8s | 1 of 8] A man in his mid-20s, small black yarmulke, short trimmed beard,
crisp white dress shirt, dark trousers, sits at a dark desk in a corner office
at night. His phone lights up and buzzes. He silences it with his thumb without
looking. Behind him, slowly and silently, a man in his 40s, wide-brimmed black
fedora, full dark beard, round wire glasses, navy two-piece suit over an
open-collar white shirt, rises into frame from behind a large potted plant.
The seated man has not noticed. Static medium wide.
Dialogue, from behind, flat: "That was a customer."
Audio: his line, phone buzz, room tone, no music.
```

```
[8s | 2 of 8] Same dark corner office. A man in his mid-20s, small black
yarmulke, short trimmed beard, crisp white dress shirt, dark trousers, spins in
his chair, startled. Standing over him now, calm, adjusting one suit cuff: a man
in his 40s, wide-brimmed black fedora, full dark beard, round wire glasses, navy
two-piece suit over an open-collar white shirt. He does not smile.
Dialogue, spokesman: "They're calling your competitor. Right now."
Audio: dialogue, room tone, no music.
```

```
[8s | 3 of 8] Interior of a parked car in a dark underground garage at night,
cyan strip lights on the concrete outside. In the driver's seat, a man in his
mid-20s, small black yarmulke, short trimmed beard, crisp white dress shirt,
dark trousers, holding a buzzing phone, exhausted. In the passenger seat,
already seat-belted, facing forward: a man in his 40s, wide-brimmed black
fedora, full dark beard, round wire glasses, navy two-piece suit over an
open-collar white shirt. Neither looks at the other.
Dialogue, spokesman, still facing forward: "Still ringing."
Audio: his line, phone buzz, garage hum, no music.
```

```
[8s | 4 of 8] A dark elevator lobby at night lit by a single cyan practical. A
man in his mid-20s, small black yarmulke, short trimmed beard, crisp white dress
shirt, dark trousers, waits, presses the button. The doors open. Inside, alone,
centred, hands folded: a man in his 40s, wide-brimmed black fedora, full dark
beard, round wire glasses, navy two-piece suit over an open-collar white shirt.
The young man closes his eyes briefly, then steps in. Doors close.
Audio: elevator chime, room tone, no dialogue, no music.
```

```
[8s | 5 of 8] Dark server room aisle at night, racks on both sides, tiny cyan
status LEDs, volumetric haze. A man in his mid-20s, small black yarmulke, short
trimmed beard, crisp white dress shirt, dark trousers, walks fast toward camera,
frustrated. Beside him, keeping pace effortlessly and not remotely out of
breath, a man in his 40s, wide-brimmed black fedora, full dark beard, round wire
glasses, navy two-piece suit over an open-collar white shirt. Tracking shot
pulling back ahead of them.
Dialogue, spokesman, level: "Loopcom answers. Calls, texts, WhatsApp. All of it."
Audio: dialogue, footsteps, server hum, no music.
```

```
[8s | 6 of 8] Same dark server aisle. Both men have stopped walking, facing each
other. A man in his mid-20s, small black yarmulke, short trimmed beard, crisp
white dress shirt, dark trousers, and a man in his 40s, wide-brimmed black
fedora, full dark beard, round wire glasses, navy two-piece suit over an
open-collar white shirt. Medium two-shot, cyan rack light between them.
Young man, giving in: "Fine. How much?"
Spokesman, immediately: "Thirty dollars a month."
Audio: dialogue, server hum, no music.
```

```
[8s | 7 of 8] A dark corner office at night. A man in his mid-20s, small black
yarmulke, short trimmed beard, crisp white dress shirt, dark trousers, answers a
ringing phone easily and relaxes into his chair, relieved. Camera pulls back
wide — the chair beside him is empty. Deep in the background at a lit
workstation, a man in his mid-20s, black velvet yarmulke, dark beard, round
wire-frame glasses, black over-ear headset with a boom microphone, white dress
shirt under a black waistcoat, is on a call, nodding, working.
Audio: room tone, faint one-sided phone conversation, no dialogue, no music.
```

```
[4s | 8 of 8 — DO NOT GENERATE. COMPOSITE THIS.]
Static plate: near-black, soft cyan glow low corner, empty centre.
Wordmark, $30/MONTH, WhatsApp +1 845 723 1213. No motion.
One music hit, then silence.
```

---
---

# DRAFT 4 — "THE TESTIMONIAL THAT WON'T STOP"

**Format:** Geico's real-people testimonial, where the subject is having a much
better time than the crew. Four talking heads; the fourth one will not wrap.

**Why this one:** it's the warmest of the five and the only one where the
customer, not the brand, is funny. It also makes Reb Yidel the star, which the
photography supports better than any other draft — he's the one with the smile.
Generation risk: it is eight clips of seated direct-address dialogue, which
models do well, but it lives or dies on timing you can't fully control.

**Cast:** Ari, Yossi, Mendy, Reb Yidel (lead), Shimon (button).

### Shot prompts

```
[8s | 1 of 8] Documentary-style testimonial setup. A man in his mid-20s, small
black yarmulke, short trimmed beard, crisp white dress shirt, dark trousers,
seated on a stool in a dark office, lit by a single soft key and a cyan rim
light, plain dark background. He speaks directly to camera, natural and
slightly self-conscious.
Dialogue: "We were missing calls. A lot of calls. I don't want to say how many."
Audio: dialogue, room tone, no music.
```

```
[8s | 2 of 8] Same documentary testimonial setup, same dark background, same
lighting. Seated on the stool: a man in his late 20s, small black yarmulke,
short beard, round wire glasses, navy blazer over a navy crewneck sweater, the
closed silver laptop resting on his knee. Dry, deadpan, direct to camera.
Dialogue: "I counted them for a week. Then I stopped counting them."
Audio: dialogue, room tone, no music.
```

```
[8s | 3 of 8] A man in his mid-20s, black velvet yarmulke, dark beard, round
wire-frame glasses, black over-ear headset with a boom microphone, white dress
shirt under a black waistcoat, at his workstation in a dark operations room lit
by cyan monitor glow — not on a stool, still working. He glances over at the
camera mid-shift, mildly amused.
Dialogue: "Now one person answers everything. It's me. Hello."
Audio: dialogue, room tone, faint keyboard, no music.
```

```
[8s | 4 of 8] Same documentary testimonial setup, single soft key and cyan rim
light, plain dark background. Seated, hands folded, entirely at ease: a man in
his 60s, wide-brimmed black fedora, full white beard, black suit over an
open-collar white shirt. Warm, unhurried, a slight smile. Direct to camera.
Dialogue: "In forty years of business I have had six phone companies."
Audio: dialogue, room tone, no music.
```

```
[8s | 5 of 8] Same setup, same man in his 60s, wide-brimmed black fedora, full
white beard, black suit over an open-collar white shirt, seated, hands folded.
Slight push in. He takes his time. The smile widens fractionally.
Dialogue: "This is the first one that ever called me back." Pause. "On a Sunday."
Audio: dialogue, a long beat of room tone, no music.
```

```
[8s | 6 of 8] Same setup, same man in his 60s, wide-brimmed black fedora, full
white beard, black suit over an open-collar white shirt. An off-camera voice
tries to end the interview. He continues anyway, entirely comfortable, gesturing
gently with one hand.
Off-camera voice: "That's great, thank you so much—"
Seated man, continuing: "Also my voicemail. In Yiddish. It writes it out."
Audio: dialogue, room tone, no music.
```

```
[8s | 7 of 8] Wider shot of the same dark room, revealing the film crew's light
stands. A man in his 60s, wide-brimmed black fedora, full white beard, black
suit over an open-collar white shirt, is still seated and still talking, silent
to us now, entirely unbothered, as a light is collapsed behind him. A man in his
40s, wide-brimmed black fedora, full dark beard, round wire glasses, navy
two-piece suit over an open-collar white shirt, steps into the foreground,
faces camera, and delivers one flat line while the older man carries on.
Dialogue, spokesman, deadpan: "Thirty dollars a month."
Audio: his line, muffled continuing chatter behind, room tone, no music.
```

```
[4s | 8 of 8 — DO NOT GENERATE. COMPOSITE THIS.]
Static plate: near-black, soft cyan glow low corner, empty centre.
Wordmark, $30/MONTH, WhatsApp +1 845 723 1213. No motion.
One music hit, then silence.
```

---
---

# DRAFT 5 — "THE MESSAGE GUY"

**Format:** the Geico absurd-literalisation sketch — the old way, made physical
and put in the corner of the room, played completely straight.

**Why this one:** it's the only draft that shows the problem instead of stating
it, and it's the only one that needs no unshipped claim to land. It is also the
only one with a visible before/after, which is the most persuasive structure in
B2B. Cost: it needs a prop-heavy set the model has to invent — paper slips, a
second desk — and paper is where video models start hallucinating text.

**Cast:** Mendy (the message guy, then the operator), Ari, Yossi, Reb Yidel,
Shimon.

### Shot prompts

```
[8s | 1 of 8] Wide establishing shot of a dark modern office at night, cyan
practicals, empty and expensive. In the far corner, absurdly out of place, sits
a small wooden desk with a single lamp. At it, a man in his mid-20s, black
velvet yarmulke, dark beard, round wire-frame glasses, black over-ear headset
with a boom microphone, white dress shirt under a black waistcoat, is writing on
a paper notepad by hand, fast. Slow push in toward the corner.
Audio: room tone, scratching pen, distant ringing phones, no dialogue, no music.
```

```
[8s | 2 of 8] Medium two-shot in the same dark office. A man in his mid-20s,
small black yarmulke, short trimmed beard, crisp white dress shirt, dark
trousers, stares off toward the corner. Beside him, a man in his late 20s, small
black yarmulke, short beard, round wire glasses, navy blazer over a navy
crewneck sweater, holding a closed silver laptop, does not look up.
Young owner: "Who is that?"
The other man, flatly: "That's how we take messages."
Audio: dialogue, distant ringing, room tone, no music.
```

```
[8s | 3 of 8] The corner desk. A man in his mid-20s, black velvet yarmulke, dark
beard, round wire-frame glasses, black over-ear headset with a boom microphone,
white dress shirt under a black waistcoat, writing frantically as three phones
ring at once around him. He tears a slip of paper off a pad and adds it to a
growing pile without pausing. Handheld, slight urgency, cyan lamp light.
Audio: three overlapping phone rings, paper tearing, room tone, no music.
```

```
[8s | 4 of 8] The same man in his mid-20s, black velvet yarmulke, dark beard,
round wire-frame glasses, black over-ear headset with a boom microphone, white
dress shirt under a black waistcoat, walks to the main desk carrying a stack of
paper slips a foot high, sets it down heavily, and walks away. A man in his
mid-20s, small black yarmulke, short trimmed beard, crisp white dress shirt,
dark trousers, watches the stack land. Static medium shot.
Dialogue, as he sets it down: "That's since Tuesday."
Audio: his line, the thump of paper, room tone, no music.
```

```
[8s | 5 of 8] Close on the hands of a man in his mid-20s, crisp white dress
shirt, dark trousers, at a dark desk, slowly lifting paper slips off a tall
stack one at a time and setting them down. One slip is a torn scrap. One is
completely blank. He holds the blank one up. Shallow depth of field, cyan desk
light, face out of frame above.
Audio: paper handling, one long silent beat, room tone, no dialogue, no music.
```

```
[8s | 6 of 8] Hard cut. The same dark office, now calm and orderly. The corner
desk is gone. A man in his mid-20s, black velvet yarmulke, dark beard, round
wire-frame glasses, black over-ear headset with a boom microphone, white dress
shirt under a black waistcoat, sits at a clean workstation lit by cyan monitor
glow — no paper anywhere. He answers a call easily, mid-nod. Direct address to
camera on the second half of the line.
Dialogue: "Loopcom answers. Calls, texts, WhatsApp. Nobody writes it down."
Audio: dialogue, a single soft call-connect tone, room tone, no music.
```

```
[8s | 7 of 8] The empty corner where the small wooden desk used to be, dark and
bare. A man in his 60s, wide-brimmed black fedora, full white beard, black suit
over an open-collar white shirt, walks into frame, bends, picks a single
forgotten paper slip up off the floor, looks at it for a moment, and puts it in
his jacket pocket with a small private smile. He walks out of frame. A man in
his 40s, wide-brimmed black fedora, full dark beard, round wire glasses, navy
two-piece suit over an open-collar white shirt, is standing at the edge of
frame, facing camera, and speaks once the older man is gone.
Dialogue, deadpan: "Thirty dollars a month."
Audio: his line, footsteps, room tone, no music.
```

```
[4s | 8 of 8 — DO NOT GENERATE. COMPOSITE THIS.]
Static plate: near-black, soft cyan glow low corner, empty centre.
Wordmark, $30/MONTH, WhatsApp +1 845 723 1213. No motion.
One music hit, then silence.
```

**Watch out:** every shot with paper is a shot where the model will try to write
on the paper. Keep "no letters, no writing, no readable text on paper" in the
negative prompt for shots 1, 3, 4 and 5 specifically, and shoot the slips
slightly out of focus.

---
---

## RECOMMENDATION

**Draft 2, "Nobody Knows That."** It's the funniest, and unusually for a funny
ad the joke and the sales point are the same sentence — you cannot enjoy the
punchline without absorbing the differentiator. It also gets the price in as a
laugh, which nothing else here manages.

**If generation quality disappoints, fall back to Draft 1.** It is the same
strategy with the lip-sync removed, so it will look better with less work, and
it survives having the Yiddish claim pulled.

**Draft 3 is the one to pick if this is the first of many.** The others are one
ad each; the spokesman is a format you can shoot indefinitely.

---

## WHAT I'D NEED TO BUILD THE CHOSEN ONE OUT

1. Which draft — and whether the Yiddish and assistant claims stay in.
2. Confirmation on the tonal break from the locked brand voice.
3. The tag-card plate at 1080×1920 and 1920×1080 from the brochure templates.
4. Whether the voiceover in Draft 1 is English-only or also gets a Yiddish take.
   If Yiddish, it must be a real voice — no TTS vendor covers it, and it's the
   one line in the ad that cannot be mispronounced.
```
