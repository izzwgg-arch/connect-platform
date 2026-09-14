# ⛔⛔ AGENT HANDOFF — the Windows app has NO protection for an answer that is never acknowledged, and Gesheft ext 101 rings SIX devices (2026-08-24) — READ FIRST for ANY "I hit Answer on the desktop app and nothing happens", before measuring a ring window from the Asterisk log, or before trusting that a softphone's telemetry reached us

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_GESHEFT_101_WINDOWS_ANSWER_2026-08-24.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**)
Izzy, 2026-08-24: *"gesheft 101 ... one of the devices there keeps complaining. Windows
app: most of the time, when she hits answer on an incoming call, it doesn't answer."*

- ⛔⛔ **THE MECHANISM: the portal answers and then waits for JsSIP's `confirmed`
  event FOREVER.** `apps/portal/hooks/useSipPhone.ts:3061` calls `session.answer()` and
  deliberately does not set `connected` until the ACK arrives — **with no timeout, no
  retry, no error and no message.** If the 200 OK rides a socket that has just been
  replaced or stranded, the incoming-call screen simply sits there. **The mobile app got
  exactly this protection in `c55ae840` (2026-08-06, Create A Box ext 102) —
  `answer_unacked` + a bounded 4 s per-attempt cap + `ANSWER_UNACKED_REQUEUE`. Grep the
  portal for `answer_unacked`/`unacked`/`WAITING_FOR_ACK`: ZERO hits.** Porting it is
  the real fix and is **NOT built and NOT traced** — `c55ae840`'s own notes warn the cap
  interacts with SIP's 200 OK retransmit ladder and that a socket rebuild between
  attempts rejects the pending INVITE.
- ⛔ **`answer()` opens with `if (!sessionRef.current) return;` — a SILENT no-op**, while
  the ring UI renders off `phone.callState === "ringing"` (React state, `FloatingDialer.tsx:611`,
  `DesktopMiniDialer.tsx:1155`). The phantom-ring guards null that ref, and desktop
  **proxy** windows only `send("answer")` over IPC (line 3900) against a mirrored state —
  so a window whose mirror disagrees with the engine shows an Answer button that does
  nothing at all, with no feedback.
- ⛔⛔ **THE SOFTPHONE REBUILDS ITS WHOLE SIP STACK ROUGHLY EVERY 30 MINUTES, AND THE
  TELL IS THE CONTACT USERNAME.** `T8_101_1` logged 28 registration events in 24 h and
  **the random SIP username changes on every one** (`ef525g8i` → `pdgu5m12`). A plain
  re-REGISTER keeps its contact URI; a new contact user means JsSIP built a **new UA**.
  Each rebuild leaves a 3–40 s hole with no contact, and Asterisk keeps the dead one for
  up to `qualify_frequency 30`. **Read the contact URI, not just the event count.**
  ⛔ **This churn is NORMAL — do not chase it as a bad network:** fleet-wide 4,974 events
  across 53 endpoints in 24 h, mean **93.8**; `T8_101_1` is **14th at 28**, far below
  `T7_102_1` (Create A Box) and `T5_101_1` (Luxure).
- ⛔⛔ **HER TELEMETRY IS BEING THROWN AWAY, WHICH IS WHY NOTHING IS PROVABLE.**
  `PORTAL_API_PERMISSION_RULES` gates **`{ prefix: "/voice/diag", permission:
  "can_view_pbx_sbc_connectivity" }`** — so an ordinary `USER` posting a report **about
  their own device** is refused **403**. That office produced **42 of the 73 `/voice/diag`
  403s on the entire platform today**; Gesheft's last `CALL_QUALITY_REPORT` is
  **2026-08-21**, and every WEB row for the tenant belongs to a different user
  (`ap@gesheftkosher.com`, ext 114). **The PBX cannot help either — a 200 OK that never
  arrives leaves no trace — so the failure is invisible from both ends by construction.**
  ⛔ **The reusable point: `/voice/diag/*` is a SELF-REPORT gated on a VIEWING permission**,
  so the users most likely to have trouble are exactly the ones we cannot see.
