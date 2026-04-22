# Multi-Call System — Architecture & QA Report

This document is the deliverable for the full multi-call handling system spec.
It lists every change that was made, the hold/resume model, the policy for the
LIFO restore stack, and a complete manual QA checklist that should be executed
against both the mobile app and the web portal before cut-over.

---

## 1. Architecture changes

### 1.1 Backend (Prisma + API)

- **`packages/db/prisma/schema.prisma`**
  - Added `HELD` to `CallInviteStatus` (between `ACCEPTED` and `DECLINED`).
  - Added `heldAt`, `resumedAt`, `endedAt`, and `stackOrder` columns on
    `CallInvite`.
  - Added index `(userId, status, stackOrder)` for the active-and-held lookup
    used by the mobile client on reconnect.
- **Migration:** `20260419200000_call_invite_multi_call/migration.sql`.
- **`apps/api/src/server.ts`** — three new routes authenticated against the
  mobile JWT:
  - `GET  /mobile/call-invites/active` — returns `{active, held[]}` for the
    current user, ordered by `stackOrder ASC` for the held list. Used by the
    mobile client to re-hydrate multi-call state after a reconnect.
  - `POST /mobile/call-invites/:id/hold` — sets `status=HELD`, `heldAt=now()`,
    and assigns `stackOrder` = (max existing held stackOrder + 1).
  - `POST /mobile/call-invites/:id/resume` — sets `status=ACCEPTED`,
    `resumedAt=now()`, clears `stackOrder`.

### 1.2 SIP client (mobile)

- **`apps/mobile/src/sip/jssip.ts`** refactored away from a single
  `this.session` authority to a per-session map:
  - `sessionsById: Map<string, JsSIP.RTCSession>`
  - `sessionStates: Map<string, SipSessionState>`
  - `heldSessions: Set<string>`
  - Concurrency cap: `MAX_CONCURRENT_SESSIONS = 5`. Additional INVITEs are
    rejected with `486 Busy Here`.
  - Every new inbound/outbound session gets a `_multicallId` and is emitted
    via a new event surface: `onSessionAdded`, `onSessionStateChanged`,
    `onSessionRemoved`.
  - New SipClient primitives: `listSessions`, `holdSession`, `unholdSession`,
    `hangupSession`, `answerSession`, `getSessionState`, `setActiveSession`.
  - Hold/unhold is implemented via JsSIP's native `session.hold()` /
    `session.unhold()` (SIP re-INVITE with `a=sendonly`).

### 1.3 CallSessionManager (mobile)

- **`apps/mobile/src/context/CallSessionManager.tsx`** — new central multi-call
  authority. Consumes SIP per-session events and exposes high-level actions to
  React UI:
  - State: `{ activeCallId, heldCallIds[], ringingCallIds[], callsById }`.
  - Actions: `answerWaiting`, `declineWaiting`, `holdActive`, `resume`, `swap`,
    `hangup`, `beginOutbound`, `registerInboundInvite`, `attachSipSession`,
    `hydrateOnReconnect`.
  - Backend sync: fires POST `/hold` + `/resume` only for inbound sessions that
    have a `CallInvite` row; outbound calls remain client-only until a future
    phase adds server-side outbound tracking.
  - LIFO auto-resume: when the active call ends and held calls exist, the most
    recently held call is unheld and promoted to active automatically.
  - Outbound-while-busy policy: if the user initiates a new outbound call
    while another session is active, the active session is auto-held.

### 1.4 Mobile UI

- **`apps/mobile/App.tsx`** — wraps the app in `CallSessionProvider` so every
  screen can read multi-call state.
- **`apps/mobile/src/screens/call/ActiveCallScreen.tsx`** — renders:
  - `HeldCallsStrip` — horizontal scroll of held calls with Resume / Hang up.
  - `CallWaitingBanner` — animated top banner for the oldest ringing inbound
    while another call is active. Banner gives Answer / Decline.
  - The existing "Transfer" slot now doubles as **Swap** when held calls are
    present.
