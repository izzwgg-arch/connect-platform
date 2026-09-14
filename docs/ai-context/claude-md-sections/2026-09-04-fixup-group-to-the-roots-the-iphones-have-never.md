# ⛔⛔ AGENT HANDOFF — Fixup Group "to the roots": the iPhones have NEVER connected an inbound call, because a suspended iPhone keeps saying "registered" after the PBX dropped it (2026-09-04 → 09-06, `5dcc38a5`, iOS build 58) — READ FIRST for ANY iPhone "I answered and got voicemail", before adding a "skip when already registered" guard to the ring path, or before calling the 443 route an answer fix

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FIXUP_GROUP_ROOTS_2026-09-04.md`**
(`5dcc38a5` + `6a86b621` on `feat/ivr-migration-takeover`. ✅ **iOS build 59 is ON
TESTFLIGHT 2026-09-06** (`855a24c3-f5cd-48dd-bf95-83971b28ce84`, FINISHED 15:43Z, Apple
VALID 15:46Z, attached to "Loopcom Testers", beta review WAITING_FOR_REVIEW) — it carries
BOTH the F1 answer fix and the F8 voicemail fix and supersedes build 58 (F1 only, also on
TestFlight). Fixup's login is in that group. ✅ **portal DEPLOYED and container-verified at
`6a86b621`** (F8's two desktop players). The App Store release and the next Android fleet APK
are Izzy's call, and the phones only change when the customer installs. ✅ **One production data change:** Fixup Group
(`cmqr9cs9402qqs013m7p64lpi`) moved to the 443 SIP route (`webrtcRouteViaSbc=true`,
`sipWsUrl=NULL`, `sipDomain=m.connectcomunications.com`; backup
`/root/fixup-443-20260904/tenant-before.json`). No api/portal/telephony deploy, no PBX write,
no migration.) Memory: [[fixup-iphone-stale-registration-never-redialed]].
Izzy, 2026-09-04: *"find every single issue … every failure, every hiccup they had since the
system went up … in every failure, I want a solution and proof that the solution is the
right solution."*

- ⛔⛔ **THE HEADLINE, from `asterisk.cdr` all-time: 92 inbound calls since 06-23 — desk
  answered 43, an app answered 4 (ALL Android/desktop), and the two iPhones have NEVER
  connected an inbound call. All 4 iPhone Answer taps failed (08-05, 08-07, 08-24, 09-04).**
  Today's caller 973-756-5563 rang three times in five minutes and reached nobody.
- ⛔⛔ **THE ROOT CAUSE IS THE APP TRUSTING ITSELF.** PJSIP qualifies every contact
  (`qualify_frequency 30`/`qualify_timeout 3`); a SUSPENDED iPhone cannot answer the OPTIONS
  ping, so its contact is dropped ≤33 s after backgrounding (09-04: backgrounded ~14:10:49Z,
  contact gone 14:11:22Z). The app never notices — its blackbox reads
  `registrationState: registered, registrationAgeMs: 156681, wssConnected: true` — and
  **every ring-time guard skipped on "registered"** (the eager pre-register, jssip's
  *"Already registered, skipping"*, the iOS `earlyColdAcceptSent` path). The PBX committed
  `CONTACTS=` desk+desktop+Android, Mode-B waited its 8 s for a fresh contact
  (`no_fresh_contact`), voicemail at 30 s. **Identical on 08-07 (`registrationAgeMs
  162675`), and 6 of 15 iOS answer-fail blackboxes PLATFORM-WIDE (B Visible, Loopcom Demo,
  Fixup) carry it — an iOS app defect, not a Fixup fault.**
- ✅ **THE FIX (`5dcc38a5`): `decideRingRegister()` in
  `apps/mobile/src/sip/mobileWakeRegistration.ts`** — iOS + app not active + registration
  older than **`IOS_PBX_CONTACT_DROP_MS = 30 000` (the qualify period, not a tuned guess)**
  → the eager pre-register calls `sip.register({ forceRestart: true })`. Foreground, <30 s,
  "registering" and **Android are byte-identical to before**; jssip's
  `inInviteAnswerWindow()` still refuses the restart once an INVITE has landed. ⛔ **Never
  re-add a bare "skip when registered" guard on the ring path** — a source guard
  (comment-stripped, CRLF-normalised) fails if the eager block decides on `regState` alone.
  Proven: 17 tests (the decisive cases are the REAL blackbox values), **all 3 source guards
  fail replayed against HEAD**, mobile `tsc` 0. Log tell: `eager_preregister_stale_ios_force_restart`.
- ⛔⛔ **THE 443 ROUTE IS NOT THE ANSWER FIX — say so plainly.** Fixup was the last iOS
  tenant on the direct 8089 route behind a Cologuard filter (register-on-wake p50 15.4 s /
  p90 57.7 s, the platform's slowest; 18/52 iOS sessions `SIP_REGISTER_FAILED`), so the
  flip is justified — but **B Visible has been on 443 for weeks and carries 7 iPhone
  `INVITE_NOT_RECEIVED` failures with the same stale-registered signature.** 443 makes the
  fresh REGISTER fast enough to land inside the ring; F1's fix is what sends it. ⛔ Every
  Fixup device must **sign out and back in** or the cached `sipWsUrl` keeps the old route.
- ⛔ **Two iPhones on ONE login share ONE `CallInvite`** — a DECLINE from either flips the
  row `DECLINED` and the other's ACCEPT answers `INVITE_ALREADY_HANDLED` (declines seen
  08-05/08-12/08-24/08-25; no lost call proven from it alone). Per-device invite state
  needs a migration — NOT built. Signing out one iPhone is still the right mitigation.
- **The rest of the roots:** the Android is on `1.0.0+20260802-103722` (5 weeks old —
  install the current APK, nothing pushes it); the desk phone was registered at 32 ms /
  0 % loss through both of today's 30-s rings nobody picked up (a second desk contact via
  DigitalOcean `159.89.179.105` vanished 08-31 20:40Z — unexplained, ask them); **29 of 92
  callers hung up inside IVR-48 without pressing a key** (the menu requires one; a
  no-key default to 103 is Izzy's call); zero support tickets ever filed; SMS ingest clean
  and the 08-30 notification/MMS fixes are live on their 0.1.16 desktop.
- ⛔⛔ **F8, reported the same day: "a voicemail was playing, a call came in, and it didn't
  stop" — THREE voicemail players, NONE paused on a ring (`6a86b621`).** Mobile
  `VoicemailTab` stopped only on `sip.callState`, which turns "ringing" when the SIP INVITE
  reaches JsSIP — the ring screen is PUSH-driven (`incomingInvite`) and on F1's failure shape
  the INVITE never arrives, so the voicemail talked through the CallKit ring; the portal
  voicemail page's `SmartAudioPlayer` and the mini dialer's `VoicemailPlayer` never consulted
  the phone at all. Now: mobile `callIsActive` also includes
  `notifications.incomingInvite !== null`; both portal players read `useOptionalSipPhone()`
  and pause on ringing/dialing/connected. ⛔ **Any new audio player in either app must pause
  on the PUSH invite (mobile) / `phone.callState` (portal), not on the SIP session** — guards:
  `apps/portal/lib/voicemailPausesOnRing.test.ts` + mobile `voicemailPausesOnRing.test.ts`
  (both registered, all 3 fail against HEAD). Which surface Fixup meant is unprovable (their
  desktop has 0 CLIENT_TRACE rows — never restarted since 09-03). Mobile half = **iOS build
  59** (`855a24c3-f5cd-48dd-bf95-83971b28ce84`) + the next Android fleet APK; portal half =
  portal deploy (state in the handoff §5), and the office must fully close + reopen the app.
- ⛔⛔ **F9, "SMS problems on Windows" (`a9104862`, worker + api DEPLOYED): texting itself
  was HEALTHY (14 days: every outbound `sent`, every inbound `delivered`, every photo
  mirrored) — the ONE defect was voice-message MMS.** An iPhone voice memo sent by text
  arrives from VoIP.ms as `media.amr`; chat storage refuses `audio/amr`, the mirror failed
  silently (the callers' `.catch(() => null)` ate the reason), and the desktop drew an
  `<audio>` over the raw carrier URL, which Chromium cannot decode. Platform-wide the only 2
  unmirrored inbound media in 14 days were exactly Fixup's two AMRs. Now
  `packages/shared/src/voipMsInboundMms.ts` transcodes AMR/AMR-WB/3GPP to AAC/M4A
  (`audio/mp4`) with ffmpeg before writing, and logs `voipms_mms_fetch_failed` with a stage +
  reason. ✅ Proven live: the new worker's boot backfill mirrored the 09-04 memo 44 s after
  start (ffprobe: aac 24 kHz mono 69.2 s); the 08-27 one back-filled by a one-off
  `runVoipMsMmsMirrorBackfill({lookbackDays:14})` in the container. ⛔ **`writeChatAttachmentFile`'s
  MIME allowlist is the gate — any new carrier format must be transcoded, never allow-listed
  raw.** The customer's exact complaint is still unknown; if it recurs, get the thread + time.
- ⛔⛔ **F10, "incoming messages take too long" (`fe1813f6`, worker DEPLOYED + measured): the
  inbound poll cycle took ~3–3.5 MINUTES** — VoIP.ms answers 7–11 s per API call and the
  cycle made getSMS+getMMS for EACH of 16 numbers (32 calls); the 60 s timer was skipped while
  a cycle ran, so a text sat unseen up to a whole cycle. Now ONE account-wide getSMS (limit
  500) + ONE getMMS per cycle, split per DID (`mergeInboundRowsForDid`), FULL page or failed
  call → the old per-number fetch. **Live: cycles every ~60 s, 8–13 s each (`cycle done …
  mode=account ms=…`)** — worst-case carrier lag 3.5 min → ~70 s. ⛔ Never re-add a
  per-number carrier call to that loop. ✅✅ **THE INSTANT PATH IS LIVE FOR FIXUP (2026-09-07,
  `f15923a0` api DEPLOYED + one carrier write, Izzy: "do it thru the api"): VoIP.ms's per-DID
  `webhook` field now carries the tokened URL and a real text lands in Connect the SECOND
  VoIP.ms receives it** — proven on Connect's own 845-557-7768 (webhook `routed` at 14:35:46Z,
  the poll then found `voipms:110998324` already present, exactly ONE message row). ⛔ **Three
  facts nobody may re-derive:** (1) the caller is the per-DID **`webhook`** field (7 DIDs point
  at us: Fixup, Ribit, Displaydex, Trust, Luxure 8455378318, Relax, lanhome), NOT an
  account-level callback — the §F10 line above saying "account-level" was wrong;
  (2) **VoIP.ms POSTs a JSON envelope** `data.payload.{from.phone_number, to[].phone_number,
  text, id, media[].url}` with `event_type: message.received` and leaves the query's `{FROM}`/
  `{TO}` placeholders LITERAL — the first tokened hit answered 200 and ingested NOTHING
  (`invalid_to` on the literal `{TO}`); `apps/api/src/voipMsWebhookPayload.ts` reads the
  envelope first, ignores other events with a 200, keeps the flat mapping as fallback
  (7 tests on the two REAL captured bodies, wiring guard reads 0 at HEAD); (3) **`setSMS` is a
  checkbox form — an OMITTED flag reads as UNCHECKED**: `webhook` alone flipped
  `webhook_enabled` 1→0 on the rehearsal DID; the re-arm parameter is **`webhook_enable`**
  (`webhook_enabled`/`url_callback_enable*` do nothing), one write per DID per minute
  (`sms_wait_message`). Fixup's write carried every other field and the getDIDsInfo diff
  shows ONLY `webhook` changed (routing/SMS/PBX callback/SIP-account/email/forward intact);
  PBX trunk `344022_fixupusa` Registered and T31_103 `Avail` after. ⛔ The first token printed
  unmasked in a psql column and was ROTATED (new secret in `GlobalVoipMsConfig`, URL file
  rewritten as `…/sms?token=<secret>` with no placeholders). ⛔ The other 5 pointed DIDs still
  401 on every text — arming them is the same script (`did-arm-webhook.ts` in the handoff)
  and Izzy's call. Backup of every DID's pre-write state:
  `loopcom:/root/voipms-webhook-20260907/dids-before.json`. ⏳ NOT PROVEN on Fixup's own
  number yet — acceptance is the next real inbound text: nginx `POST …/sms?token=… 200` +
  `SmsRoutingLog status=routed rawTo=8458067040`.
- ⛔ **Build trap:** the old EAS clone `/tmp/connect-ios-build` on loopcom is DEAD — every
  fetch, even from a bundle that `git bundle verify` calls okay, dies *"pack has N
  unresolved deltas"*. **Use `/tmp/connect-ios-build2`** (fresh clone of
  `/opt/connectcomms/app` + the bundle + the old clone's `node_modules` moved across —
  `app.config.ts` needs `expo/config-plugins` resolvable or EAS fails before upload).
  GitHub 401'd the server's pack fetch again; bundle route as documented.
- ⏳ **NOT PROVEN: no iPhone has answered a call on build 58.** Acceptance (handoff §4):
  lock the iPhone > 60 s, call, answer → `eager_preregister_stale_ios_force_restart` in the
  app log, a fresh `T31_103_1` REGISTER inside the ring, then the PBX dials it or telephony
  logs a `wake_leg` redirect, and a two-way conversation. Negatives: a FOREGROUND iPhone
  logs `…skipped_already_registered … appState=active`; desk answers still
  `answered_during_grace`; no `wake_leg` on ring-group calls. If a fresh REGISTER lands
  > 8 s after the tap, the next lever is `modeBFreshContactWaitMs` (telephony,
  0-active-calls deploy) — measure first.
