# 2026-09-16 · UNIFIED MESSAGING (SMS/MMS/RCS/WhatsApp/Messenger over Telnyx/SignalWire/VoIP.ms) — BUILD APPROVED; PHASE 1 (Messaging Router + Telnyx) BUILT

## ✅ PHASE 1 BUILT (same day, after the approval): the Messaging Router + Telnyx chat wiring
**What exists now (all tested; deploy state recorded below):**
- **`apps/worker/src/messagingDispatch.ts`** — the provider REGISTRY that
  replaced the inline `if (provider === "SIGNALWIRE")` at connectChatSmsJob.ts:116.
  SIGNALWIRE + TELNYX resolve adapters; VoIP.ms (and any unknown value, exactly
  as before) is the job-body fallthrough, byte-identical. Source-guarded; the
  old guard in signalWireChatSend.test.ts was updated to the registry shape and
  the new guards FAIL replayed against pre-change HEAD.
- **`packages/integrations/src/telnyxSms.ts`** — `TelnyxSmsProvider`
  (POST /v2/messages, Bearer, `telnyx:<uuid>` prefixed ids, 10-media chunking,
  1600-char body chunks, 30s timeout, TELNYX_* error taxonomy,
  `SIMULATE_PROVIDER_FAILURE_TELNYX` chaos hook mirroring the SignalWire one).
- **`apps/worker/src/telnyxChatSend.ts`** — the TELNYX adapter, mirroring
  signalWireChatSend: original audio (⛔ NO MP4 conversion), MMS→signed-link
  fallback, creds from AgentSecret `telnyx_credentials` (env TELNYX_API_KEY dev
  fallback). ⛔ TELNYX_NOT_CONFIGURED THROWS `__configError` so the job can try
  the backup route; with none it stamps failed WITHOUT BullMQ retries.
