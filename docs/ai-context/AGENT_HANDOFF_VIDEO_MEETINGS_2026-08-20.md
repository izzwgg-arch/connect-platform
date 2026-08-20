# AGENT HANDOFF — Loopcom Meetings: link-join video meetings on self-hosted LiveKit (2026-08-20)

Izzy, 2026-08-20: *"I would like to create a new feature in Connect, which is
video meetings … somebody sends a link to somebody, they open the link, and
they're in a meeting with them … sharing screens, picking up hands, chat,
everything Zoom has."* Then: *"Yup, let's do free open source. We don't have to
build it."* Then, on the mockups
(<https://claude.ai/code/artifact/f3a3a18c-1b23-4edd-bcfe-ca5d1fe46303>):
*"Looks great, let's do it."*

Feature commit **`43b0ab7f`** (+ `7b289e61` control-byte fix) on
`feat/ivr-migration-takeover`, merged to origin as **`b688b175`**.

## §1 The architecture, one paragraph

**LiveKit (free, open source, self-hosted) is the media engine; Connect only
decides who gets in.** The api mints LiveKit access tokens (plain HS256 JWTs —
`apps/api/src/meetings/livekit.ts`, hand-rolled on `node:crypto`, ⛔ NO LiveKit
SDK dependency on purpose — the `undici` lesson) and carries the host's
moderation verbs through LiveKit's RoomService (Twirp = JSON-over-POST, plain
`fetch`). Video, audio, screen share, chat and raised hands flow browser ↔
LiveKit and NEVER touch the api — the same division of labor as remote support.
Chat + raised hands ride LiveKit's data channel with the tiny protocol in
`apps/portal/lib/meetings.ts` (`encodeMeetData`/`decodeMeetData`); nothing is
stored, meeting chat dies with the meeting, deliberately.

## §2 What runs where

- **LiveKit server**: container `app-livekit-1` on loopcom, image
  `livekit/livekit-server:v1.13.5`, compose overlay `docker-compose.livekit.yml`
  (the agent pattern — `docker compose -f docker-compose.app.yml -f
  docker-compose.livekit.yml up -d livekit`). Config
  `/opt/connectcomms/env/livekit.yaml` (mode 600, holds the API key/secret;
  template `infra/livekit/livekit.example.yaml` — ⛔ the real file is never in
  git).
- **Ports**: 7880 (signal/admin HTTP) binds **127.0.0.1 only** — the public
  path to it is nginx `location /meetws/` on **BOTH** app vhosts
  (`connectcomms` = the real FILE in sites-enabled, `connectcomms-loopcom` via
  sites-available; backups `/root/nginx-connectcomms*-backup-*-meetws.conf`).
  **7881/tcp + 7882/udp are public WebRTC media** (single-port UDP mux — two
  firewall holes instead of a 10k range). ⛔ Docker-published ports BYPASS ufw,
  which is exactly why 7880 is loopback-bound in the compose file.
- **Env** (`.env.platform`, backup `.env.platform.bak.*.livekit`):
  `LIVEKIT_URL=http://livekit:7880` (docker-network DNS — the livekit service
  joins the app compose default network), `LIVEKIT_API_KEY=LKf48a22035bbd`,
  `LIVEKIT_API_SECRET` (64 hex). Same pair in livekit.yaml's `keys:`. ⛔ No
  compose `environment:` overrides for any of them (the CDR_INGEST_SECRET
  lesson); api/api_candidate pick them up from env_file on recreate.
- **sysctl**: `net.core.rmem_max/wmem_max=7500000`
  (`/etc/sysctl.d/98-livekit-udp.conf`) — LiveKit's UDP-buffer warning.

## §3 The api surface (`apps/api/src/meetings/`)

- `POST /meetings` (JWT) create → `{code, joinPath: /meet/<code>, …}`. Codes
  `xxx-xxxx-xxx` from a no-confusables alphabet (no i/l/o/0/1), ~46 bits;
  DB-unique with create-retry on P2002.
