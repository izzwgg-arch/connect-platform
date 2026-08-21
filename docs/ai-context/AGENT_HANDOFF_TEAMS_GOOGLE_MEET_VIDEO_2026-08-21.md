# AGENT HANDOFF — can Loopcom integrate Teams / Google Meet VIDEO? Mostly NO, and the reasons are structural (2026-08-21)

**RESEARCH ONLY — no code, no account, nothing filed.**
Izzy, 2026-08-21, asked whether Loopcom could integrate **Microsoft Teams** and
**Google** — and when asked what he pictured, answered **"Video calling and
meetings"** and **"Google Meet"**.

⛔ **Read §1 first. The headline is a NO, and it is a structural no, not a
paperwork no** — which makes it different from every other item in
`AGENT_HANDOFF_PLATFORM_AUTH_PROGRAM_2026-08-21.md`, where the gates were
verification and lead time.

## 1. THE HEADLINE: THIRD-PARTY VIDEO INTEROP IS CLOSED ON BOTH PLATFORMS

Loopcom **cannot** put its own video into a Teams meeting or a Google Meet, and
cannot host a Teams/Meet call inside Loopcom. Both vendors reserve that to a
short list of named partners.

- ⛔⛔ **Google Meet Media API is RECEIVE-ONLY, and it is enforced in SDP
  negotiation — not a policy you can appeal.** Verbatim: *"All conference media
  streams are 'receive-only'. Currently, the Meet Media API does not support
  sending of media… into a conference."* It has also sat in **Developer Preview
  for 18 months**, **every participant must be enrolled in the preview**, and
  the Developer Preview Program terms **prohibit productising it**. There is no
  version of this that ships to customers.
- ⛔ **Google Meet SIP interop is Pexip-only.** Google: *"To use Meet with
  third-party systems, you need to use the Google Workspace partner product
  Pexip Connect for Google Meet."* Interop tokens require choosing a vendor from
  a **fixed dropdown (Pexip / Zoom / Webex)** — there is **no "Other"** and no
  self-service path.
- ⛔ **Teams: a deep link cannot start a meeting.** Verbatim: *"This method
  can't be used for invoking a meeting."* The Teams equivalent of Pexip is the
  **Cloud Video Interop** partner programme (Pexip, Poly RealConnect, Cisco).
  ⚠️ **NOT independently verified in this pass** — treat CVI's current status
  and whether it accepts new partners as an open question, but the shape matches
  Google's: partner-gated, enterprise-scale.
- ⛔ **Teams apps are explicitly unsupported in end-to-end encrypted Teams
  calls**, instant channel meetings, and shared-channel meetings.
- ⛔⛔ **DO NOT BUILD A HEADLESS-BROWSER MEETING BOT.** Google's Meet Acceptable
  Use Policy says verbatim: *"Do not automate Google's system to place phone
  calls or send messages automatically."* A general SaaS might argue the edges;
  ⛔ **a company whose product IS automated calling cannot.** This is the single
  most tempting shortcut here and it is the one that puts the Google account at
  risk.

⛔ **AND REMEMBER LOOPCOM ALREADY OWNS VIDEO** — Loopcom Meetings on self-hosted
LiveKit is live end to end
([[loopcom-meetings-built-on-livekit]], `AGENT_HANDOFF_VIDEO_MEETINGS_2026-08-20.md`).
The question is therefore **interop**, not capability. Nothing below replaces
what already works.

## 2. WHAT IS ACTUALLY POSSIBLE — three real integrations

### 2a. ⭐ Dial INTO a Google Meet by phone — the one clean win
✅ **`phoneAccess[]` went GA on 2026-04-16.** The Meet Space resource now exposes
the meeting's **dial-in `phoneNumber` (E.164) and `pin`** as output-only fields.
**So Loopcom's Asterisk can originate a call to that number and send the PIN as
DTMF** — a Loopcom user joins a customer's Google Meet from a desk phone or the
Loopcom app, using infrastructure Loopcom already runs.
- ✅ **No bot, no preview programme, no ToS grey area** — Google sees an ordinary
  inbound phone call.
- ⛔ **`phoneAccess[]` is EMPTY on Business Starter and when the admin has not
  enabled dial-in.** Branch on that explicitly or it becomes the top support
  ticket ("it works for some customers and not others").
- Teams meetings have dial-in numbers too, but only when the tenant has Audio
  Conferencing — same conditional-availability trap.

