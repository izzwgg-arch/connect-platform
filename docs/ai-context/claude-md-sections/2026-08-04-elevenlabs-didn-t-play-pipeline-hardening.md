# ⛔ AGENT HANDOFF — ElevenLabs "didn't play" + pipeline hardening (2026-08-04; RECURRED 2026-09-17 with Polly + recordings) — READ FIRST for ElevenLabs, Polly previews, IVR Studio recordings, or any "audio didn't play in the browser" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ELEVENLABS_PLAYBACK_2026-08-04.md`**

- **"Didn't play" was Izzy's CHROME, not the product.** His Chrome's media
  pipeline wedged globally: every `<audio>`/`<video>` stalled at `readyState 0`
  with no error, `play()` pending forever — while `decodeAudioData` worked and
  the server had delivered valid WAV with 200s all four times. Same probe in a
  second browser on the same machine played instantly. Fix = full Chrome
  restart (**unconfirmed at handoff — ask first**); next suspect is his filter
  extension. ⛔ Run the silent-WAV probe (handoff §1) before shipping ANY fix
  for a "didn't play" report.
- Hardening shipped as `16f05d2d` on `feat/ivr-migration-takeover`; **ALL
  THREE HALVES DEPLOYED as of 2026-08-05**: api (container at `9b521176`),
  portal (hardening markers grep-verified inside the live `.next` build), and
  agent (manual compose rebuild 2026-08-05 ~00:30 ET under Izzy's explicit
  permission — the deploy queue has NO agent service, agent is always a manual
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml build
  agent && up -d agent`; new container verified healthy with both fixes).
  Highlights: visible preview player + 4s playing-event watchdog + honest
  stall message; timeouts on every modal fetch; 30s server-side read cache +
  single read retry; 12/min per-IP + 4-concurrent synthesis guards; client
  faults 400 not 502; agent hot-reload was missing the ElevenLabs key (saved
  keys were invisible until restart — fixed).
- **2026-08-05: the generate route had never worked** — it selected `slug`
  from Tenant, and **the Tenant model has NO slug column**, so every
  `POST /voice/ivr/prompts/generate` died in PrismaClientValidationError (and
  the portal dialog rendered the raw Prisma dump to the customer). Fixed
  `9b521176`, deployed + live-verified same day. ⛔ `TenantPbxPrompt.tenantSlug`
  is ALWAYS derived from `Tenant.name` via the `toIvrSlug` normalisation
  (lowercase, non-alnum → `_`) — a differently-formatted slug makes rows
  invisible to the prompt list and PBX prefix matching. Handoff doc §5.
- **Global error-handler safety net (`4fb512ed`, handoff §6) is ✅ DEPLOYED**
  as of 2026-08-06 inside api `7f7ec541` — uncaught route errors no longer show
  raw internals in customer dialogs. Root cause of the leak: the api container sets NO
  `NODE_ENV` (only telephony does in docker-compose.app.yml), so the old
  handler's "production" branch never ran — June-era protection sat dead for
  months. ⛔ Never gate safety behavior on `NODE_ENV` in apps/api; the portal
  (`services/apiClient.ts`, `MakeRecording.tsx`) renders the server `message`
  field verbatim by design, so the server body IS the customer-facing text.
- ⛔ **Never retry a synthesis POST** (double-bills characters) and **never
  stress-test against prod** (real money; the offline fake-provider suite in
  `elevenLabsRoutes.stress.test.ts` IS the stress test). 49/49 tests green via
  `node --experimental-test-module-mocks --import tsx --test` in apps/api.
- **`elevenLabs.test.ts` had never run** — it imported vitest, which apps/api
  doesn't install (suite runs node:test via tsx). Rewritten. The follow-up
  chips are DONE: `smsSharedInbox.test.ts` fixed `6976a905` (stale fake-db
  mock, route was fine); vitest imports purged across apps/api in `2b4e9232`.
  ⛔ The `6d3d0b05` merge from feat/ai-agent CLOBBERED the converted
  `dependencyHygiene.test.ts` back to the vitest version — restored from
  `2b4e9232` right after. When merging feat/ai-agent, ALWAYS take the
  node:test version of any test file (grep `from "vitest"` after every merge;
  apps/api must have zero hits).
- Two status routes look alike: `/api/voice/elevenlabs/status` (API — IVR
  Studio modal) vs `/agent-api/voice/elevenlabs/status` (agent — owner
  settings page). Don't conflate them.

## ⛔⛔ 2026-09-17 — "Polly voices + existing IVR recordings: I can't hear anything, other audio on the PC is fine" — RESOLVED: WINDOWS VOLUME MIXER HAD CHROME AT 0. Not the product, not the pipeline.

Read this before touching ANY code for a "no sound in the app" report from Izzy.

- **THE CAUSE (proven, then fixed live):** the Windows per-app **Volume Mixer slider for
  Chrome was at 0.00** (not muted — turned down) on the default speakers (Realtek,
  master 74 %, unmuted). Everything in Chrome "played" — the Studio's own player ran
  `loadedmetadata → canplay → playing`, `play()` resolved, unmuted, volume 1, clock ran
  7.27 s to `ended` — and Windows multiplied it by zero. Wispr Flow sat at 100 % next to
  it, which is why every other program was audible. Read via CoreAudio
  (`IAudioSessionManager2` → sessions → `ISimpleAudioVolume.GetMasterVolume`); fixed with
  `SetMasterVolume(1.0)` on the chrome session: `0.00 → 1.00`, replayed, clock ran again.
- ⛔⛔ **CHECK THE MIXER FIRST NEXT TIME — it is a 10-second read and it is the answer
  to "other audio works, this app doesn't".** Windows remembers per-app volume by the
  app's path, so it survives restarts of the app AND of Chrome's audio helper. The
  CoreAudio recipe is in `docs/ai-context/AGENT_HANDOFF_ELEVENLABS_PLAYBACK_2026-08-04.md` §8.
  Manual route: Settings → System → Sound → Volume mixer → Google Chrome.
- ⛔⛔ **A WRONG DIAGNOSIS I MADE FIRST, KEPT SO NOBODY REPEATS IT:** I read
  `readyState 0` / "the `<audio>` never fetched" in probe tabs as the Aug-4 pipeline wedge
  and told Izzy to restart Chrome. Those probes ran in the EXTENSION's tab — a hidden,
  background tab with NO user activation (`navigator.userActivation.hasBeenActive ===
  false`; extension clicks grant none) — and Chrome defers media loading there. The
  moment a real click landed in his signed-in, visible tab, the same player loaded and
  played instantly. ⛔ **A media probe from an un-activated background tab proves
  NOTHING about the pipeline.** Test in the user's real tab with a real click, or
  don't call it a wedge. (Killing Chrome's `audio.mojom.AudioService` helper, PID
  18384 since Sep 15, was harmless and unnecessary — it respawned in 3 s.)
- **Still true and still useful:** the server was innocent — nginx showed his IP's
  requests as `200` with full bodies (2× `POST /api/voice/polly/preview` 71,042 B /
  66,262 B, `GET /api/voice/ivr/prompts/<id>/stream` 116,396 B). Two different server
  paths dying together = the CLIENT. And the client was real Chrome, not the desktop
  app: the desktop app stamps `Loopcom/<version>` into every UA
  (`apps/desktop/src/userAgent.ts`; `Loopcom/0.1.17-rc.18 Chrome/146` sat on /dashboard)
  while the Studio traffic was a bare `Chrome/152`.
- **Chrome profiles:** his Chrome runs several profile windows in ONE browser process
  (`Default` "Iz" = where the Claude extension lives; `Profile 2` "jacob"). Profiles do not
  share `localStorage["token"]`, so the extension's tab was signed out while his Studio
  tab was signed in. Izzy signed in on the extension's tab himself to let me drive the
  real click. `AuthGate.tsx` only READS the token on load and never clears it — a probe
  navigation cannot sign him out.
- ⛔ **Recipe next time, in order:** (1) nginx grep his IP for the audio routes — 200 +
  big body → client. (2) **Windows Volume Mixer for that app (CoreAudio read).** (3) Only
  then a media probe, and ONLY with a real click in the user's own visible tab. Don't
  touch the product for this; don't tell him to restart Chrome on a background-tab probe.
- ⏳ **Not yet proven by a human ear at write time:** Izzy hearing the replay after the
  mixer fix (asked; awaiting his answer).