- `GET /meetings` (JWT) — the caller's own meetings (creator-scoped on purpose).
- `POST /meetings/:code/join` (JWT) — member join; **host = creator or
  SUPER_ADMIN**, and the host enters even when locked. Identity
  `user-<sub>-<rand>` (⛔ the random suffix prevents LiveKit's
  DUPLICATE_IDENTITY kick when one person opens two windows).
- `GET /meetings/public/:code/info` + `POST /meetings/public/:code/join` —
  **the only public routes**, on the JWT bypass list
  (`jwtPublicRouteBypass.ts`, anchored `startsWith("/meetings/public/")`). The
  CODE is the credential (pay-link pattern). Guest identity `guest-<rand>`,
  name required ("Type your name so people know who joined"), ⛔ **guests are
  never hosts whatever the body claims**, and participant tokens NEVER carry
  `roomAdmin` — moderation exists only as api routes so it is re-checked
  server-side per call.
- Host verbs: `/meetings/:code/lock` (DB flag, join checks it),
  `/end` (sets endedAt + best-effort RoomService DeleteRoom — a LiveKit hiccup
  must not fail "End meeting", the DB row is the truth),
  `/host/mute` (MutePublishedTrack), `/host/remove` (RemoveParticipant).
- **Unconfigured server** (any LIVEKIT_* missing/blank after trim): create and
  join answer `503 meetings_not_configured` in plain English; info still works;
  the api boots fine. The feature is env-armed, like Turnstile.
- DB: `VideoMeeting` (migration `20260820120000_video_meetings`) — tenant FK
  **CASCADE** (the ConnectChatThread lesson), `createdByUserId` a plain column
  (no FK) so deleting a user never breaks meeting history.
- Tests: 11 in `meetings.test.ts` (token signature verified by recomputed HMAC,
  bypass anchoring, full route matrix on a fake db, source guard that server.ts
  registers the module). ⛔ The fake db's `videoMeeting` accessor was verified
  against the REAL generated client (`typeof c.videoMeeting === "object"`) —
  the Prisma-typo-hidden-by-`as any` trap.

## §4 The portal surface

- **`/meet/[code]`** (public, `app/meet/[code]/`) — lobby (camera preview, name
  prefilled from localStorage `cc-meet-name`, mic/cam toggles) → `MeetingRoom`
  (grid, speaking ring, screen-share stage + filmstrip, chat panel, people
  panel with hands ordered first-come-first-served, host tile controls, lock
  toggle, leave). A signed-in user joins through the authed route (host
  powers); 401 falls back to guest join; ⛔ a locked/ended refusal is NOT
  retried as guest.
  - ⛔ `/meet/` is in `sessionExpiry.PUBLIC_PATH_PREFIXES` — without it a
    guest with a stale token in localStorage would be bounced to /login.
  - ⛔ Everything derives from `window.location` (`meetingWsUrl`,
    `meetingLink`) — the two-hostname rule; a guard test greps the page for
    hostname literals.
  - The LiveKit ws URL is `wss://<host>/meetws`; the SDK appends `/rtc`, and
    nginx's trailing-slash proxy maps `/meetws/rtc → /rtc`. Same-origin wss is
    already CSP-proven by `/ws/telephony`.
  - Rendering: LiveKit mutates its Room in place, so the component re-renders
    on a version counter bumped by room events — no parallel React state to
    drift. Remote audio tracks attach into a hidden sink div.
  - Late joiners can't see existing raised hands, so on ParticipantConnected
    everyone with a hand up re-broadcasts it.
  - `room.startAudio()` is called on the join click's gesture chain; if the
    browser still blocks autoplay a "Click to enable sound" banner appears
    (AudioPlaybackStatusChanged).