- ⛔ **Ext 101 "Phone Orders" rings SIX devices: 4 softphone contacts on `T8_101_1` +
  2 desk phones on `T8_101` (two sites).** All four softphone contacts are the **same
  login** (`yisraelweinstock@gmail.com`) from **three separate sign-ins — 16 July,
  17 July and 12 August** — still alive because portal tokens never expire. The office
  runs **three desktop shells at once: 0.1.14, 0.1.6 and 0.1.3**, and the two pre-rename
  shells carry ~98% of its 120,642 requests today.
- ⛔⛔ **TWO THEORIES I FORMED AND DISPROVED — do not re-derive them.**
  **(a) "the app only rings 2 seconds"** came from measuring first-to-last mention of a
  channel in the Asterisk log; **that is a log-verbosity artifact** — a ringing leg is
  mentioned exactly twice and its teardown is never logged against the channel name.
  **(b) "she loses the ringall race"** is wrong: `asterisk.queues_log` for `T8_Q750`
  shows ext 101 is the **top answerer at 208/week** and rings the **full 30 s** when it
  does not answer. **Use `queues_log` (RINGNOANSWER `data1` = ring ms), never the
  verbose log, to measure a ring window.**
- ✅✅ **FIXED AND DEPLOYED 2026-08-24 (`3385e70c`) — a device reporting its OWN trouble no
  longer needs an admin permission (handoff §10).** `/voice/diag` splits perfectly by
  method: **all 7 POSTs are client self-reports, all 3 GETs are admin cross-user views.**
  `PortalApiPermissionRule.permission` now accepts **`null`** (authenticated only), and the
  rules are `{"/voice/diag": null}` + `{"/voice/diag/sessions": can_view_pbx_sbc_connectivity}`
  + `{"/voice/diag/recent-errors": …}` — `portalApiPermissionForPath` takes the **longest**
  matching prefix, so the named reads override the open default.
  ⛔⛔ **THE DEFAULT IS OPEN AND THE READS ARE LOCKED BY NAME — that direction is the whole
  point.** An allowlist of the seven writes would reintroduce this bug the next time
  somebody adds a self-report route: it would silently 403 and we would lose telemetry
  again. Inverting it moves the failure mode to "a new READ is exposed", which
  `voiceDiagSelfReport.test.ts` catches at build time.
  ⛔⛔ **GRANTING `can_view_pbx_sbc_connectivity` TO EVERYBODY WAS THE WRONG FIX AND A TEST
  RECORDS WHY** — it backs the **SBC Connectivity sidebar item**, so every customer would
  have seen a new nav entry (the opposite of Izzy's *"don't let him see it in the sidebar"*),
  and it would also have unlocked reading other people's diagnostic sessions.
  ⛔ **Safe only because all seven writes derive identity from the TOKEN** (`user.sub` /
  `user.tenantId`) and **none accepts a `userId`/`tenantId` from the body** — traced, and a
  guard fails if one ever does. The three busiest already rate-limit per user.
  ✅ **PROVEN LIVE ON PRODUCTION, both halves**, with a 60 s synthetic `role:"USER"` token
  inside `app-api-1` against `127.0.0.1:3001`: `call-quality-ping` **200** (was 403),
  `call-quality-report` and `session/start` **400 validation_error** (the handler RAN —
  which is the proof, and writes nothing), while `GET /voice/diag/sessions` and
  `recent-errors` still answer **403**. Container `.build-commit` `3385e70c`, old rule
  greps 0, 0 restarts, 0 error lines, health 200 both hostnames.
  ⛔ Committed with the **private-index technique** — `server.ts` also carried another
  session's in-flight `startSmsForwardGuardrail` import whose `apps/api/src/sms/` module is
  untracked; a pathspec commit would have shipped an import of a file not in the repo.
  ⛔ Two authoring traps hit **again** despite being in this file: a block-comment stripper
  over `server.ts` swallowed 90,906 chars so the rules parsed as EMPTY and every assertion
  passed vacuously (use a whole-line `//` filter), and heredoc backslashes turned `"
"`
  into a real newline (write test files through the editor).
  ✅✅ **THE ACCEPTANCE TEST PASSED — verified 2026-08-27, and the "she has never produced
  one" line that stood here is now HISTORY.** She produces `VoiceDiagEvent` rows on every
  working day since the cutover (08-24 → 08-27: 5/8/24/14 `SESSION_START`, 19/43/18/14
  `CALL_QUALITY_REPORT`). ⛔ **But it did NOT produce a failure blackbox and never will:**
  the §3 failure — answer sent, ACK never arrives — does not fire JsSIP's `failed`, so it
  emits nothing (**0** `WEBRTC_CALL_DEBUG` rows for her on 08-27). **Her telemetry can now
  prove she is present and how often her stack restarts; it still cannot see the answer
  failure itself.** Do not hunt a blackbox the code cannot write.
- **Cheapest actions first:** (1) get her to **ONE window on 0.1.14** and sign out the
  July sessions — zero code risk, and four windows on one SIP account means four
  independent rebuild cycles abandoning contacts on the same AOR; (2) **grant
  `can_view_pbx_sbc_connectivity`** so `/voice/diag` stops 403ing and the next failure
  is actually recorded; (3) then the `answer_unacked` port.
- ✅✅ **SHE FILED A SUPPORT REPORT AND IT MOVES SEVERAL OF THESE FINDINGS (handoff §8).**
  `AgentEscalation cmt79xh45640lrz13zq2fjlrk`, ref **Q2FJRK**, 2026-08-24 **09:30 ET**:
  *"I cant answer from the computer anymore, it used to work."*
  ⛔⛔ **She was ALREADY on `Loopcom/0.1.14` when she filed it** (the
  `POST /api/support/report` carries that UA) — **so "upgrade the app" is NOT the fix**,
  and it never could have been: the desktop shell loads the HOSTED portal, so 0.1.3 and
  0.1.14 run the same SIP code. Cutting the NUMBER of windows is the point, not the
  version.
  ⛔⛔ **THREE FAILURE BLACKBOXES WERE GENERATED THAT MORNING AND ALL THREE WERE
  DESTROYED BY THE 403** — 09:20:02, 09:24:09, 09:26:05 ET. `postWebrtcBlackbox` is bound
  in the SHARED `bindSession`, so despite the name `buildOutboundFailurePayload` it fires
  on **inbound** sessions too. **That promotes the permission grant from useful to the
  single most valuable action — three usable failure reports were thrown away in ten
  minutes.**
  **The morning, measured** (nginx CEST pinned against the escalation row; PBX log ET):
  09:00:56 first session on the upgraded window → 09:15:34 inbound rings, nothing answers
  → **four SIP re-auths in under 3 min** (09:19:30/09:19:56/09:20:53/09:22:12, against a
  ~30-min baseline) → 09:19:57 she dials **her own mobile** and it dies in 5 s
  (`091957-OUT-NONE-101-8452486206`) → **09:20:02 blackbox 403** → 09:23:53 inbound rings
  → **09:24:09 blackbox 403** (17 s in; **nothing ever answered that call**, so that one
  is NOT a lost race) → 09:25:53 inbound rings → 09:25:59 a **desk phone** takes it →
  **09:26:05 blackbox 403** (that one IS consistent with a lost race) → **09:30:39 she
  reports** → 09:32:44 **fresh SIP session** → 09:37:44 an app leg **answers**, then five
  calls complete normally (09:37/09:44/09:57/10:03/10:55).
  ⛔ **So the complaint is not purely about answering — OUTBOUND died too.** The common
  factor is the SIP connection, and the portal's total silence (no timeout, no error, no
  message) is what makes every variety of it feel like "answer doesn't work". It
  **recovered by itself** after re-registering.
