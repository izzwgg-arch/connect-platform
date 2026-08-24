# LOOPCOM — AD PROMPT KIT

> **Draft — under review.** Not approved copy. See `README.md` in this folder.

Everything needed to generate a Loopcom ad with an AI video tool, without it
going off-brand or garbling your name and phone number.

---

## THE ONE RULE

**Never let the AI generate text or the logo.**

No current video model renders legible text or a repeatable logo. Your wordmark
will morph mid-clip, "LOOPCOM" will come out "LOOPCQM", and the WhatsApp number
will be wrong — in a video, in public.

So:

| Layer | Who makes it | What it contains |
|---|---|---|
| Background / B-roll | AI generator | Atmosphere only. No text, no logos, no screens with words. |
| Everything readable | You, from the brochure templates | Wordmark, headline, price, phone number, CTA |

Generate clean plates. Lay the type over them afterwards in Express, Premiere,
CapCut — anything that composites. That's how the good ones are made.

---

## BLOCK A — MASTER BRAND CONTEXT

Paste this at the top of any AI chat/tool before asking for concepts, scripts or
images. It's the brand in one block.

```
BRAND: Loopcom — the AI communications platform for business.
One system for everything a business says to a customer: calls, texts,
voicemail, team chat, and the customer record underneath it.

POSITIONING LINE: "We build everything and anything phone-related."

WHY WE ARE DIFFERENT (both of these are true today):
1. We run our own switching stack, not a reseller wrapper. The routing, the
   call handling, the diagnostics — ours. So when a customer needs something
   specific we can build it instead of explaining why the vendor won't.
2. The phone system, the customer records and the messaging sit on one
   database. Nothing is synced, searched for, or asked twice.

WHAT WE SELL — pick ONE per piece of work, never all of them:
- Phone system: softphone in browser / mobile / desktop, IVR menus,
  business-hours + after-hours + holiday routing, emergency override,
  queues, ring groups, transfers, call recording
- Voicemail: full mailbox, greeting slots, record your greeting by phone,
  missed-call records and push alerts
- CRM: contacts, tags, campaigns, forms, tasks, call scripts, bulk import,
  voicemail drops, local-presence caller ID, live-call screen-pop, and one
  append-only timeline per customer covering every call, text, email and
  voicemail
- Messaging: threaded SMS/MMS, shared or personal team inbox, templates,
  bulk campaigns with an approval gate, 10DLC handled, internal team chat
- AI: lead intelligence with risk flags and a confidence score, AI email
  writing, call transcription with summary, action items, sentiment, intent
- Analytics: live call monitoring, call history, call-quality and queue
  reports, dashboard KPIs, IVR analytics, CSV export
- Billing: branded invoice PDFs, autopay with retries, usage metering,
  hosted payment page  (only if billing is in scope for that campaign)
- Admin: user invites, custom roles, number management, QR device pairing,
  guided onboarding

PRICE: $30/month.
CONTACT: WhatsApp +1 845 723 1213

DO NOT CLAIM — not supported by the product, see SERVICES-INVENTORY.md Part 3:
- "We handle your WhatsApp." Outbound is simulated; no API client exists.
  Using WhatsApp as OUR contact number is fine.
- Yiddish voicemail or call transcription. The code cannot compile.
- "An assistant that does everything." No auto-reply, no tool-calling.
- Choosing or generating voices for recordings. There is no text-to-speech.
  Say: upload your own, or record by phone.

AUDIENCE: B2B. Small and mid-size business owners who are losing money to
calls nobody answered, customers nobody followed up, and a phone system
somebody else controls. Speak plainly to an owner, not to a procurement
department.

VISUAL IDENTITY:
- Ground: near-black. #05080C to #0C1218. Never white, never light grey.
- Accent: a single cyan-to-indigo family. #22A8FF primary, #4F7BFF gradient
  partner, #7FE7FF highlights.
- FORBIDDEN: violet, purple, magenta, lavender, pastel gradients, organic
  blob shapes, glassmorphic frosted pills. That is our nearest competitor's
  exact territory and we do not go near it.
- Geometry: hard edges with 45-degree chamfered corners. No rounded bubbles.
- Imagery: real photography, dark and underexposed, lit by cyan practicals.
  Never flat vector illustration. Never stock-photo people smiling at laptops.
- Type: chamfered technical sans for headlines, clean humanist sans for body.
- Mood: nocturnal, engineered, precise, calm. Infrastructure that works.
  NOT playful, NOT cartoonish, NOT corporate-blue-and-white.

VOICE: Direct and concrete. Short sentences. Say the thing, don't tease it.
No "revolutionize", "seamless", "unlock", "empower", "solutions", "synergy",
"game-changing". No exclamation marks. Claims must be specific enough to
verify.

DO NOT MENTION: our website domain, invoicing, pay links, billing, or
"Cloud PBX". None of those are in scope for this campaign.
```