- **`/meetings`** (platform, sidebar "Meetings" in workspace) — start a
  meeting (opens /meet/<code> in a new tab), list yours, copy link, end.
  Yiddish PHRASES registered. ⛔ Gated on **`can_view_workspace_overview`** —
  reused deliberately: a dedicated `can_view_workspace_meetings` key needs the
  LIVE `PlatformRolePermissionSnapshot` row updated
  ([[custom-roles-are-authoritative]] — code defaults don't reach it), which is
  a follow-up for Izzy. Same precedent as the Install link reusing the
  contacts key.
- Dependency: **`livekit-client` ^2.15.0 (resolved 2.22.0)** — the ONLY new
  package, portal-only. ⛔ TS 5.9 gotcha: `publishData` wants
  `Uint8Array<ArrayBuffer>`; `encodeMeetData` casts TextEncoder's
  `ArrayBufferLike` result (safe — the runtime buffer is always plain).
- Tests: 8 in `lib/meetings.test.ts` (registered in the portal test list),
  including the sessionExpiry + navConfig wiring guards.

## §5 Deploy / verify state

Final state, all container-verified 2026-08-20:

- **LiveKit `app-livekit-1` UP** and reachable through nginx on both hostnames
  (`/meetws/` 200; bogus token → LiveKit's own 401 through the whole path; SIP
  101 and health 200 on both — no regression).
- **api DEPLOYED** — first at `b688b175` (migration applied, read back from the
  live DB), then at **`0ec27813`** carrying the roomCreate fix (§5a). The whole
  token chain proven live: real create → guest join → **LiveKit answered 200 on
  `/rtc/validate` for the api-minted token on both hostnames** → end → rejoin
  **410 meeting_ended**. Probe rows deleted.
- **portal DEPLOYED and bundle-verified** (`7f985399` ⊇ the feature; both page
  chunks found by STRING grep in the shipped `.next`; `/meet/...` 200 on both
  hostnames) — and **walked in a real browser**: opened
  `app.loopcom.net/meet/<code>`, lobby rendered with the real meeting title,
  guest-joined over wss through nginx, in-room screen rendered with running
  timer + full control bar, a chat message delivered over the data channel,
  Leave → "You left the meeting." — **zero console errors** (no CSP violation,
  no ws failure).

## §5a The one live finding, fixed same day (`2fb24c0d`)

**RoomService.DeleteRoom answers `401 permissions denied` to a token carrying
only `roomAdmin`** — seen in the live LiveKit log on the first real `/end`.
roomAdmin covers in-room moderation (mute/remove/metadata); **DeleteRoom needs
the `roomCreate` grant**. Without it, "End meeting" still worked at the DB
level (rejoin 410) but never ejected people already in the room. The api's
admin token now carries `roomAdmin + roomCreate`; participant tokens carry
NEITHER (asserted in tests). Proven fixed live: a fresh `/end` produced
`404 requested room does not exist` (nobody had connected, so no room to
delete) — authorization passing, where the broken build said 401.

## §6 Known limits / decisions still open (Izzy's)

- **The media server is in FRANCE** (loopcom). It works, but NY↔NY meetings pay
  the transatlantic round trip twice. The plan he approved: buy a **US VPS**
  for media (doubles as the US TURN relay pending since July), move LiveKit
  there — a config change (`LIVEKIT_URL` + livekit.yaml + DNS/nginx on the new
  box), not a rebuild. Not purchased yet.
- **Strictly-filtered offices**: media tries UDP 7882 then TCP 7881. An office
  that blocks both needs TURN-over-TLS on 443 — impossible on loopcom (nginx
  owns 443) but natural on the dedicated US box. If a customer reports
  "everything connects but no video", this is the first suspect.
- **No recording** (deliberate, v1), no scheduled meetings, no waiting room,
  no mobile-app join (needs an app build), no PSTN dial-in (LiveKit has SIP
  support — the future differentiator with the PBX).
- **Locked is DB-checked at join time only** — someone already in stays in
  (correct); host uses Remove for that.
- Meeting rows are never auto-deleted; a link works until the host ends it.
  LiveKit closes empty rooms after 5 min (`empty_timeout`), and a re-join
  simply reopens the same room name (`meet-<id>`).

## §7 Acceptance (needs humans)

Two people, two machines: open `https://app.loopcom.net/meetings`, start a
meeting, text the link to a phone or second laptop, guest joins with camera —
**both see and hear each other**, screen share renders, raise hand shows on the
other side, chat delivers, host mute actually mutes, host remove actually
removes, End meeting ejects everyone. Then once more from a filtered-internet
office (the real test of TCP fallback).