- **PROVIDER-LEVEL BACKUP ROUTE** (`TenantSmsNumber.fallbackProvider`, null =
  today's behavior for every existing row): fires ONLY on an error whose
  `__anySent === false` EXPLICITLY — a partial delivery or an unflagged error
  is NEVER re-sent (one message, one delivery). All three send paths attach the
  flag (VoIP.ms via a transparent `trackVoipMsAcceptance` wrapper; the two
  adapters set it at each acceptance). `attemptProviderFallback` is
  dependency-injected and 8 behavior tests pin every rule. ⛔ VOIPMS as a
  backup TARGET is deliberately unsupported yet (needs the VoIP.ms path
  extracted from the job body). Success stamps
  `metadata.{sentViaBackupRoute,backupCarrier,primaryCarrier,primaryError}` —
  customer UI wording is "sent via backup route", carrier names platform-only.
- **`apps/api/src/telnyx/telnyxWebhooks.ts`** — `/webhooks/telnyx/sms`:
  Ed25519 fail-closed (reuses `verifyTelnyxSignature` from the LoopCom-Mobile
  door; public key stored with the bench credentials), `message.received` →
  the ONE shared ingest (`telnyx:` prefix, media urls), `message.finalized` →
  FINAL states only (delivered / failed family + TELNYX_<code>),
  `message.sent` writes NOTHING (never downgrade delivered — the SignalWire
  rule), post-auth always 200 (dedupe is the safety, not the status code).
  Registered in server.ts beside registerTelnyxRoutes; jwtPublicRouteBypass
  entries added (alignment test 12/12).
- **Migration `20260916170000_messaging_telnyx_fallback`** — additive:
  `IntegrationProvider` + TELNYX, `TenantSmsNumber.fallbackProvider`.
- **Tests: worker 186/186; api telnyx 27/27 (11 new webhook tests sign with a
  REAL Ed25519 keypair), sms 20/20, bypass 12/12.** One test caught a real
  defect pre-commit (backup fired on an unflagged error; now explicit-false
  only). Full detail in TESTS_RUN.md.
- ⛔ **Worktree hazards handled during this increment, worth knowing:** the
  shared worktree's schema.prisma was a 1,990-line pure REORDER by another
  session (same 333 models both sides — verified by inventory count, not
  assumed); my schema change was re-applied onto HEAD's copy so the commit
  stays +11 lines. TESTS_RUN.md's worktree copy was STALE vs HEAD with two
  in-flight entries mixed in — rebuilt from HEAD + their entries + mine
  (backups of both in the session scratchpad).
- ✅✅ **DEPLOYED AND LIVE-PROVEN 2026-09-16 (~16:15Z).** api blue/green `done
  287a32e6`, container commit verified, health 200; migration
  `20260916170000` read back from the LIVE DB (row finished, `fallbackProvider`
  column present, TELNYX in the enum); `/webhooks/telnyx/sms` answers **401
  fail-closed on BOTH local :3001 and the public hostname** and the route file
  is in the container. ⛔⛔ **The worker deploy self-skipped on a FALSE
  BASELINE** — the api deploy had already reset the server checkout to my
  commit, so deploy-worker diffed `287a32e6..2ac9e9fc` (another session's
  push) and said "no worker-relevant paths changed" while the CONTAINER still
  ran the old code (verified: no messagingDispatch.ts inside). This is the
  deploy-said-success family with a new face: **after ANY worker deploy, check
  the file in the container, never the word "done".** Fixed with
  `DEPLOY_FORCE_RESTART=1` at the origin TIP (2ac9e9fc, my commit an
  ancestor); container then verified to carry messagingDispatch.ts,
  telnyxChatSend.ts and the registry call.
  **Live proof on real traffic:** the new worker's VoIP.ms poll fetched real
  customer texts minutes after cutover (fetched=3 on one DID), and a REAL
  round-trip probe ran through the NEW dispatch: `/internal/chat/sms-system-reply`
  → shared thread `cmspgyxhswgz8n0214ga2aq52` (+18455577768 ↔ +18457231213,
  Connect's own numbers) → worker `voipms_sms_part_send` → **sent, VoIP.ms id
  111471089, 16:15:10Z** → carrier delivered → polled back as INBOUND
  `voipms:111471092` at **16:15:42** — 32 seconds, no duplicates.
- ⏳ **STILL NOT PROVEN:** no TELNYX-provider TenantSmsNumber row exists yet,
  so no live send THROUGH TELNYX; the Telnyx messaging profile has no webhook
  URL configured and the account's Ed25519 public key isn't saved in the bench
  credentials, so no real Telnyx inbound/DLR has flowed; no number has a
  `fallbackProvider` set, so the backup route has never fired in production
  (it is proven by its 8 behavior tests only). Wiring those + a round-trip on
  (845) 306-6825 is the next acceptance test.
- **Next phases:** RCS (bench send exists; chat wiring + composer), portal UI
  additions (frozen-look rule) + permission toggles for every new page/feature
  (his 2026-09-16 requirement: toggles in custom roles on EVERYTHING),
  WhatsApp (⛔ fix the schema drift FIRST), Messenger, GIF/sticker picker
  (RCS: native GIFs; WhatsApp: real .webp stickers; Messenger: both; SMS→MMS
  gif degrade — Izzy asked "wire them all in", 2026-09-16; needs a GIF search
  provider decision, Tenor is the default candidate), mobile, then the full
  stress/soak/chaos + proof package.

# (Original design record follows — MOCKUPS approved 2026-09-16)

## ⛔⛔ REVISION 3 (same day) — SECOND STANDING RULE: NO CARRIER NAMES FOR CUSTOMERS, and THE BUILD IS APPROVED
Izzy: *"The customer should never see the word Telnyx or wire, signal wire, or
web.mx [VoIP.ms], nothing."* Then: *"for all the features you just added, I'm
going to add working toggle permission inside the custom role on everything,
and I want proof that they're all working: rock solid… stress-tested. Go
ahead, build the whole thing end-to-end."*
- ⛔⛔ **No customer surface ever names a carrier** — not in the chat header
  ("via (845) 555-0164", no provider), not in the meta line (failover says
  **"sent via backup route"**), not in message info (customer tier shows
  Route: Primary/Backup; carrier names + provider message ids live ONLY behind
  a locked "Carrier details — platform staff only" expander), not in
  notifications, not in system lines (a carrier switch is INVISIBLE in the
  thread; it's recorded in admin Routing history). The ONLY screens that name
  Telnyx/SignalWire/VoIP.ms are the platform-staff routing/matrix/migration
  pages. Mockup v3 (same artifact, Version 3) reflects all of this.
- ✅ **BUILD APPROVED 2026-09-16** with two more requirements: permission
  toggles in custom roles for every new page/feature (the FOURTH RULE applies
  to all of it), and evidence-backed stress-tested proof before anything is
  called done.

## ⛔⛔ REVISION 2 (same day) — IZZY'S STANDING DESIGN RULE FOR THIS WHOLE PROJECT
Izzy, verbatim: *"do not change any of the existing looks. Just add the new
features and divide it the way the user sees it when they use RSC [RCS] or not.
You can change the type color messages to green, that's okay… but the actual
layout, the way it is right now, the message bubble, just don't change anything,
any of that. I worked hard on that."*
- ⛔ **The current chat layout, bubbles, composer pill, thread rows, plus-menu
  and meta line are FROZEN.** Every upgrade is ADDITIVE: new chip colors in the
  existing chip slot, new words in the existing meta line, new rows in the
  existing plus-menu, one optional suggestion-chip row above the composer, and
  channel color tints on own-bubbles/send button (color only — his explicit OK).
- **The RCS divide** = the SAME plus-menu grows a "Rich messaging" group only on
  RCS-capable conversations; WhatsApp gets a Templates row; Messenger neither.
  Never a new toolbar, never per-channel screens.
- ✅ Mockup v2 rebuilt as a FAITHFUL reproduction of the live chat (markup
  mirrors apps/portal/components/chat/*, CSS values copied from globals.css —
  compact crm-queue-workspace pass at 33854+/34766+, composer 35406+, attach
  menu 35656+, bubbles/meta/voicenote 19053+, cc-state 37831), with every
  addition wearing a toggleable dashed "NEW" marker. Same artifact URL
  (4JJZYVHE9KKkQ1XpQm3eQe, Version 2).
- ⛔ When BUILDING: do not restyle any `.cc-*` class; additions ride the
  existing idioms (rich card = attachment-stack idiom inside the bubble,
  states = words in `.cc-msg-meta`, `.cc-error` already exists). A guard test
  reading the chat CSS/source for unchanged bubble/composer geometry is worth
  writing on day one of the build.

Izzy's brief (2026-09-16, in full in the session): upgrade Loopcom Chat into a
provider-agnostic unified inbox — SMS, MMS, RCS, WhatsApp, Messenger over
Telnyx (preferred), SignalWire, VoIP.ms — one canonical conversation model,
capability registry per adapter, primary/fallback routing, per-number provider
config, boring migration (a number moves VoIP.ms→Telnyx keeping thread/history/
attachments/CRM), iPhone + Android app upgrades, NO store publishing, mockups
first, then implement, then "stress test the fuck out of it" with a full proof
package. **The explicit sequencing is his: mockups → approval → build.**

## What exists in this session
- ✅ **Complete mockup set**: `docs/mockups/unified-messaging/index.html`
  (single file, portal tokens dark-first, theme toggle), artifact
  **4JJZYVHE9KKkQ1XpQm3eQe**. 14 web screens (unified list W1, SMS/MMS W2,
  WhatsApp 24h-window + template picker W3, Messenger W4, mixed-channel
  contact history with a provider-migration system line W5, adaptive composer
  W6, RCS card builder with MMS/SMS fallback preview W7, carousel W8,
  suggestions editor W9, pickers W10, message-info state-machine drawer W11,
  failure/fallback chips W12, admin per-number routing + resolution order +
  provider health W13, migration flow + capability matrix W13b, states W14)
  plus iPhone M1–M5 and Android A1–A3 frames. Every screen carries a rationale
  paragraph; a coverage checklist maps Izzy's requested screen list to screen
  numbers.
- ⏳ **NOT approved, NOT built.** No code, no schema, no deploy. Do not start
  implementation before Izzy approves the mockups (his explicit gate).

## The codebase truth the design is built on (verified this session, 2 Explore reports)
- **One canonical model already carries live traffic** — extend it, never fork:
  `ConnectChatThread/Message/Participant/Attachment/Reaction`
  (packages/db/prisma/schema.prisma L4580–4908; ⛔ schema is in packages/db,
  NOT apps/api). Thread types SMS|DM|GROUP|TENANT_GROUP|WHATSAPP;
  `ConnectChatMessage` already has `externalProvider/externalMessageId/
  externalConversationId/providerStatus/providerMetadata` (mostly unused —
  the natural landing zone for the canonical model).
- **Provider abstraction exists in embryo**: `TenantSmsNumber.provider`
  (VOIPMS default, SIGNALWIRE live) + `voipmsAccountId`; ONE outbound door
  `sendConnectChatSmsMessage()` (connectChatRoutes.ts:640, BullMQ `sms-send`);
  ONE inbound registry `smsInboundIngest.ts` → `ingestInboundSmsToChat()`
  (connectChatRoutes.ts:2499) with providerMessageId dedupe. ⛔ Outbound
  worker dispatch is a hardcoded if(SIGNALWIRE)else-VoIP.ms at
  `apps/worker/src/connectChatSmsJob.ts:116` — that's the seam to replace with
  the adapter registry.
- ⛔ **The worker poll path duplicates the ingest tail**: `importInboundMessage()`
  in `apps/worker/src/voipMsInboundSyncJob.ts:450` is a parallel copy of
  thread/participant/push logic (and `smsInboxParticipants.ts` exists twice,
  api + worker). Unifying these is part of the build, carefully.
- **No realtime anywhere**: portal polls 7s, mobile 5s, desktop bridge 30s,
  `apps/realtime` is a 43-line unused echo server. The upgrade plans a real
  event channel; polling stays as the fallback.
- ⛔ **VoIP.ms has NO delivery receipts** — the mockups show "Sent" max on
  VoIP.ms numbers with a plain-language note; never render "Delivered" there.
  Telnyx/SignalWire have DLRs; RCS/WA/Messenger have read receipts.
- ⛔ **Telnyx has ZERO chat wiring** — bench-only (`apps/api/src/telnyx/`,
  admin send + RCS panels, no inbound webhook). Wiring Telnyx into chat is
  net-new work.
- ⛔ **WhatsApp is simulated + schema-drifted** (see
  2026-08-16-the-whatsapp-integration-cannot-send-and-its-pro.md): no
  transport, 6 unmigrated models, `WHATSAPP` enum value missing in prod DB,
  projection would crash. The 24h-window policy engine
  (`apps/api/src/whatsapp/sendPolicy.ts`) is real and pure — reuse it.
- **Messenger**: nothing exists at all.
- **Mobile is an upgrade, not a rebuild**: `apps/mobile/src/screens/tabs/ChatTab.tsx`
  (3,589 lines) already does DM/SMS, attachments, voice notes, reactions,
  reply/edit/delete, typing, location, deep links. Expo SDK 54, RN 0.81.5,
  EAS profiles in eas.json; OTA disabled by owner directive.
- ⛔ **Preserve-at-all-costs consumers of the one send door**: SMS↔email
  bridge (drives the REAL `POST /chat/threads/:id/messages` +
  `/internal/chat/sms-system-reply`), CRM sms routes, funder routes,
  supportConsole/supportReport, shared-inbox rules
  (`packages/shared/src/smsInbox.ts` — inboxScope is PART of the thread
  dedupeKey). Any router change must keep these byte-compatible.

## Design decisions embedded in the mockups (so the build matches)
- Channel badge on the avatar = conversation property; provider chip in
  header/rail = number property. **Never separate inboxes per provider.**
- Composer is GENERATED from the capability registry; unsupported tools are
  greyed with a why-tooltip (no dead buttons) or hidden on mobile sheets.
- Message state machine: queued → sending → provider_accepted → sent →
  delivered → read; failures: temporary_failure / fallback_in_progress /
  fallback_sent / permanent_failure. **A tick renders ONLY from a normalized
  provider event.**
- Fallback = ONE delivery ever (claim-based dispatch); the bubble carries a
  "via X (fallback)" or "Sent as SMS (RCS unavailable)" chip; message-info
  drawer shows the full timeline + raw provider metadata.
- RCS builders preview MMS and SMS degradation BEFORE send; RCS limits
  (10 carousel cards, 11 chips, 4 buttons) enforced in the editor.
- Routing resolution: number override → tenant default → global default, plus
  per-message manual override; migration screen has an always-visible
  rollback and a 48h poll-overlap safety net for VoIP.ms→Telnyx moves.
- WhatsApp window countdown banner; expired window swaps composer to the
  approved-template picker (never a silent failed send).

## Next steps (in order, each gated)
1. Izzy reviews the mockups → changes or approval.
2. On approval: architecture doc + schema migration plan (additive), then the
   Messaging Router + adapter registry replacing the worker if/else, Telnyx
   SMS/MMS adapter + inbound webhook first (it's the preferred provider),
   then RCS, then WhatsApp (migration first — the drift), then Messenger.
3. Mobile + web UI after the backend contract stabilizes; test builds only,
   NO store publishing.
4. The proof package Izzy specified (feature matrix, click inventory, load/
   soak/chaos, migration + RCS fallback tests) before any "done".