---

## BLOCK B — THE AD SCRIPT

30 seconds. Six beats. Lock this before generating anything — every later step
is expensive to redo.

```
BEAT 1  HOOK      0-3s    We build everything and anything phone-related.
BEAT 2  PROBLEM   3-9s    Missed calls. Voicemails nobody checks.
                          Every one of them was a customer.
BEAT 3  TURN      9-14s   Loopcom answers. An assistant that actually
                          does everything.
BEAT 4  PROOF    14-22s   Yiddish voicemail and call transcription,
                          written out automatically. Nobody else does this.
BEAT 5  PRICE    22-26s   Thirty dollars a month.
BEAT 6  CTA      26-30s   WhatsApp +1 845 723 1213
```

This doubles as your shot list and your voiceover script.

---

## BLOCK C — SCENE PROMPTS (image-to-video)

**Use image-to-video, not text-to-video.** Supply a start frame you designed —
the model animates *your* frame instead of inventing its own world. This is the
single most important technique here: it makes brand consistency a property of
your input rather than something you keep begging the prompt for.

Start frames to use are in `3 reference frames/`.

Every prompt below deliberately contains **no text, no signage, no readable
screens** — those are added afterwards.

### Scene 1 — HOOK
```
Slow push-in through a dark server room aisle at night. Racks of equipment
on both sides, tiny cyan status LEDs blinking out of focus. Volumetric haze
catching a cold cyan light from deep in the corridor. Camera moves forward
slowly and steadily, shallow depth of field, foreground racks blurred.
Cinematic, anamorphic, near-black shadows, single cyan light source.
No text, no signage, no letters, no logos, no screens.
```

### Scene 2 — PROBLEM
```
Close-up of a smartphone face-down on an empty desk in a dark office,
lit only by a cold cyan glow from one side. The screen edge pulses faintly
as it lights up and goes dark, unanswered. Dust drifting in the light beam.
Very shallow depth of field, macro feel, slow subtle handheld drift.
Moody, underexposed, desaturated except the cyan.
No text, no letters, no logos, no readable screen content, no people.
```

### Scene 3 — TURN
```
Fibre optic cables in a dark equipment room, a pulse of bright cyan light
travelling along them from background to foreground, then continuing past
camera. Cables in sharp focus at centre, falling off to bokeh at the edges.
The light pulse is the only motion. Cold, clean, precise, engineered.
Near-black background, cyan and pale blue only, no warm tones.
No text, no letters, no logos, no signage.
```

### Scene 4 — PROOF
```
Overhead shot of a person's hands holding a phone in a dark room, face not
visible, screen glow lighting the hands in cool cyan. Slight natural hand
movement, the person is listening rather than typing. Cinematic, intimate,
shallow depth of field, heavy negative space around the hands.
Underexposed, single cool light source from the screen.
No text, no readable screen content, no letters, no logos, no visible face.
```

