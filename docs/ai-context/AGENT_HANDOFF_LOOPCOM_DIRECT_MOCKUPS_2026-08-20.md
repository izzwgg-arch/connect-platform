# AGENT HANDOFF — "Loopcom Direct": cross-company chat by phone number + app-to-app video calls — PLAN AND MOCKUPS ONLY (2026-08-20)

Izzy, 2026-08-20: *"I want to add a video calling feature from LoopCom app to
LoopCom app and a chat feature for LoopCom customers that are not on the same
company, so they can chat with each other in LoopCom app via their phone number,
just like WhatsApp … and then I want to do video calling between LoopCom app's
web app and mobile app."* Asked whether it was possible; answered yes; he then
asked for **both** the concrete plan and the mockups.

**⛔ NOTHING IS BUILT. No code, no migration, no deploy, no data change.** The
deliverable is the plan + mockups artifact:
<https://claude.ai/code/artifact/d1d6e1f8-4be9-4aed-9c63-69c7781b0c2e>
("Loopcom Direct" is a working name only.)

## §1 The four-phase plan (each ships alone; order is load-bearing)

1. **US media server** (~2–3 days + server cost). The LiveKit video engine from
   Loopcom Meetings (`43b0ab7f`, see
   `AGENT_HANDOFF_VIDEO_MEETINGS_2026-08-20.md`) runs on loopcom in FRANCE;
   NY↔NY video pays the ocean twice. This is the US VPS Izzy already approved in
   July for the TURN relay — one box, both jobs. Moving LiveKit is a config
   change (`LIVEKIT_URL` + livekit.yaml + DNS/nginx on the new box), never a
   rebuild. It also unlocks TURN-over-TLS on 443 for strictly-filtered offices
   (impossible on loopcom — nginx owns 443).
2. **Mobile meeting join** (~1–2 weeks + app build). LiveKit has an official
   React Native SDK; add it to apps/mobile, build the meeting screen, ship
   APK + TestFlight (⛔ app builds always need Izzy's word). ⛔ **The moment the
   app can join a LiveKit room, web↔mobile video exists with zero extra work** —
   both are just participants in the same room.
3. **Ring-a-person video calls** (~1–2 weeks + app build). "Tap a person, their
   phone rings into video." Under the hood: create a meeting + push an invite
   over the SAME machinery that rings voice calls today (INCOMING_CALL push →
   IncomingCallScreen / CallKit / lock screen; `apps/mobile/src/sip/voipPush.ts`,
   `callkeep.ts`, `screens/call/IncomingCallScreen.tsx` all exist). Decline /
   missed / answered-elsewhere reuse the voice plumbing. ⛔ Every lesson from the
   voice ring path applies (cancel-push race, deferred actions re-verifying at
   fire time, Telecom anchor teardown — read those handoffs before building).
4. **Cross-company DM by phone number** (~3–4 weeks + app build). The WhatsApp
   piece, and the structurally new one — see §2.

Phase 4b (deliberately later, not v1): a number NOT on Loopcom falls back to a
regular SMS from the sender's business number, so "message anyone" never
dead-ends. All SMS plumbing exists; it is drawn in the mockups as a labelled
follow-up.

No new vendors, no per-minute bills. Only new recurring cost = the US VPS
(~$40–80/mo), already planned.

## §2 Why the DM half is a real architecture addition, not a chat tweak

⛔ **Every `ConnectChatThread` has a required `tenantId` and every chat route is
tenant-scoped** — that is the tenant-isolation posture the whole 2026-08 audit
series hardened, and a WhatsApp-style thread deliberately lives BETWEEN
companies. Do not bolt this onto the existing DM type: it needs its own thread
scope (or a new model) with its own routes, its own permission story, and its
own privacy rules, designed on purpose. What gets REUSED: the chat screens,
message storage shape, push notifications, read/unread + markedUnread machinery,
the 6-digit-code verification pattern (the login-OTP work), and the blocking
concept. What is NEW: cross-tenant identity, the number directory, discovery,
requests, blocking, and the thread scope itself.

## §3 The three decisions — Izzy's, all still OPEN

1. **Who can start a chat with you** — A open (message lands directly, block on
   the banner), **B message requests (recommended; first message waits in a
   Requests tray, no read receipts until accepted, prior contacts pass
   through)**, C invite-only (mutual accept before any text travels). All three
   are drawn in the artifact with a tab switcher.
2. **Which number is "you"** — recommended: **verified personal cell** (one-time
   text code, WhatsApp-style), with the company shown on the profile card.
   ⛔ A company DID is often a SHARED inbox — "which person answers?" gets murky,
   which is why it is not the recommendation.
3. **Rollout** — recommended: **opt-in by verification** (nobody is findable
   until they verify — day one, nothing changes for anyone who does nothing) +
   a per-company off switch. Matches the platform's every-switch-ships-off
   convention.

## §4 Mockups in the artifact (what each screen establishes)

- **New chat by number**: found-on-Loopcom card (name + company + "On Loopcom"
  pill, so you know you have the right person BEFORE sending) vs
  not-on-Loopcom (SMS fallback drawn as Phase 4b, invite button in v1).
- **First contact ×3** (the A/B/C tabs): the RECIPIENT's view in each model —
  the Requests tray in the chat list, the request open-state ("Rivky can't see
  that you've read this", Accept/Decline/Block), the option-A banner, the
  option-C invitation wall.
- **The connected chat**: company subtitle in the header, voice + video buttons,
  finished calls landing in the thread as events (one history).
- **Incoming video call** ring screen + **in-call** mobile screen (mute /
  camera / flip / end, self PiP) — Phase 3 and Phase 2's screens.
- **Web side**: the /meet room with a phone participant tile — establishes that
  a 1:1 video call and a meeting are the same machinery at different sizes.
- **Privacy**: one settings screen (findable toggle showing the verified
  number, requests toggle, blocked list) + the verify-your-number code screen.
  The rule stated on-screen: **the moment you verify is the moment you become
  findable, never before.**

## §5 What to do when Izzy answers

Green-light order: buy the US box (phase 1) → mobile meeting join (phase 2) →
ring-a-person (phase 3) → DM build per his A/B/C + identity + rollout picks
(phase 4). Phases 2–4 each end in an app build, so batch releases sensibly.
⏳ Until he picks, nothing here is authorized to build.
