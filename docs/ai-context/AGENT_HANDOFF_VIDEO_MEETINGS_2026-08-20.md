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

## §6 The second IP (2026-08-21) — bought, wired, and firewalled shut

Izzy bought a Contabo additional IP for loopcom to free port 443 for TURN:
**169.58.213.204** (gateway 169.58.128.1, /17 — a DIFFERENT subnet from the
primary 45.14.194.179/24, so not a same-subnet alias).

- ✅ **Added and persistent.** `ip addr add` first (reversible, never touches the
  default route), verified reachable from OUTSIDE (ping 161 ms, HTTPS 200), then
  persisted in `/etc/netplan/50-cloud-init.yaml` (backup
  `/root/netplan-backup-*.yaml`), validated with `netplan generate` — ⛔ **NOT
  `netplan apply`**: the address was already live and correct, so applying risks
  an interface blip for zero gain. Contabo routes the IP to the VPS, so no
  gateway/route config was needed; `rp_filter` is **2 (loose)**, which is why the
  asymmetric return path is not dropped.
- ⛔⛔ **cloud-init WOULD HAVE WIPED IT AT THE NEXT REBOOT.** cloud-init is
  enabled (25.3) with no disable flag, and it owns `50-cloud-init.yaml`. Created
  `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`
  (`network: {config: disabled}`). **Any static IP added to this box needs that
  file, or it survives only until the next boot.**
- ⛔⛔ **THE EXPOSURE THIS CREATED, and it is the reusable lesson: nginx binds
  `0.0.0.0:443`, so the moment the IP existed it served the ENTIRE portal + API
  on an unadvertised second address**, presenting the
  `app.connectcomunications.com` cert. Verified live: `/api/health` returned
  `{"ok":true}` on the raw IP. **Adding an IP to a box running a wildcard-bound
  web server silently publishes everything on it.**
- ✅ **nginx pinned to the primary IP** — all four vhosts carrying `listen 443`
  (`connectcomms`, `connectcomms-loopcom`, `connectcomms-sip`,
  `connectcomms-sip-loopcom`) now read `listen 45.14.194.179:443`. Backups
  `/root/nginx-backup-*-pin443/`. ⛔ `grep -r` does NOT follow symlinks and four
  of the five enabled vhosts ARE symlinks — a naive grep finds only one file and
  you pin one of four. Resolve with `readlink -f`. IPv6 `listen [::]:443` lines
  were left alone (`ipv6only` defaults on, so they never held the v4 address).
- ✅ **DONE 2026-08-21 — THE PIN IS IN EFFECT.** Izzy: *"Do what you gotta do. Nobody's using it now."* ⛔ **A RELOAD COULD NOT DO IT, only a full `systemctl restart nginx`.**
  `nginx -t` passed and `systemctl reload nginx` succeeded, but the master still
  holds `0.0.0.0:443`: old workers stuck in "shutting down" — some **2 days 8
  hours old** — keep the pre-reload socket alive because they hold long-lived SIP
  WebSockets that never close. **Only a full `systemctl restart nginx` rebinds
  the listening sockets, and that drops every live connection (71 established on
  443 at the time of writing, mostly softphones).** Deliberately NOT done —
  it must ride a chosen quiet window, and it is REQUIRED before anything can bind
  443 on the new IP.
- ✅ **Masked at the firewall instead — immediate, zero disruption.** ufw rules 1
  and 2: `DENY IN` tcp to `169.58.213.204` ports 80 and 443 (backup
  `/root/ufw-backup-*.txt`). Proven from outside: both ports answer **HTTP 000
  (no response)** while the primary IP, both app hostnames, both SIP hostnames
  (101) and `/meetws` are unchanged, and all 71 live connections survived.
  ⛔ **These two rules must be removed when TURN is put on 443 there** — they are
  a holding measure, not the end state.
- ⛔⛔ **CLOUDFLARE CANNOT MASK THIS IP, AND PROXYING IT WOULD BREAK THE FEATURE
  IT WAS BOUGHT FOR.** The orange cloud carries **HTTP/HTTPS only**; TURN is not
  HTTP, and arbitrary TCP/UDP proxying is **Cloudflare Spectrum (Enterprise)**.
  It is the same family as the reason `app.` is still DNS-only today (Cloudflare
  idles WebSockets out at ~100 s, which would kill SIP). **And it would buy
  nothing anyway: the primary IP 45.14.194.179 is published in public DNS for
  `app.`/`sip.` on both domains, all DNS-only — the origin is already public, so
  hiding the second address while the first is in DNS is not masking.**
- ✅ **Useful find for the next step: coturn is ALREADY on this box** (ufw rules
  for TURN 3478 tcp/udp, TURNS TLS 5349, relay 49152–65535, from the July
  TURN-relay work). So putting TURN on 443 of the new IP may need no new
  software — but it still needs a hostname + certificate, and the nginx restart
  above.
