# ⛔ AGENT HANDOFF — "Loopcom Direct" plan + mockups (2026-08-20) — SUPERSEDED by the BUILD section above; kept for the decision history

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_DIRECT_MOCKUPS_2026-08-20.md`**
(**Plan + mockups only — no code, no migration, no deploy, no data change.**
Artifact Izzy is choosing from:
<https://claude.ai/code/artifact/d1d6e1f8-4be9-4aed-9c63-69c7781b0c2e>. "Loopcom
Direct" is a working name.)

- **The plan is four phases, each shipping alone, order load-bearing:** (1) the
  US media server (moves LiveKit off France — the July TURN-relay box, one
  purchase for both jobs; config move, never a rebuild); (2) mobile meeting join
  (LiveKit RN SDK + app build — ⛔ **the moment the app joins a LiveKit room,
  web↔mobile video exists with zero extra work**); (3) ring-a-person video calls
  (meeting + INCOMING_CALL-style push over the exact machinery that rings voice
  calls — every voice-ring lesson applies); (4) cross-company DM by number.
  Phase 4b (later, not v1): non-Loopcom numbers fall back to SMS from the
  business number.
- ⛔ **The DM half is a new thread SCOPE, not a chat tweak.** Every
  `ConnectChatThread` has a required `tenantId` and every chat route is
  tenant-scoped — the audited isolation posture. A cross-company thread needs
  its own scope/model, routes, and privacy rules. Reused: chat screens, message
  storage, pushes, read/unread, the 6-digit-code pattern. New: cross-tenant
  identity, number directory, discovery, requests, blocking.
- ⏳ **Three decisions are Izzy's, all OPEN:** first-contact model (A open / **B
  requests, recommended** / C invite-only — all three drawn); which number is
  "you" (**recommended: verified personal cell** — ⛔ a company DID is a shared
  inbox); rollout (**recommended: opt-in by verification** — nobody findable
  until they verify — plus a per-company off switch). ⛔ Until he picks, nothing
  is authorized to build.