### 2b. Create/schedule the meetings
- **Google Meet:** ⛔ do NOT use the Meet REST API for this — `spaces` is the
  only writable resource and `spaces.create` is capped at **100/min per project
  platform-wide**. Use the **Calendar API with `conferenceDataVersion=1`**, which
  makes the *user* the conference owner and has no app-ownership constraint.
  ⛔⛔ **Omit `conferenceDataVersion=1` and the conference is SILENTLY DISCARDED
  with a 200 OK** — the classic failure here.
  ⛔ Appearing in Calendar's *"Add conferencing"* dropdown beside Zoom requires a
  **Google Workspace Add-on** (`conferenceSolution` in an Apps Script manifest),
  which means a Marketplace listing — and **private publishing does NOT skip
  OAuth verification**.
- **Teams:** Graph can create a meeting and return its join link.

### 2c. Show Loopcom context INSIDE a meeting
- **Google Meet Add-ons SDK** — a side-panel iframe during the call, on all
  editions. ⛔ `getMeetingInfo()` returns only `meetingId`/`meetingCode` — **no
  roster, no audio**. Excluded for non-signed-in participants and encrypted
  meetings.
- **Teams meeting extensions** — pre-meeting tab, in-meeting dialog, side panel,
  stage, post-meeting. Same ceiling: CRM context, not media.
- ⛔ Teams meeting **AI insights** APIs require a **Microsoft 365 Copilot**
  licence.

### 2d. The heavy option, for completeness — a Teams calling bot
Graph `/communications/calls` lets **a bot join a meeting as a participant**
(app-hosted media needs `Calls.AccessMedia.All`). This is how recording bots
work. ⛔ It requires **`.All` application permissions with tenant-admin consent
in EVERY customer tenant**, a calling-bot registration, and a real media-plane
engineering project. **Not proportionate for meeting interop**, and it makes
Loopcom a bot inside Microsoft's stack rather than a peer.

## 3. RECOMMENDATION

⛔ **Do not try to make Loopcom a video peer of Teams or Meet — that door is
shut and the only ways through it are a partner programme (Pexip) or a terms
violation.** The defensible position is the one Loopcom already holds: **it owns
its own video (LiveKit) and it owns the phone network.** So integrate at the
**telephone** layer, where Loopcom is strong and the platforms are open:

1. **Dial-in bridging** (§2a) — join a customer's Teams/Meet call from a Loopcom
   phone. Real, clean, uses existing infrastructure.
2. **Scheduling** (§2b) — put Loopcom meetings on Google/Microsoft calendars and
   read theirs.
3. **In-meeting CRM context** (§2c) — cheap side panel, no media.

## 4. OPEN / NOT VERIFIED

- ⚠️ **Teams Cloud Video Interop (CVI)** — the direct analogue of Pexip-for-Meet.
  Its 2026 status, partner list and whether it accepts new entrants were **not
  verified in this pass**. If video interop with Teams ever becomes a real
  commercial requirement, that is the one thing left to check.
- ⏳ Nothing has been built, tested or filed. The `phoneAccess[]` dial-in bridge
  in §2a is the cheapest thing to prove and has never been tried.
- ⚠️ A large volume of adjacent research (Teams Direct Routing, Operator Connect,
  Graph presence, Teams/Google chat, SBC pricing) was produced in the same pass
  while the question was still open. **It answers a DIFFERENT question — carrying
  voice and messaging, not video** — and is summarised in
  `AGENT_HANDOFF_PLATFORM_AUTH_PROGRAM_2026-08-21.md` §Microsoft plus the notes
  below, kept because it is expensive to re-derive:
  - ⛔ **Asterisk/VitalPBX can never be a certified Teams SBC** — Microsoft:
    *"We're not accepting new nominations for certification until further
    notice."* Direct Routing needs a certified SBC in front (anynode is the only
    vendor with a **published** price: **$53.90/mo for 10 sessions**, multi-tenancy
    included). ⛔ **There is NO free Ribbon production tier** — the 5-session
    licence is demo-only, *"not for production deployments with live customer
    traffic"*, and the 2021 free promotion expired.
  - ⛔ **Operator Connect is out of reach** — it needs a **public ASN, own IPv4
    space, and redundant 10 Gbps PNIs**. ⛔ Azure Communications Gateway, the
    usual shortcut, **retired 2025-10-30**; any pre-2025 advice citing it is stale.
  - ✅ **Teams message APIs stopped being metered on 2025-08-25** — the old
    $0.00075/message and the Azure billing setup are **gone**.
  - ✅ **Publishing "Busy — In a call" INTO Teams presence from Asterisk is
    possible** (`setPresence`, `Presence.ReadWrite.All`, admin consent) — but
    ⛔ *"because the Teams client uses poll mode, it takes a few minutes to
    update"*. **Never sell it as a real-time busy light.**
  - ✅ **Google Voice SIP Link is open to any carrier** (*"we support all
    carriers"*) — but ⛔ **build it defensively only**: every seat moved to
    Google Voice stops paying Loopcom ~$30 and starts paying Google. ⛔ Its
    **E911 behaviour is undocumented — get it in writing** given the platform's
    history there.
