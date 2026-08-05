# AGENT HANDOFF — ElevenLabs "didn't play" + pipeline hardening (2026-08-04)

Session: Izzy reported *"I tried playing something with eleven labs, and it
didn't play"*, then asked for the whole feature to be *"hardened the fuck out,
sustainable for long-term years to come, stress-tested as well."* Both done.
Read this before touching ElevenLabs code, the IVR Studio "Make a recording"
modal, or before diagnosing ANY "audio didn't play in the browser" report.

---

## 1. The incident — root cause is HIS CHROME, not the product

**Verdict: Izzy's Chrome instance had a globally wedged media pipeline.**
Connect's code, the ElevenLabs key, the account, and his network were all
proven innocent.

Evidence chain (all from 2026-08-04, his IP `50.49.194.85`):

- nginx on loopcom shows `POST /api/voice/elevenlabs/preview` → **200 with
  55–66 KB of WAV**, four times (14:04:37, 14:04:43, 16:07:04, 16:07:12).
  The double-presses 6–8 s apart are the "nothing played, pressed again"
  signature. Server delivered every time.
- Via claude-in-chrome on his logged-in portal session: the preview endpoint
  answered in **819 ms** with a valid RIFF/WAVE 8 kHz 16-bit file that
  `AudioContext.decodeAudioData` decoded to 2.2 s of audio. But
  `audio.play()`'s promise stayed **pending forever** — not resolved, not
  rejected — and the element sat at `readyState 0` with only a `loadstart`
  event and **no error event, ever**.
- It was not our audio: a locally generated 0.1 s silent WAV (8 kHz AND
  44.1 kHz), a remote CDN MP3 (ElevenLabs voice sample), and even a `<video>`
  element all stalled identically. **Every HTMLMediaElement in his Chrome was
  dead.** `decodeAudioData` working while media elements hang is the
  distinguishing fingerprint (different decoder path).
- The identical silent-WAV probe in the in-app Claude browser (separate
  Chromium, same machine, same network) → `loadedmetadata` instantly.
- His network was NOT the cause this time: `api.elevenlabs.io`,
  `storage.googleapis.com`, `elevenlabs.io` all reachable from his machine.

**Fix given to Izzy: fully quit Chrome (all windows) and reopen. UNVERIFIED at
handoff — nobody has confirmed sound came back.** If a restart does not fix
it, the next suspect is a Chrome extension (most likely his content filter)
intercepting media loads.

### The 30-second probe for any future "didn't play" report

1. Check nginx/API logs first. Audio bytes delivered with 200 → suspect the
   browser, not the code.
2. In the user's browser console (or via claude-in-chrome):
   build a silent WAV blob, `new Audio(url)`, listen for `loadedmetadata` —
   nothing within 4 s and no `error` event = wedged media pipeline.
3. Full browser restart. Memory file `browser-media-pipeline-wedge.md` has the
   same recipe.

⛔ Do NOT ship call-path or playback "fixes" for this class of report without
running the probe — the same symptom cost previous sessions whole rounds of
wrong fixes (see the device-logcat rule in the contacts/ghost-call handoff).

---

## 2. What shipped — commit `16f05d2d` on `feat/ivr-migration-takeover`

**NOT DEPLOYED at handoff.** Another session was actively deploying (api
container restarted ~16:10, portal ~16:36 server time), so nothing was pushed
to loopcom from here. Deploy needs api + portal + agent (all three changed).
Remember the branch-drift rule: merge/rebase against what the server actually
runs before deploying.

### apps/portal — `pbx/ivr-studio/MakeRecording.tsx` (the bug Izzy hit)

- The invisible `new Audio()` + bare `await play()` is GONE. That `await` is
  what hung forever with no error and left the button stuck on
  "Generating...".
- Now: an always-mounted, **visible** `<audio controls>` player (hidden until
  the first preview; `controlsList="nodownload noplaybackrate"` — the
  no-download rule for generated audio still stands). `startPlayback()` races
  the `playing` event against a **4 s watchdog**; autoplay refusal and wedged
  pipeline both land in the same honest note: *"Ready - press the play button
  to hear it. If nothing plays, close your browser completely and open it
  again."*
- Timeouts everywhere the modal talks to the server: preview fetch 45 s,
  status+voices load 20 s, both via AbortController with plain-language
  failure text. Three new phrases were added to the `PHRASES` translation
  registration — keep them registered or Yiddish mode loses them.

