# AGENT HANDOFF — the softphone reports every device event and every press: CLIENT_TRACE (2026-09-03)

**Commit `762d055f` on `feat/ivr-migration-takeover` (api + portal + one migration).**
Deploy state and the live proof are in §8 — read that before trusting any "it's live" claim.

Izzy, 2026-09-03, after a week of headset tickets that each ended in a screen share:

> *"Stop sending me to her fucking screen. We are supposed to be able to troubleshoot
> these apps without their fucking screen… You should be able to fucking see the logs on
> every little press, everything that happens on their Windows app… Build me a fucking
> reporting system on those apps."* — and — *"something that's actually gonna work, not
> some half-assed broken shit."*

---

## 1. What the softphone recorded before this, and why every headset ticket needed AnyDesk

`apps/portal/hooks/useSipPhone.ts` (the web app AND the Windows app — the desktop shell
loads the hosted portal) reported exactly two things to the server about a call:
a `SESSION_START`/heartbeat row, and an end-of-call `call-quality-report` with packet
counters. It recorded **nothing** about:

- which microphone it auto-picked (`preferHeadsetDevice` picks the MIC by label; the
  SPEAKER is never auto-paired — `preferredSinkIdRef` is only set by an explicit pick,
  so it falls to the Windows default. That split IS the "caller hears me, I don't hear
  the caller" headset family);
- whether `setSinkId()` actually applied — `applySink` swallowed the rejection in a
  bare `catch`, so a speaker chosen in the UI that the browser refused looked, on
  screen and on the server, exactly like one that worked;
- which device the call REALLY got (the track's label vs the id we asked for);
- whether the remote audio element ever played (autoplay policy, wrong sink);
- what the person pressed — dial, answer, hangup, hold, mute, DTMF, settings.

And the one field that would have said "audio never reached the element",
`remoteAudioReceiving`, was read AFTER teardown had reset it: **false in 53 of 53 web
reports**, regardless of what happened. `lastCallError` existed in the hook and was
never sent.

So a ticket like UVW3Y7 (Trust Bookkeepings ext 106) could be diagnosed only by
remote-controlling the customer's PC and reading Windows Sound settings by eye.

## 2. What exists now

One new event type, `VoiceDiagEventType.CLIENT_TRACE`, **structured by `payload.kind`**
so the next fact worth recording needs no enum value and no migration. The kinds are
an allowlist in `apps/api/src/voice/clientTraceBatch.ts` (`CLIENT_TRACE_KINDS`):

| kind | recorded when | facts (all labels, never a phone number or a DTMF digit) |
|---|---|---|
| `device_inventory` | mount, `devicechange`, settings open | `inputs[{id,label}]`, `outputs[{id,label}]`, `why` — deduped client-side when nothing changed |
| `mic_auto_picked` | `preferHeadsetDevice` chose a mic | `micLabel`, `speakerLabel` (the speaker it was NOT paired with) |
| `mic_selected` / `mic_select_failed` | explicit mic pick | `label`, `error` name |
| `speaker_selected` / `speaker_select_failed` | every `setSinkId` | `label`, `why` (setting / speaker_on / speaker_off / call_end_reset), `error` name |
| `speaker_toggle` | speakerphone button | `on` |
| `ringer_selected` | mini-dialer ringer pick | `label` |
| `mic_opened` / `mic_open_failed` | `getUserMedia` for a call | the TRACK's real `label` + settings / `error` name |
| `remote_audio_attached` / `remote_audio_play_blocked` | remote stream attached to the `<audio>` | the element's REAL `sinkId`, `play: ok` / the rejection |
| `one_way_audio` / `incoming_audio_resumed` | the existing detector fires / clears | `secondsSilent` |
| `remote_track_muted` / `_unmuted` / `_ended` | track lifecycle | — |
| `call_end` | quality report sent (flushed immediately) | `remoteAudioReceiving` (from the REF), `lastCallError`, `micLabel`, `speakerLabel`, `speakerOn` |
| `reg_state` | registration state changes | `state` |
| `press` | dial / answer / hangup / hold / unhold / mute / unmute / dtmf | `action`; dial = `digits` COUNT, answer = `hadSession`; DTMF carries NO digit |
| `settings_opened` | mini / floating dialer settings | `surface` |
| `shell_info` | reserved for the desktop shell | — |

**Client:** `apps/portal/lib/clientTrace.ts` — `trace(kind, facts, {flush?})`. Ring
buffer capped at 300 (oldest dropped), batches of 50, 2.5 s debounce / 10 s max wait,
`keepalive` flush on `pagehide` and `visibilitychange: hidden`, a failed send puts the
chunk back and **stops** (no tight retry — the 2026-08-17 nginx auto-ban lesson), and
**nothing is sent while signed out** (`peekBrowserAuthToken()` in `apiClient.ts`).
`apps/portal/lib/voiceDiagSession.ts` gives every window ONE diagnostics session
(sessionStorage-cached; the hook's private `diagSessionPromise` is gone).

**Server:** `POST /voice/diag/events` in `server.ts`, sitting inside the `/voice/diag`
block so the existing self-report guard (`voiceDiagSelfReport.test.ts`) covers it:
identity from the TOKEN, the session must belong to the caller (404 otherwise), 50
rows per batch (overflow COUNTED and returned), 20 batches/min per session
(`checkVoiceDiagEventLimit("batch:<id>")`, separate from single events), every row
through the shared `sanitizeDiagPayload`, unknown kinds dropped and counted, a
timestamp more than 15 min old or 60 s in the future is stamped `now` (a buffer
replayed after a laptop sleep must not land "in the past"). The pure normaliser is
`clientTraceBatch.ts` (7 tests).

The `call-quality-report` schema now NAMES `lastCallError`, `micLabel`, `micId`,
`speakerLabel`, `speakerId`, `speakerOn` — ⛔ zod strips unknown keys, so a field the
client sends and the schema does not name is silently dropped (the `/voice/voicemail
pageSize` trap). The timeline's `events` include went `take: 200 → 600`.

**Admin screen:** `/admin/call-timeline` (SUPER_ADMIN, search by email or session id)
renders each CLIENT_TRACE in plain words (`traceSummary`) with failure kinds coloured,
plus a **Devices** card per session: last mic / speaker / ringer / registration state,
failure counts, every mic and speaker seen, and two callouts — *split devices* (mic on
a headset, speaker somewhere else) and *speaker selection failed*.

## 3. The rules that must survive the next edit

- ⛔ **Never one request per event.** Everything goes through `trace()` → the buffer →
  one batch. A `fetch` per press from a chatty device-change storm is the exact shape
  that got a whole office banned at nginx.
- ⛔ **Never send while signed out.** A dead token retried from a poller is the 401
  stream that auto-bans the customer's IP.
- ⛔ **The allowlist IS the schema.** A new kind goes into `CLIENT_TRACE_KINDS` first,
  or the server drops it (and counts it, so the client bug is visible in the api log
  as `client trace batch: dropped=N`).
- ⛔ **No phone numbers, no DTMF digits, no free text from the customer.** Facts are
  labels, ids (8 chars), counts, error NAMES and booleans. `trimValue` bounds strings
  to 300, lists to 40, keys to 40, nesting to 3 (facts → inputs list → `{id,label}`).
  Depth 2 would EMPTY the device inventory — the first cut had that bug and the test
  caught it.
- ⛔ **A failed `setSinkId` is a timeline event now.** Do not "tidy" `applySink` back
  into a bare catch; the wiring guard fails.
- ⛔ **`remoteAudioReceiving` in the report reads `remoteAudioSeenRef`**, never
  `diag.remoteAudioReceiving` (reset by teardown before the report runs).
- ⛔ **Source guards read call SITES.** `apps/portal/lib/clientTraceWiring.test.ts`
  reads `useSipPhone.ts` + both dialers (comment lines stripped; end markers must be
  CODE, not a comment); `apps/api/src/voiceDiagClientTrace.test.ts` reads
  `server.ts` + `schema.prisma` + the migrations dir. Both replayable
  (`PORTAL_GUARD_ROOT`, `VOICE_DIAG_GUARD_SERVER`/`_SCHEMA`).

## 4. How to use it on a ticket

1. Open **Admin → Call Timeline** (`/admin/call-timeline`), search the customer's
   login email (or paste a session id from a report).
2. Read the **Devices** card first: mic label vs speaker label. A headset mic beside a
   "Speakers (Realtek…)" speaker is the whole diagnosis for one-way audio; a red
   *speaker selection failed* means the UI said headset and the browser refused it.
3. Then the events: `remote_audio_attached` shows the REAL `sinkId` the audio element
   was on; `remote_audio_play_blocked` = autoplay/wrong sink; `one_way_audio` +
   `remote_track_*` say whether audio reached the browser at all; `press` rows show
   what they did, in order, with timestamps.
4. `call_end` carries `lastCallError` and the devices at hangup time.

⛔ An already-open desktop app or browser tab keeps the OLD bundle — it records
nothing until it is fully closed and reopened (desktop: quit from the tray). A customer
window that shows no CLIENT_TRACE rows after the deploy is most likely on the old
bundle, not broken.

## 5. What it does NOT cover (deliberately)

- **Bluetooth profile switching inside Windows** (Stereo ↔ Hands-Free). We see the
  label of the endpoint we were handed and whether `setSinkId` applied; we cannot see
  Windows' own profile flip. The label carrying "(Hands-Free)" vs "(Stereo)" is the
  tell.
- **The desktop shell's own log** (`%APPDATA%\@connect\desktop\logs`). `shell_info` is
  reserved; nothing uploads shell logs yet.
- **The mobile apps** — untouched. Their diagnostics ride the existing
  `VoiceDiagEvent` types.
- **Auto-pairing the speaker** with the auto-picked headset mic — the product fix the
  data points at. Not built here; it changes call audio for everybody and is Izzy's
  call. With the trace in place it can be proven before and after.

## 6. Tests and proof (before deploy)

- api: `node --experimental-test-module-mocks --import tsx --test src/voice/clientTraceBatch.test.ts src/voiceDiagClientTrace.test.ts src/voiceDiagSelfReport.test.ts` → **20/20**.
  Guards replayed against HEAD (`VOICE_DIAG_GUARD_SERVER=<HEAD server.ts>`
  `VOICE_DIAG_GUARD_SCHEMA=<HEAD schema>`) → **5 of 6 fail** (the migration check reads
  the working tree's migrations dir, so it passes on both — expected).
- portal: `npx tsx --test lib/clientTrace.test.ts lib/clientTraceWiring.test.ts` →
  **17/17**; replayed with `PORTAL_GUARD_ROOT=<HEAD export of the three files>` →
  **9 of 9 wiring guards fail**. Both files are registered in the portal `test` script.
- portal typecheck **0 errors**; api typecheck **81 = baseline**, none in a touched file.
- Two harness traps hit and fixed on the way: node 24 exposes `navigator` as a
  getter-only global (`Object.defineProperty`, not assignment), and a wiring test's
  end marker was a comment line that the guard's own comment-stripper removes.

## 7. Traps re-earned this session

- `git show --stat` on a new source file must not read `Bin` — the heredoc
  control-character trap; all new files were written through the editor.
- CLAUDE.md was staged by ANOTHER session throughout; the commit went by explicit
  pathspec so it never entered `762d055f`.
- The two shared files (`server.ts`, `schema.prisma`) were hunk-inspected before
  commit — all hunks mine.

## 8. Deploy state and the live proof

### api — ✅ DEPLOYED and container-verified, 2026-09-04 00:38–00:52Z

`bash scripts/deploy-direct.sh api --branch feat/ivr-migration-takeover` (detached to
`/root/ct-deploy-api.log`, polled by marker — the documented no-self-match waiter):
migration `20260903180000_voice_diag_client_trace` applied by the deploy at
**00:39:18Z** and read back from the live database (`pg_enum` carries
`CLIENT_TRACE`; `_prisma_migrations` row finished, `rolled_back_at` null);
`verify: container commit 762d055fd41e matches target`; `app-api-1`
`.build-commit` = `762d055f`, **0 restarts, 0 error-level log lines**; the route,
`voice/clientTraceBatch.ts` and `take: 600` all grepped inside the container;
`/api/health` **200** and an unauthenticated `POST /api/voice/diag/events`
**401** on BOTH hostnames.

### The live probe (`scratchpad/ct-probe.mjs`, run via `docker exec -i -w /app/packages/db app-api-1 node --input-type=module -`)

It minted a 90-second HS256 token for the SUPER_ADMIN, opened its OWN diag session,
drove the route, read back through the ADMIN timeline route, then deleted every row it
had created. Result, verbatim from production:

| check | expected | got |
|---|---|---|
| `POST /voice/diag/events` with `{}` | 400 | **400** |
| a session id that is not the caller's | 404 | **404** |
| 5 events: inventory, `speaker_select_failed`, a stale press, a bogus kind, a press carrying forged `tenantId`/`userId` in facts | 200, stored 4, dropped 1 | **200 `{stored:4, dropped:1, overflow:0}`** |
| 21 more single-event batches | 429 on the 21st batch of the minute | **429, first at batch 21** |
| rows in the DB for that session | 4 + 19 = 23 | **23** |
| the stale (−24 h) press timestamp | clamped to now | **within 2 min of now** |
| forged identity keys in facts | stay in the payload, never used for attribution | **true**; rows attributed to the TOKEN's user + tenant |
| `GET /admin/voice/diag/timeline?q=<sessionId>` | 200, session found, 23 CLIENT_TRACE events | **200, found, 23** |
| cleanup | events + session gone | **24 events (23 + SESSION_START), 1 session deleted** |

⛔ `@prisma/client` does NOT resolve from `/app/apps/api` inside the container —
`createRequire("/app/packages/db/package.json")` + `-w /app/packages/db`, the
documented recipe; the first run died `MODULE_NOT_FOUND` from `apps/api`.

### portal — ✅ DEPLOYED and bundle-verified, 2026-09-04 01:35Z

`bash scripts/deploy-direct.sh portal --branch feat/ivr-migration-takeover` (detached to
`/root/ct-deploy-portal.log`; a full base-image rebuild, ~40 min). `app-portal-1`
`.build-commit` = `762d055f`, started **01:35:10Z**, **0 restarts**. Shipped `.next`
verified by STRING, never by the deploy's exit line: `/voice/diag/events` in the client
chunks, `speaker_select_failed` / `cc-desktop-shell-diag-session` /
`remote_audio_attached` / `mic_auto_picked` / `ringer_selected` each in **2** chunks
(the hook + the dialers), and the `/admin/call-timeline` page chunk
(`page-e0233a41d4b6eaf2.js`) carrying `CLIENT_TRACE` ×5, `device_inventory`,
`speaker_select_failed` ×5, "Devices" ×3 and the split-device callout. `/` and
`/admin/call-timeline` answer **200 on both hostnames**. ⛔ `traceSummary` greps 0 in the
chunk — minification renames functions; grep the STRINGS it renders.

### ⏳ NOT PROVEN: no CUSTOMER window has produced a CLIENT_TRACE row yet

Read live at 01:38Z, three minutes after the portal cutover: **0** `CLIENT_TRACE` rows
from anyone but the probe (which deleted its own), and the only two
`POST /api/voice/diag/events` lines in nginx are my unauthenticated hostname probes
(**401**). That is the expected shape — every open desktop app and browser tab keeps
the OLD bundle until it is fully closed and reopened, and it was 21:38 ET on a
Wednesday. **The acceptance test is the first restarted window**: its diag session on
`/admin/call-timeline` should show a Devices card, a `device_inventory`, a
`mic_auto_picked` (with the un-paired speaker label), and `press` rows on the next
call. The one-query check:

```sql
select payload->>'kind' as kind, count(*) from "VoiceDiagEvent"
 where type = 'CLIENT_TRACE' group by 1 order by 2 desc;
```

The negatives that matter: **no** `/api/voice/diag/events` request from a signed-out
window (grep nginx for that path with a 401 — after the two probes, there must be none),
and no `dropped > 0` warn lines in the api log (`grep "client trace batch"`), which
would mean a client is sending a kind the allowlist does not know.