- ⏳ **NOT PROVEN and the cheapest next step: nobody has tried a meeting from a
  filtered office.** LiveKit already offers TCP fallback on 7881; if those
  filters pass it, the 443 work is unnecessary. **One person at a locked-down
  office opening a meeting link settles whether any of this is needed.**

**Restart outcome (2026-08-21), measured:** wildcard `0.0.0.0:443` **gone** —
sockets now read `45.14.194.179:443` + `[::]:443`; **0 lingering workers**;
nothing bound to `169.58.213.204`, so **443 there is free for TURN**. Both app
hostnames 200/200, both SIP hostnames 101, `/meetws` 401 (LiveKit's own
refusal). ⛔ **Every client reconnected by itself within ~10 s** — established
443 connections went 70 → 70/71, `journalctl -u nginx` clean, and the PBX
(read-only) shows **138 contacts Avail** with Gesheft's app endpoints
`T8_101_1` re-registered via 45.14.194.179. Desk phones were never in scope —
they register straight to the PBX, not through loopcom.

**What still gates TURN-on-443 (nothing here is blocked by code):**
1. A hostname → `169.58.213.204` (⛔ loopcom.net DNS is at Squarespace and the
   WRITE needs Izzy's Google re-auth click; connectcomunications.com is at
   Cloudflare and no CF credential exists on the server).
2. A certificate for it (certbot, once DNS resolves).
3. Point coturn (already installed) or LiveKit's built-in TURN at 443 on that
   IP, and advertise it in livekit.yaml.
4. ⛔ **Remove the ufw deny on 443 for that IP** — it is a holding measure and
   will block TURN.

## §7 TURN on 443 (2026-08-21) — built, advertised, and the relay path does NOT work yet

Izzy bought the second IP and said *"Do what you gotta do to secure it."* What
shipped: `turn.loopcom.net` → `169.58.213.204` (Squarespace DNS, added through
his browser), a Let's Encrypt cert for it (expires 2026-11-19, auto-renew armed),
and LiveKit's **built-in** TURN on TLS 443 of that IP (`docker-compose.livekit.yml`
publishes `169.58.213.204:443:443`; coturn was NOT used — LiveKit's own TURN
mints per-participant credentials and needs no separate credential plumbing).

- ✅ **PROVEN: clients really are handed the TURN server.** Captured live in a
  browser off the real `RTCPeerConnection`:
  `turns:turn.loopcom.net:443?transport=tcp` with per-participant
  username/credential, alongside the STUN list. TLS from outside presents
  `CN=turn.loopcom.net`.
  ⛔ **A first reading said `iceServers: []` and was WRONG** — livekit-client
  creates the PeerConnection FIRST and calls `setConfiguration()` once the join
  response lands. **Hook the instance and read `getConfiguration()` after
  joining; reading the constructor argument measures nothing.**
- ⛔⛔ **BUT THE RELAY PATH IS DEAD, and only forcing it revealed that.** With
  `iceTransportPolicy: 'relay'` (which simulates an office where everything
  except 443 is blocked — the exact case this was built for) the join FAILS.
  LiveKit's own candidate-pair stats are unambiguous:
  `state: failed, local 45.14.194.179:7882 (host), remote <ip>:30044 (relay),
  requestsSent: 8, responsesReceived: 0`.
- ⛔ **First cause, FIXED: the relay ports were not published at all.** A relay
  allocation lands in `turn.relay_range_*` (default **30000–40000**) and docker
  published none of it. Narrowed to **30000–30049** in livekit.yaml and published
  (`45.14.194.179:30000-30049:30000-30049/udp`). ⛔ The narrowing is mandatory,
  not tidiness: **userland-proxy is ENABLED on this host** (no
  `"userland-proxy": false` in `/etc/docker/daemon.json`), so docker spawns one
  `docker-proxy` process PER PUBLISHED PORT — the 10,001-port default is
  unusable. After the change: 56 published ports, docker-proxy 27 → 77,
  container recreate 31 s.
- ⛔⛔ **Second cause, NOT FIXED — this is where it stands: docker NAT hairpin.**
  Relay allocations now correctly land in 30000–30049, but LiveKit's ICE agent
  (inside the container, 172.19.0.10) still gets **0 responses** when it sends
  STUN to `45.14.194.179:<relay port>` — its own published port via the host's
  public IP. Container → host-public-IP → back into the container is exactly the
  hairpin case docker's DNAT does not handle.
  **The fix is almost certainly `network_mode: host` for the livekit container**,
  which is LiveKit's own recommended production deployment for this reason. ⛔ It
  is NOT a drop-in: `LIVEKIT_URL=http://livekit:7880` resolves by compose DNS and
  would break, `bind_addresses` must stop being `0.0.0.0` or the admin API goes
  public, and nginx `/meetws/` → 127.0.0.1:7880 would then be direct. That is a
  considered change, deliberately not made hastily on a live platform.