- ⛔⛔ **THE RELOAD DOES NOT FIX STALE CODE — IT FORCES A FRESH SIP REGISTRATION, and the
  stale-bundle theory is RULED OUT (handoff §9).** Measured on the live origin: portal HTML
  is **`cache-control: no-store, must-revalidate`** and the JS chunks are content-hashed
  **`immutable`** — so a page load ALWAYS pulls the current build, and a stale bundle can
  only survive in a window that has not been reloaded. Her app **launched fresh at
  09:00:38** (new Electron process, new document fetch), so **she was already on the
  current code when it failed at 09:20/09:24/09:26**. ⛔ **Do not record "the reload fixed
  it" as a resolution** — it is a workaround for a connection that goes bad, so it will
  keep working and keep being needed. She reloaded **three times** today (09:32, 10:04,
  10:11) and is already self-medicating.
- ⛔⛔ **THE PBX RINGS HER EVERY SINGLE TIME — this is entirely client-side.** All **24**
  inbound calls to ext 101 today carried **exactly 4 app contacts in the wake-dial
  `Dial()` string, with no variation** (`max_contacts` 10 vs 4 in use, so `remove_existing`
  never fires). No eviction, no dropout, no gap in the dial list. **Everything that goes
  wrong, goes wrong after the INVITE reaches her window** — stop looking at the PBX, the
  registration count and the AOR.
