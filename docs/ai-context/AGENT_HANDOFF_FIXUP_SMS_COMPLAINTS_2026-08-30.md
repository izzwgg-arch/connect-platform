# AGENT HANDOFF — FixUp Group's two SMS complaints: the Windows app only notifies on BRAND-NEW threads, and "the SMS group" is a native iPhone group text VoIP.ms cannot do (2026-08-30)

**Read-only investigation — no code change, no deploy, no PBX write, no data change,
no carrier write.** Every claim below was measured on 2026-08-30 against the live
database, the live VoIP.ms API (read-only getSMS/getMMS), and the shipped source.

Izzy, 2026-08-30: *"FixUp group had two complaints: (1) their Windows app is not
getting any incoming messages, or some of them. (2) somebody created the SMS group;
when he sends messages to the group, only he gets it because he created it."*
Context he gave: one extension, several devices — Windows, Android, iPhone.

Tenant **Fixup Group** `cmqr9cs9402qqs013m7p64lpi`, ONE user `fixupusa1@gmail.com`
(`cmqs0t62s0kz9mk133y509003`), SMS number **+1 845 806 7040** (tenant default,
unassigned → shared-inbox shape but with one user it behaves personal).

## 1. Ingestion is CLEAN — nothing is lost between the carrier and Connect

Compared VoIP.ms `getSMS` + `getMMS` for DID 8458067040 (since 08-24) against
`ConnectChatMessage`: **6 SMS + 8 MMS at the carrier, every one present in
Connect** with matching provider ids. Delivery to the platform is not the problem.
Probe recipe: script into `/app/apps/api/`, creds from
`GlobalVoipMsConfig(id="default")` via `decryptJson`, `npx tsx`.

## 2. COMPLAINT 1 — the Windows desktop app notifies ONLY when a brand-new thread appears

`apps/portal/components/DesktopNotificationsBridge.tsx` `applySmsNotifications()`:

```ts
const newest = threads.find((thread) => !previous.has(thread.id));
```

It diffs the **set of thread IDS** every 30 s. A new message in an EXISTING
conversation changes no thread id, so it produces **no desktop notification, ever**.
Only the first-ever message from a brand-new phone number fires one. FixUp texts
the same few numbers all day (the +18453240113 thread holds 12 messages), so from
their chair the Windows app "doesn't get incoming messages" — while the phones
buzz on every one (worker `sendSmsPushNotification` fan-out; his Android has a
`nativeFcmToken`, both iPhones have Expo + APNs tokens — all verified healthy).

⛔ Also: the bridge runs only in the FULL desktop window
(`windowKind !== "full"` returns early) — a mini-dialer-only setup gets no SMS
notifications at all. And browser tabs get none by design (`isDesktop` gate).

**The fix, when mandated (portal-only):** track per-thread `lastMessageAt` (the
threads list already carries it) instead of only the id set, and notify when an
existing thread's newest inbound moves — dedupe on message id via the existing
`alreadyNotified()` localStorage guard so multiple windows/reloads fire once.
NOT built — this was a read-only pass.

## 3. COMPLAINT 2 — the "SMS group" is a native iPhone group text, and VoIP.ms has NO group messaging. Not our bug, and not fixable on VoIP.ms

- Connect has no group-SMS model at all: `POST /chat/threads` type `"group"` is
  INTERNAL only (tenant users + extensions — FixUp has one user), and type
  `"sms"` takes exactly one `externalPhone`. Nobody created a group in Connect —
  the tenant has zero GROUP threads. The group was created on someone's iPhone
  (native Messages group MMS) with the Connect number 845-806-7040 as a member.
- **The evidence is in their own thread:** inbound *"@ shlome to which email did
  you send the credit card?"* (group-mention style, delivered as a plain 1:1
  from 845-324-0113 with no group metadata — VoIP.ms rows carry only `did` +
  `contact`, nothing about other recipients), and after FixUp replied, the
  customer texted *"The arrived Message to me in private I guess message him
  private"* — the reply reached one person instead of the group.
- **VoIP.ms is official about it.** Staff (William) on their community forum:
  *"SMS/MMS capabilities does not include group interaction, currently only a
  traditional usage is offered."* Community describes FixUp's exact symptom:
  "Why aren't you responding to the group text chat?" Group texts arrive (at
  best) as individual 1:1s; replies go out as individual 1:1s. No feature
  request has moved as of late 2025.
  <https://community.voip.ms/t/group-mms-avalability-and-capability/230>
- Two inbound messages in the group window arrived **completely EMPTY** (TEXT,
  no body, no media — voipms:10132334, voipms:10158521; empty at the CARRIER
  too, so we did not lose them). That is the shape of group-MMS artifacts /
  tapbacks / contact cards mangled on VoIP.ms's side — content genuinely lost
  upstream of us, which also feeds "some messages don't arrive".
- **What to tell FixUp:** the Connect number cannot participate in group texts —
  that is the carrier, not the app. Group members should text the number
  directly (1:1). ⛔ If group texting becomes a real requirement, it is a
  CARRIER decision: Telnyx documents group MMS; whether SignalWire supports it
  was NOT verified — check before promising anything on the pivot.

## 4. Found in passing — inbound MMS with more than 3 attachments silently drops the rest

Carrier message voipms:10166591 (08-28, from 845-324-0113) carried **5 images**
(`media` array / col_media1..5); Connect stored **3**. `parseMediaUrls` in
`apps/worker/src/voipMsInboundSyncJob.ts` caps at `.slice(0, 3)` on the array
branch (and reads only col_media1..3). The 3-cap matches the OUTBOUND sendMMS
limit but there is no reason to cap what we RECEIVE. Two of that customer's five
photos never reached FixUp — a literal "some of the messages don't arrive".
NOT fixed — one-line-ish worker change plus mirror check, needs its own pass.

## 5. What was ruled out (don't re-derive)

- Carrier→Connect loss: none (§1). Email forwarding: healthy, every inbound
  stamped `emailForwardedAt` (user has SMS-to-email ON, so he also gets emails).
- Push tokens: all 3 active devices healthy (Android FCM SET; 2× iPhone 17 Pro
  with Expo + APNs). The worker's `expoPushToken != null` pre-filter does not
  bite him — Expo tokens are set.
- `lastLoginAt` 2026-08-05 is NOT staleness — outbound messages sent daily; no
  fresh login is normal.

## 6. Acceptance / next steps (each needs Izzy's word)

1. Confirm with FixUp whether "not getting messages" means **no notification**
   (expected: message IS in the app when they open the thread) — that pins §2.
2. Mandate the desktop-notification fix (§2) — portal-only deploy.
3. Mandate the inbound-MMS media cap fix (§4) — worker deploy.
4. Tell the customer the group-text answer (§3) — nothing to build on VoIP.ms.
