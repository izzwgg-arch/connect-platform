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

## ⛔⛔ 2026-09-17 — IT RECURRED ("Polly voices + existing IVR recordings: I can't hear anything, other audio on the PC is fine") — SAME CAUSE, and the probe got sharper

Read this before touching ANY code for a "no sound in the app" report from Izzy.

- **Server was innocent again, proven first:** nginx on loopcom showed his IP's three
  requests in the minutes before the report — two `POST /api/voice/polly/preview`
  (200, 71,042 B and 66,262 B) and one `GET /api/voice/ivr/prompts/<id>/stream`
  (200, 116,396 B). Full WAV bodies delivered. ⛔ Two different server paths dying
  together is the tell: it is the CLIENT.
- **"The app" was his real Chrome** (UA `Chrome/152` in nginx matched the Chrome the
  extension drove; referer `app.loopcom.net/pbx/ivr-studio`).
- **The definitive probe (run in his Chrome via the extension — no gesture needed):**
  ```js
  const url='https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3?x='+Date.now();
  const f=await fetch(url).then(r=>r.arrayBuffer()).then(b=>b.byteLength);   // 39,868 B in 631 ms — network fine
  const a=new Audio(url+'&m=1'); a.preload='auto'; a.load(); await new Promise(r=>setTimeout(r,3000));
  ({f, readyState:a.readyState, entries:performance.getEntriesByType('resource').filter(e=>e.name.includes('t-rex')).length})
  ```
  Healthy Chrome: `readyState ≥ 1` and TWO resource entries in <1 s. His Chrome:
  `readyState 0`, only `loadstart`, and **ONE resource entry — the media element never
  even sent the request.** The media pipeline blocks on audio-output setup before it
  loads anything. `decodeAudioData` on a WAV still works (different path) — that is
  NOT evidence of health.
- ⛔ **Two probe traps that gave false readings first:** (1) the extension's clicks do
  NOT grant user activation (`navigator.userActivation.hasBeenActive === false`), so
  `play()` → `NotAllowedError` and `AudioContext.resume()` pending forever are
  INCONCLUSIVE — never cite them; the `load()`-only probe above is the one that
  counts. (2) A `await ctx.resume()` inside the probe froze the renderer and timed out
  the CDP evaluate (45 s) — always wrap with a `Promise.race` timeout.
- **What did NOT fix it:** killing Chrome's audio helper (`chrome.exe --type=utility
  --utility-sub-type=audio.mojom.AudioService`, alive since Chrome's Sep 15 04:03 start,
  2¾ days). Chrome respawned it within 3 s and the probe was still stuck, incl. in a
  brand-new renderer on a different origin (`example.com`). So the stuck state lives in
  the BROWSER process, not the helper. **Full Chrome quit + reopen is the fix**
  (⏳ still unconfirmed by Izzy at write time — see the follow-up in this file).
- **Ruled out on the Windows side:** no per-app output override for chrome.exe
  (`HKCU\Software\Microsoft\Multimedia\Audio\DefaultEndpoint` absent; the
  `PolicyConfig\PropertyStore` chrome entries are volume memory with GUID zero, not
  routing); two ACTIVE render endpoints (Realtek Speakers + UGA-4KDP dock audio);
  `Audiosrv` + `AudioEndpointBuilder` running; other apps play.
- ⛔ **Recipe next time, in order:** nginx grep for his IP's audio routes (200 + big
  body → client) → the load()-only probe in his Chrome → tell him to fully quit Chrome
  (tray icon too; verify `Get-Process chrome` is empty) and reopen → re-run the probe.
  Don't touch the product for this.
