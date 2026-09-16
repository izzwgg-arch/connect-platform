# 2026-09-16 · UNIFIED MESSAGING (SMS/MMS/RCS/WhatsApp/Messenger over Telnyx/SignalWire/VoIP.ms) — MOCKUPS ONLY, awaiting Izzy's approval; NOTHING BUILT

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
