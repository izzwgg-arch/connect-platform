# Creative Studio — BUILT AND LIVE: a 15-second commercial is now a thing you can finish (2026-09-16)

Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATIVE_STUDIO_BUILD_2026-09-16.md`**.
Phase-0 design + mockup: `2026-09-15-creative-studio-phase-zero.md` (still the screen inventory and the
licence research). Izzy: *"Go build it exactly like the mockups… do not stop until you have proof."*

✅ **DEPLOYED and container-verified.** Round one built generation (images, AI video, the Coworker's tools,
the learning loop). Round two built the rest of the film:

```
storyboard → render each shot → assemble → voice, music, captions → the cut → export
```

Four new pages, each with its own key and its toggles in both permission editors: **Storyboard**,
**Video editor**, **Voice & music**, **Export**. All twelve `/creative/*` routes serve 200.

⛔ **Every edit goes through the SAME document-ops door the Coworker writes through**, so "the agent edits
the same project you do" is the implementation, not a claim. A write against a revision that has moved on is
refused with the newer copy attached — proven live.

⛔ **Nothing is drawn that the renderer would ignore.** Splitting a clip really splits it: `TimelineClip`
carries an in-point and `media.trimTo` seeks to it, so the second half starts where the cut was.

✅ **Proven on production, end to end, twice.** By hand: 12 seconds asked for → three 4-second shots (the
studio did the split) → each clip **attached itself to its shot** → assembled → captions through the ops door
→ **`final-cut.mp4`, exactly 12,000 ms** + `captions.srt` → exported to three sizes. And in a real chat the
**Coworker did the whole job itself**: wrote a four-shot storyboard, started **zero jobs** until asked,
quoted the cost, rendered, assembled *"2 used, 2 skipped"* and rendered a 6,000 ms cut — for $1.20.

⛔⛔ **SIX REAL BUGS, every one found by running it rather than reading it** (details + the fix in the
handoff). The two worth knowing before touching anything:

- **The automatic quality check was looking at nothing.** Reasoning tokens count against
  `max_completion_tokens`; at 400 the model spent the budget thinking and returned empty content, so every
  verdict was "the checker could not answer". It is 2000 on gpt-5-mini now and really answers. ⛔ The
  fail-open design is why nobody was ever blocked — and why it could sit there doing nothing and look fine.
- **"Render all four shots" rendered two, and the Coworker told the person the rest were coming.** The
  concurrency cap counted QUEUED work. A cap that makes the queue lie is worse than no cap: it limits what
  is RUNNING now, and the rest wait.

The other four: a 5-second shot cost two renders and a join (and 5s beats are BILLED as 8 — the default beat
is 4 now); every video was stored twice; re-writing a storyboard orphaned clips already paid for; and a
provider's real reason was thrown away (`errorFrom` only read OpenAI's shape).

⛔⛔ **A FINDING THAT IS NOT A CODE PROBLEM AND NEEDS IZZY: the platform's ElevenLabs subscription has a
failed payment.** The key is valid (Creator tier, 49,878 of 1,036,000 characters) and lists 38 voices, but
EVERY text-to-speech call returns **401 `payment_issue` — "Your subscription has a failed or incomplete
payment."** Creative Studio voiceovers and music cannot work until that invoice is paid, and anything else on
the platform that synthesises speech with ElevenLabs is in the same position.

⛔ **Grant Creative Studio as a set.** Shared calls (`/creative/jobs`, `/creative/voices`,
`/creative/export-presets`) sit under the `/creative` catch-all, which asks for the **section** key — keyed
on one page it would have given somebody a working link and 403s behind it. Per-page keys still decide which
pages appear; spending still gates on the action keys.

⏳ **NOT DONE:** nobody has opened the screens in a browser; **no key is granted to anybody** (granting IS
the launch); MinIO is still on root credentials; the reject-and-re-render path is proven by test, not yet by
a real generator producing a real six-fingered hand; and the agent-design-mode screen from the mockup is
still unbuilt. **104 api tests + 11 portal tests pass.**