### Scene 5 — PRICE
```
Abstract slow drift across a dark surface with faint 45-degree chamfered
geometric panel edges catching a thin cyan rim light. Extremely minimal,
almost still, like light moving across brushed dark metal.
Slow lateral camera movement. Near-black, one cyan accent, nothing else.
No text, no letters, no numbers, no logos, no shapes resembling characters.
```

### Scene 6 — CTA
```
Slow pull-back from a dark abstract space with a soft cyan glow at centre
and faint particles drifting toward camera. The centre stays empty and dark.
Calm, resolving, cinematic. Near-black with a single cyan light source,
heavy negative space in the middle of frame.
No text, no letters, no logos, no symbols, no objects in the centre.
```

> Scene 6 keeps the centre deliberately empty. That's where your logo and the
> WhatsApp number get composited afterwards.

---

## BLOCK D — NEGATIVE PROMPT

Paste into the negative/exclusion field on every single generation:

```
text, letters, words, writing, captions, subtitles, watermark, logo,
signage, numbers, UI, interface, buttons, menus, garbled text, gibberish
characters, purple, violet, magenta, lavender, pastel, pink, warm orange
tint, blob shapes, rounded bubble shapes, glassmorphism, frosted glass,
flat vector illustration, cartoon, 3d render look, stock photo smiling
people, bright white background, overexposed, low contrast, blurry,
distorted hands, extra fingers, morphing objects, jitter, flicker
```

---

## BLOCK E — VOICEOVER SCRIPT

81 words, lands at roughly 30 seconds read at an unhurried pace.

```
We build everything and anything phone-related.

Missed calls. Voicemails nobody checks. Every one of them
was a customer trying to reach you.

Loopcom answers. An assistant that actually does everything —
your calls, your messages, your voicemail, all in one system.

And Yiddish voicemail and call transcription, written out
automatically. Nobody else does that.

Thirty dollars a month.

Message us on WhatsApp. Eight four five, seven two three,
one two one three.
```

**Note on Yiddish:** if you want a Yiddish-language version, plan on recording
a real voice. Yiddish is not supported by the major TTS vendors, and it is the
one thing in this ad you cannot afford to have mispronounced — it is the whole
differentiator. Verify before building a campaign around a synthetic take.

---

## BLOCK F — IF YOU USE TEXT-TO-VIDEO ANYWAY

You'll get less consistency, but if you have no start frame, prefix any scene
prompt from Block C with this:

```
Cinematic B-roll for a high-end B2B technology advertisement.
Shot on anamorphic lenses, shallow depth of field, heavy film-grade
contrast with crushed near-black shadows. Lit exclusively by cold cyan
practical lights, colour temperature around 8000K. No warm tones anywhere
in frame. Composition follows the rule of thirds with generous negative
space reserved for text that will be added later.
```

That last sentence matters — it makes the model leave you somewhere to put the
type instead of filling every corner.

---

## WHAT'S IN THIS KIT

```
1 logo/
   loopcom-lockup-1424.png       wordmark lockup, real alpha — use this one
   loopcom-lockup-HIRES.png      original high-res lockup
   loopcom-infinity-mark-380.png the infinity mark alone, keyed
   loopcom-logo-scene-900.png    full logo scene with arc rings and glow

2 brochure/
   loopcom-brochure-sheet-01..04.jpg   the four-sheet set — tone reference

3 reference frames/
   loopcom-status-card-9x16.jpg  vertical layout reference (WhatsApp Status)
   loopcom-hero-16x9.jpg         horizontal layout reference
   broll-look-*.jpg              the exact photographic look to match
```

**Sizing the logo:** scale it by *height*, never width. The lockup is 4.53:1;
matching widths against the older 3.64:1 mark renders it short and drags the
whole layout. Clear space on all four sides = the height of the infinity.

**Formats:** 9:16 for WhatsApp Status, 16:9 for web and email. Status caps
around 30 seconds per segment, so build in 30-second units rather than cutting
a long video down.
