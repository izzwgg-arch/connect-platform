# ⛔ AGENT HANDOFF — "he answered and got voicemail" (2026-08-06) — READ FIRST for ANY "answered and it didn't connect" report, mobile push channels, the wake hold, or before trusting a failure LABEL

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANSWER_UNACKED_PUSH_CHANNEL_2026-08-06.md`**
(commit `c55ae840` on `feat/ivr-migration-takeover`; api + telephony DEPLOYED and
container-verified. ⛔ The MOBILE half is committed and on **NO phone**.)

- ⛔ **`session_not_found_timeout` IS A LIE — read the blackbox, never the label.**
  `jssip.ts` stamps it on **any** failure with fewer than 3 attempts, *including
  one where the session was found on poll #1 and answered*. **Two consecutive
  wrong root causes were published to Izzy off that label** before the raw
  `WEBRTC_CALL_DEBUG` payload was read. The payload said the opposite all along:
  `pollIterations:1, answerAttempts:1, sipAnswer.sent:true`, candidate
  `status:6` = **`STATUS_WAITING_FOR_ACK`**. The app answered in ~160 ms; the
  **200 OK was swallowed by a dead-but-healthy-looking socket** (`uaConnected`,
  `uaRegistered`, `sipStackHealthy` all true; Asterisk noticed 27 s later). This
  IS the Simon stranded-socket family — a claim in that session that it was NOT
  was wrong. ⛔ **Nothing watches for an un-ACKed 200 OK**; every safeguard
  checks before/around the ring, none watches the pickup.
- ⛔ **`MAX_ATTEMPTS = 3` was fiction**: the per-attempt timer was the WHOLE
  remaining deadline, so attempt #1 ate all 16 s while the PBX ring expired at
  15 s. Now capped at 4 s + honest `answer_unacked` verdict + a rescue that
  re-offers the call over a fresh leg. ⛔ Do NOT shrink the cap to make "3" fit
  (only 2 fit the initial window — asserted deliberately; a smaller cap cuts
  SIP's 200 OK retransmit ladder short), and ⛔ do NOT add a socket rebuild
  between attempts — `registerInner()` suppresses force-restart inside
  `inInviteAnswerWindow()` on purpose.
- ⛔ **Three safeguards existed and had NEVER RUN — config, not code.**
  `PBX_CONTACT_QUALIFY_ON_RING` was set **nowhere in production** since July.
  The worker's direct-FCM sender had **no credential mount and an empty
  `FCM_SERVICE_ACCOUNT_PATH`** → 6 days of 100% Expo fallback *including* devices
  holding a native token. The SIP→UI cancel bridge arms only **after** a SIP
  INVITE surfaces in JS, so it is structurally disabled in exactly this failure.
  **Never claim a push channel is live from code** — grep
  `FCM_DIRECT_DELIVERED` with `"source":"worker"` in the running container.
- ⛔ **The fast token was hostage to the slow one.** A native FCM token can only
  reach us inside `/mobile/devices/register`, which **required** `expoPushToken`
  — so a phone whose Expo fetch failed could never report the good FCM token it
  already held (8 of 16 Android devices). `expoPushToken` is now nullable with
  tokenless rows keyed on `@@unique([userId, deviceId])`.
- ⛔ **The 20 s wake hold could never finish.** The caller-side `Dial` timeout
  comes from **`followme/ringtime` (15 on 115 of 122 extensions)**, NOT
  `ringtimer` (30). Fixed inside wake enrollment via in-lane `ami.dbPut`,
  raise-only, `0` left alone. ⛔ It MUST run on the `!transformed.changed` path
  — all 10 live repairs logged `dialChanged:false`; otherwise **none** of the 12
  enrolled extensions would ever be fixed. ⛔ Lowering `mobile_reach_wait_secs`
  is NOT the fix (voicemail arrives sooner, not later).
- ⛔ **`database show` output pads the key column**, so awk field indexes shift
  with key length — split on the last `:` or you get a false "no value" census.
- ⛔ **Shared tree:** another session swept this session's `server.ts` edit into
  its own IVR commit, leaving HEAD using `userId_deviceId` with no schema for it.
  Two fixes reported as "done this session" (`8c15d5fa`, `f9907e5d`) already
  existed and were merely **undeployed**. Check `git log -S` before claiming
  authorship, and re-check `git diff --cached --name-only` after every `git add`.