### apps/api — `voice/elevenLabs.ts`

- `KeyCheck` interface extracted; **30 s read cache** (`subscriptionCache`,
  `voicesCache`, keyed by API key) in front of `/user/subscription` and
  `/voices`. Successes AND definitive "not usable" verdicts cache; a failure
  to ASK is never cached. `clearElevenLabsReadCaches()` exists for tests and
  key changes.
- `callRead()`: metadata calls get a **15 s timeout** (synthesis keeps 60 s)
  and **exactly one retry** on 429/5xx/network after 400 ms.
  ⛔ **Never add retries to synthesis POSTs** — a retried POST that already
  billed spends the customer's characters twice.

### apps/api — `voice/elevenLabsRoutes.ts`

- Preview + generate both carry `config: { rateLimit: { max: 12, timeWindow:
  "1 minute" } }` (rides the globally registered @fastify/rate-limit, keyed
  per IP) — one stuck client can't drain the shared character allowance.
- `withSynthSlot()`: global gate, **max 4 concurrent syntheses**; over the cap
  → 429 `busy` with a try-again message. On generate, the slot covers ONLY the
  synthesis step, not storage/PBX push. The counter releases in `finally`; the
  stress suite exists specifically to prove it can never leak (a leaked slot
  permanently shrinks the feature until redeploy).
- Error-mapping fix the stress test caught: ElevenLabsError 400 (e.g. text
  over the 2,500-char cap) now returns **400**, not 502 — a client fault must
  not read as "provider down".

### apps/agent — `server.ts` (two real bugs)

- **The secrets-save hot-reload was missing `elevenLabsApiKey`** — every other
  provider key hot-reloaded; a just-saved ElevenLabs key was invisible until
  container restart, so the settings page kept judging the OLD key. Fixed.
- The `/agent/voice/elevenlabs/status` fetches to ElevenLabs were unbounded —
  now `AbortSignal.timeout(15_000)` on both. (This is the AGENT's status
  route, used by the `/elevenlabs` owner page via `/agent-api/...`. The
  IVR Studio modal uses the API's route at `/api/voice/elevenlabs/status`.
  Two different services answer the same-looking path — don't conflate them.)

---

## 3. Tests — and the disease that hid them

- **`elevenLabs.test.ts` had NEVER run.** It imported vitest; apps/api doesn't
  install vitest and runs `node --test` via tsx (see the `test` script). The
  import threw, so `pnpm test` failed the file at load and zero assertions had
  ever executed. Rewritten on node:test, all original cases kept, plus cache /
  retry / 8k→16k-fallback / clamping / key-never-in-URL coverage via a
  mocked global fetch. **41 tests.**
- NEW `elevenLabsRoutes.stress.test.ts`: real Fastify + real route code + fake
  provider (env-var key path exercised via `ELEVENLABS_API_KEY`). Proves:
  10-wide burst → ≤4 reach the provider, rest get honest 429s; provider
  failures release their slot; 60-request pounding ends with the gate fully
  open; 13th request from one address in a minute is refused; garbage bodies
  and over-long text never reach the provider. **8 tests. Node runs each test
  file in its own process, so the global-fetch swap can't leak.**
- Run both:
  `cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/voice/elevenLabs.test.ts" "src/voice/elevenLabsRoutes.stress.test.ts"`
  → 49 pass at handoff.
- ⛔ **Never "stress test" against prod** — every real synthesis spends the
  shared monthly character allowance (211,000 chars on the current plan). The
  offline fake-provider suite is the stress test.
- Same vitest disease still present elsewhere: `src/dependencyHygiene.test.ts`
  (task chip filed). `smsSharedInbox.test.ts` has one PRE-EXISTING failure
  (500 where 200 expected, ~line 457) — verified present with this session's
  changes stashed; not ours (chip filed).

## 4. Known state / open items

- Chrome-restart outcome for Izzy: **unconfirmed** — first question to ask.
- Deploy of `16f05d2d`: **not done**, waiting for a quiet window (api, portal,
  agent all changed).
- Pre-existing repo-wide `tsc` noise (`unref` on `number`, delivery/ops
  modules) is NOT from this work; the touched files typecheck clean.
- ElevenLabs account at check time: creator tier, 124 / 211,000 chars used,
  paid up, 38 voices, key healthy.
