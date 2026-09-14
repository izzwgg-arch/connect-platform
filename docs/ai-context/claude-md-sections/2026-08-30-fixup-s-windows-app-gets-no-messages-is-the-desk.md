# ⛔ AGENT HANDOFF — FixUp's "Windows app gets no messages" is the desktop notifier only firing on NEW threads, and "the SMS group" is a VoIP.ms limitation (2026-08-30) — READ FIRST for ANY "the desktop app doesn't get texts" report or ANY group-text question

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FIXUP_SMS_COMPLAINTS_2026-08-30.md`**
(**Read-only investigation — no code, no deploy, no data change, no carrier write.**)
Memory: [[desktop-sms-notification-only-fires-on-new-threads]].

- ⛔⛔ **`DesktopNotificationsBridge.tsx` notifies only when a NEW THREAD ID
  appears** — a new message in an existing conversation fires NO Windows
  notification, ever, while the phones buzz on every one. That asymmetry IS the
  complaint. Only the full window polls (`windowKind !== "full"` early-return);
  mini-dialer-only setups get nothing. Ingestion itself is CLEAN — every carrier
  row since 08-24 landed in Connect (proven by read-only getSMS/getMMS diff).
  ⏳ Fix (watch `lastMessageAt`, dedupe on message id) designed, NOT built.
- ⛔⛔ **Group texting on a Connect number is IMPOSSIBLE on VoIP.ms — their staff
  say so in writing** ("does not include group interaction"). Inbound group
  messages arrive as bare 1:1s (no group metadata; some arrive EMPTY at the
  carrier), replies go 1:1 — the customer's own text says it: *"The arrived
  Message to me in private."* Connect has no group-SMS model either (`type:"sms"`
  = one externalPhone). **Not our bug; nothing to build on VoIP.ms.** If group
  texting ever matters commercially it is a carrier pivot question (Telnyx
  documents group MMS — up to 8 participants, replies stay in the group;
  SignalWire VERIFIED NO 2026-08-30: every send API is single-`To`, no group
  endpoint exists, and their "Number Groups" is a sender pool, not group chat —
  10DLC approval does not change this).
- ✅✅ **BOTH FIXES ARE BUILT (`78e6d827`, 2026-08-30 — deploy state in the
  handoff §8): MMS media is UNCAPPED both directions, and desktop
  notifications fire per MESSAGE in EVERY desktop window.** Inbound:
  `parseMediaUrls` scans every `col_mediaN` key (was 1..3 + slice-to-3 — the
  photo loss); the mirror resumes by COUNT; the metadata backfill grows.
  Outbound: >3 attachments ship as **ceil(n/3) MMS messages** —
  `MMS_MEDIA_PER_MESSAGE = 3` is VoIP.ms `sendMMS`'s media1..3 parameter
  surface, the carrier's shape, never ours; body on the FIRST chunk only; a
  failed chunk is never re-sent and the link fallback covers ONLY undelivered
  attachments. Notifications: `decideMessageToasts` keys on (threadId,
  lastAt) from **`/chat/threads`** — ⛔ never `/sms/messages`, which collapses
  every inbound thread into one entry keyed by the tenant's OWN number — the
  first poll is a silent baseline, and the bridge runs in full + mini + phone
  engine (cross-window dedupe = the shared localStorage guard). The mini's
  tab bar carries per-tab unread pills (`tabBadges`).
  ⛔ **Group texting stays a CARRIER limitation** — the design answer (§9 of
  the handoff): broadcast-fanout groups are cheap and safe; a TRUE group
  experience needs a dedicated DID per group; ⛔ never relay on the main
  number (a member's private text is indistinguishable from a group reply).