- **`apps/mobile/src/context/NotificationsContext.tsx`** — `safeSetInvite()`
  now unconditionally registers the invite with `CallSessionManager` and
  **returns early** (does NOT open the full-screen IncomingCallScreen) when
  there is already an active call — the banner handles it instead.
- **`apps/mobile/src/navigation/RootNavigator.tsx`** — when
  `useCallSessions().activeCall !== null`, the effect that navigates to
  `IncomingCallScreen` is bypassed.

### 1.5 Android native

- **`IncomingCallFirebaseService.java`** — new static flag
  `public static volatile boolean inActiveCall`. When set to `true` by JS:
  - New FCM `INCOMING_CALL` messages skip `startIncomingCallRingtone()` (no
    loud native ring that would stomp on the active call's audio path).
  - `handleIncomingCallNative()` forces `PRESENTATION_FOREGROUND_JS` so the
    full-screen intent is **not** fired.
  - The `pending_call_native.json` cache is still written so JS can recover if
    the process was killed between the FCM and the JS handler.
- **`IncomingCallUiModule.kt`** — new `@ReactMethod setInActiveCall(boolean)`
  exposed to JS.
- **`CallSessionManager.tsx`** — `useEffect` on `state.activeCallId` pushes the
  boolean down to the native module whenever the has-active state flips.

### 1.6 Web portal (softphone parity)

- **`apps/portal/hooks/useSipPhone.ts`** — additively layered multi-session
  state onto the existing single-call hook:
  - New refs: `sessionsByIdRef`, `sessionMetaRef`, `activeSessionIdRef`.
  - New state exposed by the hook: `sessions[]`, `activeSessionId`,
    `heldSessionIds[]`, `ringingSessionIds[]`.
  - New actions: `answerSession`, `holdSession`, `resumeSession`,
    `hangupSession`, `swapToSession`.
  - `newRTCSession` now records every session. If an inbound arrives while
    another call is active, the new session is bound via `bindSideSession`
    (lightweight) and the primary `callState` UI is not hijacked.
  - `dial()` auto-holds any currently-active session before placing outbound.
  - LIFO auto-resume: when the active session ends and held sessions exist,
    the most recently held session is unheld and promoted.
  - Concurrency cap: `MAX_CONCURRENT_SESSIONS_WEB = 5`.
- **`apps/portal/components/MultiCallPanel.tsx`** — new component. Renders two
  stacked sections (Ringing, On Hold) with Answer/Decline and Resume/Hang up
  actions, and gracefully renders nothing when both lists are empty.
- **`apps/portal/app/(platform)/dashboard/voice/phone/page.tsx`** — mounts the
  panel under the primary softphone widget.

---

## 2. Hold / resume model

Hold is implemented **client-side via SIP re-INVITE with `a=sendonly`** (native
JsSIP hold/unhold on both platforms). No server-side park. The PBX sees:

- `re-INVITE` with `a=sendonly` → peer is muted.
- `re-INVITE` with `a=sendrecv` on resume → audio restored.

Why not server-side park? Two reasons:

1. Inspection of the current VitalPBX / Kamailio integration shows no exposed
   park/unpark REST endpoints for our tenant API. Adding them server-side would
   be a separate workstream.
2. Client-side hold is sufficient for the requested UX: from the user's
   perspective the call appears held, and the remote party hears silence (or
   MoH if the PBX is configured to play it on receipt of `a=sendonly`).

---

## 3. Active / held restore policy (LIFO)

**Explicit choice: Last-In, First-Out.**

Example trace (logs emitted with `[MULTICALL_STATE]`):

```
A active                               → active=A  held=[]
B incoming, user answers               → active=B  held=[A]
C incoming, user answers               → active=C  held=[B, A]     (B newer, A older)
user ends C                            → active=B  held=[A]        (B auto-resumes — newest held)
user ends B                            → active=A  held=[]         (A auto-resumes)
```

Both implementations sort held sessions by `startedAt DESC` and pick index 0
when restoring. Mobile's CallSessionManager tracks `heldCallIds[]` already in
LIFO order. Web reconstructs the order from `sessionMetaRef` on every publish.

Manual swap (`swap` / `resumeSession`) does **not** remove any held call — it
demotes the current active to held and promotes the chosen held to active.
The previously active then takes position 0 of the held list (becomes the
newest-held), so hanging up the new active restores it next.

Remote hangup of a held call removes it from the held list without touching
the active call. Remote hangup of the active call triggers LIFO restore.

---

## 4. Outbound-while-busy policy

Implemented as **automatic hold**: starting a new outbound call while another
session is active silently holds the active session first. No modal prompt.
This matches the behaviour of every call-center softphone we benchmarked and
keeps the dial path one click.

---

## 5. Concurrency limit

Chosen cap: **5 simultaneous SIP sessions per user / extension** (1 active +
up to 4 held). Rationale:

- Aligns with the default VitalPBX extension dialog limit.
- Matches the mobile UI: the HeldCallsStrip is horizontally scrollable but
  five cards is the visual sweet spot before it becomes a list.
- Beyond five the cognitive load for a single user is unmanageable; real
  call centers route overflow to a queue, not to additional held slots on
  the same agent.

6th inbound INVITE is rejected at SIP layer with `486 Busy Here` on both
platforms.

---

## 6. Log tags

All multi-call events are tagged for easy grep:

```
[MULTICALL]           — high-level events (incoming, outgoing, swap, ended)
[MULTICALL_STATE]     — periodic state snapshots after each mutation
[MULTICALL_UI]        — (reserved) UI-specific logs
[MULTICALL_BACKEND]   — /hold, /resume, /active REST calls
[MULTICALL_HOLD]      — before-hold and after-hold events
[MULTICALL_RESUME]    — resume triggers (manual + LIFO auto)
```

---

## 7. Manual QA checklist

### 7.1 Mobile — single-call regressions (must still pass)

| # | Scenario | Pass |
| - | -------- | ---- |
| 1 | Inbound call, app foregrounded → full-screen IncomingCallScreen, Answer connects | ☐ |
| 2 | Inbound call, app backgrounded → floating heads-up notification, tap Answer connects | ☐ |
| 3 | Inbound call, device locked → full-screen call UI over lock screen, Answer connects | ☐ |
| 4 | Inbound call, app process killed → FCM wakes service, cold-start resolves to active call | ☐ |
| 5 | Outbound call from dialpad → dialing → connected flows unchanged | ☐ |
| 6 | Caller-side cancel before answer → ringtone stops, UI dismisses, no ghost ringing | ☐ |
| 7 | Hangup from lock-screen answer → returns to lock screen, not to app home | ☐ |

### 7.2 Mobile — multi-call (new)

| # | Scenario | Pass |
| - | -------- | ---- |
| 8 | A active, B inbound → CallWaitingBanner appears (no full-screen IncomingCallScreen), no loud native ring | ☐ |
| 9 | Tap Answer on banner → A auto-holds, B becomes active, HeldCallsStrip shows A | ☐ |
| 10 | C inbound while B active with A held → banner for C, answer → active=C, held=[B, A] | ☐ |
| 11 | End C → B auto-resumes (LIFO), held=[A] | ☐ |
| 12 | End B → A auto-resumes, held=[] | ☐ |
| 13 | Manual swap: tap Swap while A held → A becomes active, current becomes held | ☐ |
| 14 | Remote hangup of held call (e.g. A hangs up while held) → strip removes A without touching active | ☐ |
| 15 | Outbound dial while on a call → current auto-holds, new outbound becomes active | ☐ |
| 16 | Tap Decline on banner → waiting call dropped, active call unaffected | ☐ |
| 17 | App killed & reopened with server-side HELD invites → `GET /active` repopulates held strip | ☐ |

### 7.3 Web portal — single-call regressions

| # | Scenario | Pass |
| - | -------- | ---- |
| 18 | Inbound call, IncomingScreen shows, Answer connects, audio both ways | ☐ |
| 19 | Outbound call, OutgoingScreen shows, Cancel terminates | ☐ |
| 20 | Hold button from ActiveCallScreen holds and unholds | ☐ |
| 21 | Quality diagnostics panel still shows live stats | ☐ |
| 22 | Hangup returns softphone to keypad | ☐ |

### 7.4 Web portal — multi-call (new)

| # | Scenario | Pass |
| - | -------- | ---- |
| 23 | A active, B inbound → MultiCallPanel "Incoming Call Waiting" row shows B, primary UI unchanged | ☐ |
| 24 | Click Answer on B → A auto-holds (shows in "On Hold"), B becomes primary active | ☐ |
| 25 | C inbound while B active → panel shows C ringing + A held; answer → active=C, held=[B, A] | ☐ |
| 26 | End C → B auto-resumes, A stays held | ☐ |
| 27 | Click Resume on A while B active → B held, A active | ☐ |
| 28 | Click Hang up on a held call → held row removed, active unaffected | ☐ |
| 29 | Dial new number while on a call → current auto-holds, outbound starts | ☐ |
| 30 | Refresh browser with 2 held calls on server → (current limitation: web does not re-hydrate from server yet, see §8) | ☐ |

---

## 8. Known limitations / follow-ups

1. **Web reconnect hydration.** Mobile has `hydrateOnReconnect()` that fetches
   the active/held list on AppState=active and on token appearance. Web does
   not currently re-hydrate on browser refresh — the underlying SIP UA starts
   fresh, so any held dialogs are abandoned at SIP layer too. This matches the
   PBX's view (the UA re-registers), but the UI state won't show history of
   held calls. A proper web implementation would require a parallel session
   persistence mechanism; out of scope for this phase.
2. **Music on Hold.** We do not force a `a=inactive` on hold, only
   `a=sendonly`. If the PBX is configured to play MoH it will, otherwise the
   remote party hears silence. No UI-side MoH.
3. **Outbound-through-a-CallInvite.** Outbound calls do not currently write a
   `CallInvite` row, so their hold/resume state is client-only. This means
   that if the mobile app is killed while an outbound call is held, it cannot
   be restored after cold start. Inbound holds survive cold start because the
   `CallInvite` row is the source of truth.
4. **Conference.** Out of scope. The ability to merge two calls into a
   three-way bridge is not implemented — all the APIs (especially
   `setActiveSession`) are written with a future conference feature in mind,
   but no UI/backend for it yet.

---

## 9. Files changed

### Backend
- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20260419200000_call_invite_multi_call/migration.sql`
- `apps/api/src/server.ts`

### Mobile
- `apps/mobile/src/types/callSession.ts` (new)
- `apps/mobile/src/sip/types.ts`
- `apps/mobile/src/sip/jssip.ts`
- `apps/mobile/src/api/client.ts`
- `apps/mobile/src/context/CallSessionManager.tsx` (new)
- `apps/mobile/src/context/SipContext.tsx`
- `apps/mobile/src/context/NotificationsContext.tsx`
- `apps/mobile/src/navigation/RootNavigator.tsx`
- `apps/mobile/src/screens/call/ActiveCallScreen.tsx`
- `apps/mobile/src/screens/call/CallWaitingBanner.tsx` (new)
- `apps/mobile/src/screens/call/HeldCallsStrip.tsx` (new)
- `apps/mobile/App.tsx`
- `apps/mobile/android/app/src/main/java/com/connectcommunications/mobile/IncomingCallFirebaseService.java`
- `apps/mobile/android/app/src/main/java/com/connectcommunications/mobile/IncomingCallUiModule.kt`

### Web portal
- `apps/portal/hooks/useSipPhone.ts`
- `apps/portal/components/MultiCallPanel.tsx` (new)
- `apps/portal/app/(platform)/dashboard/voice/phone/page.tsx`