- ✅ **NOTHING IS BROKEN BY THIS.** Verified in a real browser AFTER every change:
  a normal join works (in the room, timer running). ICE simply tries the relay,
  fails, and uses the direct path — so the only cost of the dead relay is a
  slightly slower failover for clients that would not have connected anyway.
  Platform health after all of it: both app hostnames 200, both SIP hostnames
  101, `/meetws` 401 (LiveKit's own refusal), livekit up.
- ⛔ **Publishing 443 on that IP put it on scanners within minutes** — the
  LiveKit log already carries `TLS handshake failed` from `165.22.38.38`. That is
  a TURN server correctly refusing junk, not a fault.
- ⏳ **AND THE QUESTION THAT DECIDES WHETHER ANY OF THIS MATTERS IS STILL
  UNANSWERED: nobody has opened a meeting from a filtered office.** LiveKit's
  direct TCP fallback on 7881 may already carry those offices, in which case the
  relay never gets used. **That two-minute test should happen before anyone
  spends more time on hairpin NAT.**

## §8 Starting a meeting is SUPER_ADMIN only (2026-08-21) — and the nginx pin broke every deploy on the box

Izzy: *"Put meetings in the sidebar. Permissions off for everybody but me."*

- ✅ **Gated in THREE places, because two of them are only presentation.** The
  sidebar entry is forced SUPER_ADMIN in `isNavItemVisibleForUser` (the
  `pbx.ivr_migration` pattern); the `/meetings` page refuses to render on
  `backendJwtRole !== "SUPER_ADMIN"`; and **`requireMeetingCreator` in
  `meetingRoutes.ts` refuses POST/GET `/meetings` server-side** with a
  plain-English 403. ⛔ Only the last one is enforcement — a typed URL or a curl
  lands there.
- ⛔⛔ **CREATE AND LIST ONLY — NEVER JOIN.** A guest has no account at all and an
  ordinary signed-in colleague must still open a link, or the feature is
  pointless. Host powers stay creator-only (`isMeetingHost`), so a joiner still
  cannot mute, remove, lock or end. Two tests pin exactly this, including the
  negative.
- ✅ **PROVEN LIVE through nginx with a REAL customer admin's token**
  (`ezra@connectcomunications.com`, an actual TENANT_ADMIN — not a synthetic
  role string): POST `/meetings` **403**, GET `/meetings` **403**, SUPER_ADMIN
  POST **200**, **guest with no token joins 200**, TENANT_ADMIN joins by link
  **200 with `isHost: false`**. Probe meeting deleted. api at `d3891d64`,
  `requireMeetingCreator` greps 3 in the running container.
- ⛔⛔⛔ **THE EXPENSIVE LESSON: PINNING NGINX OFF THE WILDCARD SILENTLY REMOVED
  LOOPBACK, AND EVERY DEPLOY ON THIS BOX FAILED FOR ~80 MINUTES — MINE AND OTHER
  SESSIONS'.** The blue/green rollouts verify their own cutover with
  `curl --resolve <host>:443:127.0.0.1` (`DEPLOY_API_PUBLIC_VERIFY_RESOLVE_LOCAL=1`).
  With nginx bound only to `45.14.194.179:443`, that probe got `http_code=000`,
  so **api and portal rollouts failed at the `restart` stage and rolled
  themselves back** — logs read `public verify probe failed` / `FAIL: ... not
  ready after cutover`. ✅ **No customer impact: the rollback is correct and the
  platform stayed on 200s throughout** (upstreams returned to stable 3001/3000).
  ✅ **FIX: every vhost now carries BOTH `listen 45.14.194.179:443` AND
  `listen 127.0.0.1:443`**, which keeps `169.58.213.204:443` free for TURN.
  Backups `/root/nginx-backup-*-loopback443/`. Verified: all three probe URLs
  (both app hosts + portal `/ready`) answer **200 via 127.0.0.1** again.
  ⛔ **THE RULE: on this box, loopback 443 is load-bearing for deploys. Any
  future change that narrows what nginx listens on must keep `127.0.0.1:443`,
  and must be proven with the `--resolve ...:127.0.0.1` probe BEFORE the next
  deploy, not after it fails.** ⛔ Another session independently worked around
  this by setting `DEPLOY_PORTAL_PUBLIC_VERIFY_RESOLVE_LOCAL=0` — that override
  is now unnecessary and should not be made permanent; it disables a real check.
- ⛔ Deploy-queue reality on a busy day, worth knowing: two of these deploys
  first failed with **`HEAVY JOB ALREADY RUNNING`** while the queue itself read
  `runningCount: 0` — the heavy-build lock is SEPARATE from the queue, and
  another session's `deploy-direct.sh` held it. Wait on
  `ps -eo cmd | grep -cE "[d]eploy-direct.sh|[r]un-heavy.sh"` reaching 0 (the
  bracket trick avoids the self-match that has hung waiters here before), and
  ⛔ **always enqueue the BRANCH, never your own commit hash** — several
  sessions push minutes apart and pinning a hash rolls their work back.
