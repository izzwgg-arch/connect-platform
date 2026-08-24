# LOOPCOM — HOW NOT TO RE-RENDER

> Working notes. Applies to every spot in the Spokesman and Nobody-Knows-That
> campaigns. Ordered by how much waste each one actually prevents.

A re-render is almost never caused by a bad idea. It's caused by asking the
model to do something it is structurally bad at, or by not being able to tell
what went wrong. Everything below is aimed at one of those two.

---

## 1. ITERATE ON STILLS. ANIMATE ONCE.

**This saves more than everything else combined.**

An image is seconds and cents. A video clip is minutes and real money. And the
overwhelming majority of rejected clips fail for reasons that were already
visible in the first frame — wrong face, wrong coat, wrong room, subject in the
wrong third, no clean space for the caption.

So: build the seed frame as an image, judge *that*, fix it as an image, and only
animate once it is correct. Never discover a composition problem at video prices.

```
image  →  image  →  image  →  (only now) video
 ~$      ~$        ~$              $$$$
```

The `ad-characters/` frames were built this way. Ari took two attempts as a
still; at video rates that would have been two wasted clips.

---

## 2. NEVER ASK A MODEL TO MAKE SOMEONE APPEAR

Video models are bad at bringing a person into existence or into frame. Faces
smear, limbs duplicate, coats change colour mid-move. And this campaign's entire
premise is a man appearing where he shouldn't — so this is our single biggest
structural risk.

**The fix: he is always already there. Something else changes.**

Put the motion on the environment, the camera, or a hard edge — never on the
act of arriving.

| Instead of | Do this | What moves |
|---|---|---|
| "he rises into frame" | "he is already standing, motionless, as the camera pulls back" | camera |
| "he appears in the passenger seat" | "the foam clears to reveal him already belted in" | environment |
| "he walks into the lift" | "the doors open on him already inside, dead centre" | a hard edge wipes |
| "he steps out from behind the plant" | "rack focus from the desk to him, already standing behind it" | focus |

> **Correction to my own shot 1.** The flagship currently reads *"rises into that
> empty upper space from behind a low credenza."* That is a materialisation
> request and it will cost renders. Change it to: **"is already standing
> motionless in the dark upper third; the camera pulls back slowly to reveal
> him."** Same joke, better odds, and honestly funnier — he was never not there.

---

## 3. ONE CLIP = ONE CONTINUOUS CAMERA STATE

If a prompt contains a cut, two camera positions, or the word "then", the model
will try to serve both and you get a crossfade smear.

- One camera move per clip, or none.
- A slow pan or pull-back is fine — it's continuous.
- "Cut to" belongs in the edit, never in a prompt.

---

## 4. RATION THE SPEAKING CLIPS

Lip-sync is the highest-failure element in AI video, full stop. Every clip with
dialogue is several times more likely to need a re-roll than a silent one.

- **Target ≤ 4 speaking clips in an 8-clip spot.**
- **14 words per 8s clip. Hard ceiling 18.** Over that, delivery comes back
  rushed or clipped mid-word — which reads as a model failure, not a bad take.
- Two people speaking in one clip is roughly double the risk of one. Split the
  exchange across two clips where the edit allows.
- Silent clips are not a compromise. Shot 4 of the flagship — the lift — is the
  best beat in the ad and has no dialogue at all.

---

## 5. DESIGN TEXT OUT OF THE SCENE, NOT JUST INTO THE NEGATIVE PROMPT

A negative prompt reduces garbled text. It does not eliminate it. The reliable
fix is to give the model nothing to write on.

- Turn monitors away from camera, or frame them out.
- Keep paper, clipboards, whiteboards and signage out of focus or out of frame.
- Where a screen must be visible, specify **"abstract data glow, no characters,
  no symbols"** rather than trusting the negative alone.
- Check **every frame** of a clip, not just the first. Text often appears
  halfway through as the camera moves.

The one scenario this genuinely constrains is the cheder report (Set Three #5),
because a folder is the whole gag. Shoot the folder shallow and angled away.

---

## 6. WHEN YOU DO RE-ROLL, CHANGE EXACTLY ONE THING

Otherwise you learn nothing and the next attempt is another coin flip.

Keep a one-line log per attempt: what you changed, what happened. Three
disciplined attempts beat ten random ones, and the log is what makes attempt
four succeed.

---

## 7. DECIDE PASS/FAIL BEFORE YOU LOOK

Write down the three things a clip must show, *before* generating. Judge against
that list only.

> Shot 7 must show: (a) Ari relaxed, not braced, (b) Mendy legible on the
> headset in the upper third, (c) a clean black middle band for the caption.

Without this you re-roll on taste, and taste is infinite. Most "not quite right"
clips are actually passes.

---

## 8. PROMPT ORDER MATTERS — FRONT-LOAD WHAT YOU CAN'T COMPROMISE

Models weight early tokens more heavily. Put the non-negotiables first.

```
1. Frame & composition   vertical 9:16, three bands, where each subject sits
2. Subject(s)            full verbatim descriptor, most important person first
3. Action                one continuous thing
4. Camera                one move, or locked off
5. Light                 cold blue-cyan 8000K, no warm tones
6. Style                 anamorphic, shallow DOF, crushed blacks, film grain
7. Audio                 dialogue, room tone, no music
8. Exclusions            no text, no letters, no logos, no readable screens
```

Wardrobe belongs in **2**, never trailing at the end — a descriptor at the tail
of a long prompt drifts far more often.

---

## 9. LOCK IT IN THE TOOL, NOT THE PROMPT

Aspect ratio, duration and seed are parameters. Writing "vertical" while the tool
sits on 16:9 produces a horizontal video with the word "vertical" ignored — and
that is a whole wasted render for a two-second settings check.

If the tool exposes a **seed number, record it.** Reproducing a near-miss is
worth more than a new roll of the dice.

---

## 10. SHOOT THE EASY CLIPS FIRST

Bank progress before spending on the risky ones. Rough order of difficulty:

| Low risk | Medium | High risk — budget extra attempts |
|---|---|---|
| Locked-off single, no dialogue | Slow push or pull-back | Two people in dialogue |
| Environment reveal (foam, doors) | One speaker, short line | Hands manipulating objects |
| Rack focus | Walking with tracking camera | Paper, folders, documents |
| Deep static composition | Mirror reflection | Crowds, background extras |

The car wash is the right opener for the campaign partly because it is the
cheapest thing on this list — the reveal is done by foam, and foam cannot get
its face wrong.

---

## THE PRE-FLIGHT CHECK

Before spending a single video render:

- [ ] Seed frame exists as an approved **still**
- [ ] Nobody in the prompt is arriving, appearing, entering or materialising
- [ ] One camera state, no "then", no cuts
- [ ] Dialogue ≤ 14 words, and this clip genuinely needs to be a speaking one
- [ ] No screen, sign or paper facing camera
- [ ] Descriptors pasted **verbatim**, positioned early in the prompt
- [ ] Aspect ratio, duration and seed set **in the tool**
- [ ] The three pass/fail criteria are written down
- [ ] There is clean negative space where the caption will sit