- ⛔⛔ **"NO FAILURES SINCE THE RELOAD" IS NOT EVIDENCE IT IS FIXED, AND THIS IS THE TRAP.**
  09:32→11:36 ET: ~21 calls rang, the app answered 6, her window posted 7
  `call-quality-report`s and **ZERO failure blackboxes**. But the three blackboxes came
  from JsSIP's **`failed`** event, and **the failure mode in §3 — answer sent, ACK never
  arrives — does NOT fire `failed`**; the session sits in `WAITING_FOR_ACK` forever and
  the portal reports nothing. `killPhantomRing` and `answer()`'s silent
  `if (!sessionRef.current) return;` are equally silent. **So the quiet only means no SIP
  session failed outright.** Her own "sometimes it works, sometimes it doesn't" is the
  more reliable instrument, and it says the problem is still there.
- ⏳ **STILL NOT PROVEN: the cause of any individual failure.** The `cause`/`sipCode`
  fields were inside the 403'd payloads. `pjsip set logger on` during a test call would
  settle whether her 200 OK ever arrives; that is a PBX-side toggle and needs Izzy's word.
- ⛔⛔ **SHE FILED IT AGAIN THREE DAYS LATER — ref `QP7APH`, 2026-08-27 18:11:50Z (handoff
  §11), and the churn is now PROVABLY HERS.** *"answering the phone on the computer works
  on and off, sometimes it does other times it doesn't. it's very annoying"* — same
  person, same extension, same fault. **The code is unchanged**: `useSipPhone.ts:3150`
  still opens `if (!sessionRef.current) return;` and still waits for `confirmed` forever,
  and `grep -rn "answer_unacked\|unacked\|WAITING_FOR_ACK" apps/portal` is **still 0**.
  ⛔⛔ **THE MEASUREMENT THAT SETTLES IT — split the AOR by contact address.** On 08-27
  `T8_101_1` took **33 registrations on the 443 route (`@45.14.194.179`, her Windows
  windows) carrying 29 DISTINCT `x-ast-orig-host` instance ids** — nearly every one a SIP
  stack built from scratch — while **her Android on the direct `:8089` route used 2
  registrations and ONE UA**. Same AOR, same extension, same day. **That contrast is the
  finding: it is the desktop client, not the network and not the AOR.** Rebuild cadence
  every ~6-11 min (17:06/17:12/17:23/17:29/17:46/17:53/18:02/18:03/18:11/18:13Z),
  tightening around the moment she gave up and filed.
  ⛔ **And it is NOT a deploy artifact — checked, not assumed.** Against every other
  443-route app endpoint she is **~75% of all web SIP rebuilds on the platform** (08-26:
  39 of 52; 08-27: 29 of 40). ⛔ Her own baseline was 10-17/day all week and **DOUBLED on
  08-26** (38, then 33) — whatever changed on her machine that day is the upstream cause
  and **nobody has looked at it**.
  ⛔ The §"PBX rings her every time" bullet above is still true but the number moved:
  the wake-dial `Dial()` now carries **FIVE** contacts, each a different instance id, and
  the list is rewritten between calls — so every call is fired into a set of sockets of
  which only some have a live UA reading them. **That is "works on and off" in one
  sentence.** ⛔ Today: **84** calls offered to the app endpoint, **16** answered by an app
  leg — **do NOT report the other 68 as failures**; ext 101 is a queue extension with two
  desk phones and other agents, and per the bullet above a swallowed 200 OK **leaves no
  server-side trace at all**, so her failures cannot be counted from here.
  ⛔ **She still has a `desktop-pre-0.1.5` window alive** (last seen 08-27 13:48Z) beside
  the `desktop-0.1.16` ones. **Cutting her to ONE current window is still step 1 and is
  still the only zero-risk action available today.**
  ⛔ **Ref lookup trap:** the ref drops ambiguous characters from the id tail
  (`…8qpo7aph` → `QP7APH`), so `lower(id) like '%qp7aph%'` returns **nothing** — search
  `smsBody`/`requestSummary`/`report` instead.
