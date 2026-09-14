# ⛔⛔ AGENT HANDOFF — Loopcom Meetings: link-join VIDEO MEETINGS on self-hosted LiveKit, LIVE end to end (2026-08-20) — READ FIRST before touching `apps/api/src/meetings/*`, `/meet/[code]`, the `livekit` container, nginx `/meetws/`, or before answering "can Connect do video calls?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_VIDEO_MEETINGS_2026-08-20.md`**
(`43b0ab7f` + `7b289e61` on `feat/ivr-migration-takeover`, pushed as `b688b175`.
**api DEPLOYED and container-verified at `b688b175`; migration
`20260820120000_video_meetings` applied and read back from the live DB; LiveKit
`app-livekit-1` (v1.13.5) UP on loopcom; nginx `/meetws/` on BOTH vhosts,
health/SIP unregressed; the WHOLE token chain proven live** — a real meeting was
created through the real route, a guest joined through the public route, and
LiveKit answered **200 on `/rtc/validate`** for the api-minted token on both
hostnames; end → rejoin correctly answered **410 meeting_ended**. Probe row
deleted. **portal DEPLOYED and bundle-verified** (`7f985399`, page chunks
string-grepped in the shipped `.next`, `/meet` 200 on both hostnames) — and
**walked in a real browser**: guest-joined over wss through nginx, chat
delivered on the data channel, Leave rendered "You left the meeting.", zero
console errors. ⛔ **One live finding, FIXED same day (`2fb24c0d`, container
`0ec27813`): RoomService.DeleteRoom answers 401 to a roomAdmin-only token —
the api's admin token needs `roomCreate` too, or End meeting never ejects the
room.** Proven fixed (a fresh /end reads 404 not-found = authz passing);
participant tokens still carry neither grant, asserted.)
Izzy, 2026-08-20: *"somebody sends a link to somebody, they open the link, and
they're in a meeting … sharing screens, picking up hands, chat, everything Zoom
has"*, then *"let's do free open source"*, then, on the mockups
(<https://claude.ai/code/artifact/f3a3a18c-1b23-4edd-bcfe-ca5d1fe46303>):
*"Looks great, let's do it."* Memory: [[loopcom-meetings-built-on-livekit]].

- ⛔⛔ **THE DIVISION OF LABOR: LiveKit is the media engine; Connect only decides
  who gets in.** Video/audio/screen/chat/hands flow browser ↔ LiveKit and NEVER
  touch the api (the remote-support division). The api mints LiveKit HS256
  tokens **hand-rolled on `node:crypto`** (`meetings/livekit.ts`) — ⛔ **NO
  LiveKit SDK dependency, on purpose** (the `undici` boot-kill class); the
  moderation verbs go through LiveKit's RoomService as plain JSON-over-POST.
- **The surface:** `POST/GET /meetings` (JWT), `/meetings/:code/join` (JWT;
  host = creator or SUPER_ADMIN, enters even when locked, identity carries a
  random suffix so two windows ≠ a DUPLICATE_IDENTITY kick),
  `/meetings/public/:code/{info,join}` (**the only public routes**, on the JWT
  bypass — the CODE is the credential, pay-link pattern; codes `xxx-xxxx-xxx`,
  no-confusables alphabet, ~46 bits), host verbs `lock`/`end`/`host/mute`/
  `host/remove`. ⛔ **Participant tokens NEVER carry roomAdmin, and a guest is
  never a host whatever the body claims** — moderation exists only as api
  routes so it is re-checked server-side per call. Unconfigured env → **503
  `meetings_not_configured`**, boot unaffected (the Turnstile pattern).
- **Where it runs:** container `app-livekit-1` via `docker-compose.livekit.yml`
  (the agent overlay pattern); config **`/opt/connectcomms/env/livekit.yaml`**
  (600 — the key/secret; template `infra/livekit/livekit.example.yaml`, ⛔ real
  file never in git); `.env.platform` carries `LIVEKIT_URL=http://livekit:7880`
  + key/secret (backup `.env.platform.bak.*.livekit`). Signal: nginx
  **`location /meetws/` on BOTH vhosts** → 127.0.0.1:7880 (backups
  `/root/nginx-connectcomms*-backup-*-meetws.conf`); the client's ws URL
  derives from `window.location` (two-hostname rule). Media: **7881/tcp +
  7882/udp public** (single-port UDP mux). ⛔ **Docker-published ports BYPASS
  ufw** — which is exactly why 7880 is loopback-bound in the compose file.
  sysctl `net.core.rmem_max=7500000` (`/etc/sysctl.d/98-livekit-udp.conf`).
- **Portal:** public `/meet/[code]` (lobby → room: grid, speaking ring,
  screen-share stage, chat + hands over LiveKit data messages —
  `lib/meetings.ts` protocol, nothing stored, chat dies with the meeting) and
  `/meetings` in the workspace sidebar. ⛔ `/meet/` is in
  `sessionExpiry.PUBLIC_PATH_PREFIXES` or guests bounce to /login — guarded by
  `lib/meetings.test.ts`. ⛔ The nav/page key **reuses
  `can_view_workspace_overview` deliberately** — a dedicated meetings key needs
  the LIVE `PlatformRolePermissionSnapshot` updated
  ([[custom-roles-are-authoritative]]); Izzy's follow-up. New dep:
  **`livekit-client`** (portal only). Late joiners can't see raised hands, so
  every hand-up re-broadcasts on ParticipantConnected; `room.startAudio()`
  rides the join click and a "Click to enable sound" banner covers autoplay
  refusal.
- ⛔ **The deploy trap this hit: an scp'd file in the server clone blocks the
  next deploy.** `docker-compose.livekit.yml` was copied to
  `/opt/connectcomms/app` before the commit landed on origin; the next
  `git checkout -B` refused ("untracked working tree files would be
  overwritten") and BOTH queued deploys failed in git-sync. Delete the scp'd
  copy once the file ships via git — or never pre-copy a file that is about to
  arrive by commit.
- **Tests: 19** (11 api — token signature recomputed by hand, bypass anchoring,
  full route matrix on a fake db whose `videoMeeting` accessor was verified
  against the REAL generated client; 8 portal — protocol round-trip, wiring
  guards), all registered. api typecheck 75 = the exact baseline; portal 0;
  portal suite 210/212 (the two documented pre-existing failures).
- ✅✅ **A SECOND IP EXISTS ON LOOPCOM NOW (2026-08-21): `169.58.213.204`**,
  bought to free port 443 for TURN. Added + persisted in netplan (⛔ and
  `/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg` created — cloud-init owns
  that file and WOULD have wiped the IP at the next reboot). ⛔⛔ **Adding it
  silently published the WHOLE portal + api on a second address**, because nginx
  binds `0.0.0.0:443` — proven live (`/api/health` → `{"ok":true}` on the raw IP,
  serving the app cert). **Masked at the FIREWALL** (ufw rules 1–2 deny 80+443 to
  that IP; both answer HTTP 000 from outside now) with zero disruption — all 71
  live SIP WebSockets survived. ✅ **DONE 2026-08-21** — the four vhosts are pinned to
  `listen 45.14.194.179:443` in config, but **a reload cannot rebind the socket**:
  old workers "shutting down" (some 2 d 8 h old) hold the pre-reload wildcard
  because their SIP WebSockets never close — **only a full `systemctl restart
  nginx` frees it, and that drops all 71 connections**, so it must ride a chosen
  quiet window and is REQUIRED before anything binds 443 there. ⛔⛔ **CLOUDFLARE
  CANNOT MASK IT:** the proxy is HTTP/HTTPS only and TURN is not HTTP (arbitrary
  TCP/UDP = Spectrum, Enterprise), so proxying breaks the very thing the IP was
  bought for — and buys nothing anyway, since the PRIMARY IP is published in DNS
  for every hostname. ✅ coturn is already installed on the box. Handoff §6.
- ✅✅ **STARTING A MEETING IS SUPER_ADMIN ONLY (2026-08-21, Izzy: "Permissions
  off for everybody but me") — api DEPLOYED (`d3891d64`) and PROVEN LIVE with a
  REAL customer admin's token.** Gated in THREE places because two are only
  presentation: the sidebar entry is forced SUPER_ADMIN in
  `isNavItemVisibleForUser`, the `/meetings` page refuses to render, and
  **`requireMeetingCreator` refuses POST/GET `/meetings` server-side** — the
  only one a typed URL or a curl actually hits. ⛔⛔ **CREATE AND LIST ONLY,
  NEVER JOIN**: a guest has no account and a colleague must still open a link,
  or the feature is pointless; host powers stay creator-only. Measured through
  nginx as `ezra@connectcomunications.com` (a real TENANT_ADMIN): create **403**,
  list **403**, SUPER_ADMIN create **200**, **guest joins 200**, TENANT_ADMIN
  joins **200 with isHost:false**.
- ⛔⛔⛔ **AND THE PIN THAT FREED 443 BROKE EVERY DEPLOY ON THE BOX FOR ~80
  MINUTES — MINE AND OTHER SESSIONS'. Binding nginx to `45.14.194.179:443`
  silently removed LOOPBACK, and the blue/green rollouts verify their own
  cutover with `curl --resolve <host>:443:127.0.0.1`** — that probe returned
  `http_code=000`, so api and portal deploys failed at the `restart` stage.
  ✅ **No customer impact — the rollback is correct and the platform stayed on
  200s** (upstreams back to stable 3001/3000). ✅ Fixed: every vhost now carries
  **BOTH `listen 45.14.194.179:443` AND `listen 127.0.0.1:443`**, leaving
  `169.58.213.204:443` free for TURN (backups `/root/nginx-backup-*-loopback443/`).
  ⛔ **On this box loopback 443 is LOAD-BEARING FOR DEPLOYS: any change that
  narrows what nginx listens on must keep `127.0.0.1:443` and must be proven
  with the `--resolve ...:127.0.0.1` probe BEFORE the next deploy.** ⛔ Do not
  make another session's `DEPLOY_*_PUBLIC_VERIFY_RESOLVE_LOCAL=0` workaround
  permanent — it disables a real check. Handoff §8.
- ⚠️⚠️ **TURN-ON-443 IS BUILT AND ADVERTISED BUT THE RELAY PATH DOES NOT CARRY
  MEDIA YET (2026-08-21).** `turn.loopcom.net` → 169.58.213.204 (Squarespace),
  Let's Encrypt cert (exp 2026-11-19, auto-renew), LiveKit's built-in TURN on
  TLS 443 of that IP. ✅ **Clients really are handed
  `turns:turn.loopcom.net:443?transport=tcp`** with per-participant credentials
  — captured live off the real RTCPeerConnection. ⛔ **Read it with
  `getConfiguration()` AFTER joining**: livekit-client builds the PC first and
  calls `setConfiguration()` when the join response lands, so reading the
  constructor argument reports an empty list and is WRONG.
  ⛔⛔ **Forcing `iceTransportPolicy:'relay'` — the actual filtered-office case
  — FAILS**: `requestsSent: 8, responsesReceived: 0`. Cause 1 (FIXED): relay
  ports were unpublished; range narrowed 30000-40000 → **30000-30049** and
  published, because ⛔ **userland-proxy is ENABLED here, so docker spawns one
  process PER published port** (27 → 77). Cause 2 (**NOT FIXED**): **docker NAT
  hairpin** — LiveKit inside the container cannot reach its own published relay
  port via the host's public IP. **The fix is almost certainly
  `network_mode: host` for livekit** (LiveKit's own recommendation), which is
  NOT a drop-in: `LIVEKIT_URL=http://livekit:7880` is compose DNS and would
  break, and `bind_addresses: 0.0.0.0` would put the admin API on the public
  interface. ✅ **Nothing is broken meanwhile** — a normal join was re-verified
  in a real browser after every change; ICE just fails the relay and uses the
  direct path. ⏳ **And nobody has yet opened a meeting from a filtered office,
  which decides whether the relay is needed at all** — the direct TCP fallback
  on 7881 may already cover them. Handoff §7.
- ⛔ **STILL OPEN, Izzy's decisions:** (1) **the media server is in FRANCE** —
  the approved plan is a **US VPS** (doubles as the July-pending US TURN relay);
  moving is a config change, not a rebuild. (2) An office filtering BOTH UDP
  and arbitrary TCP needs **TURN-over-TLS:443** — impossible on loopcom (nginx
  owns 443), natural on the dedicated box; first suspect for "joins but no
  video". (3) Recording, scheduling, waiting room, mobile-app join (app build),
  PSTN dial-in (LiveKit has SIP — the phone-company differentiator) are all
  deliberately NOT in v1.
- ⏳ **NOT PROVEN: no two humans have held a video meeting.** Proven: the whole
  signal chain by live probe (create → guest join → LiveKit accepts the token →
  end → 410), 19 tests, container greps. **Acceptance is two people on two
  machines** — video both ways, screen share, hand, chat, host mute/remove, End
  ejects — then once more from a filtered-internet office.
- ✅✅ **A MEETING CAN BE SCHEDULED AND THE INVITATION IS A LOOPCOM EMAIL
  (2026-08-21, `18328aa1`) — handoff §9.** Izzy: *"I should be able to schedule
  meetings and then send out a nice email … I can add as many email addresses as
  I want"*, then on the mockup *"that is perfect! Build it!"* Migration
  `20260821150000_meeting_schedule_invites` (all columns NULLABLE, so every
  existing instant meeting is untouched); `POST /meetings` gained a schedule + an
  invite list; new `POST /meetings/:code/invite`; new screen
  `ScheduleMeeting.tsx`. ✅ **api + portal DEPLOYED and container-verified at
  `8d033759`; migration applied 15:35:33Z (3 existing meetings, 0 scheduled,
  0 invite rows — nothing that existed moved); every route probed live incl. a
  REAL TENANT_ADMIN getting 403 on create, list AND invite — and the probe sent
  ZERO emails.** ⛔ A 400 on `/end` during that probe was the PROBE's fault (a
  JSON content-type with no body trips Fastify); `apiClient` omits it, and the
  real path answers 200. Comparison against the approved drawing:
  <https://claude.ai/code/artifact/e50da26c-b3f3-4332-9b89-cf120aacba0e>.
- ⛔⛔ **THE INVITE EMAIL IS BUILT FROM `emailShell` + `ctaButton` IN
  `billing/emailTemplates.ts`, NEVER FROM NEW HTML.** Those carry the Outlook
  hardening — the fixed 600px `[if mso]` wrapper and the **VML `roundrect`, the
  only thing that paints a button in Word's renderer**. A hand-rolled invite
  looks perfect in Gmail and arrives in Outlook as bare blue text, and nobody
  finds out for weeks. **`ctaButton` was EXPORTED for this** (it was
  module-private); the nine existing billing emails are proven **byte-identical**
  afterwards. ⛔ Type is **`MEETING_INVITE`, never `ADMIN_ALERT`** (muted at the
  send door — it would build clean, log clean and reach nobody). ⛔ The join link
  comes from **`canonicalPortalOrigin()`**, not the request host: an emailed link
  has to survive a hostname change months later. All three are guard-tested.
- ⛔⛔ **THE PARSER BUGS THIS FOUND, AND THE RULE THEY EARNED: a green suite
  proves the parts work, not that the thing is right.** `parseInviteEmails` was
  unit-tested green, then run once on realistic input: **every `.co.uk` address
  was refused** (the domain pattern demanded exactly one dot — the fixture used
  `@x.com`, which is why it passed), and **`Sara Klein <sara@x.com>` was
  shredded into three tokens, reporting the person's first and last name back to
  the host as bad addresses**. An ordinary Outlook paste would have produced a
  wall of nonsense complaints. **Drive it on what a person will actually paste.**
- ⛔ **The parser lives in `packages/shared/src/inviteEmailList.ts` so the
  portal's chip input and the API's validator are ONE rule** — two would drift,
  and the drift reads as a chip the host can see being silently refused.
  ⛔ `packages/shared` names its test files explicitly; it had to be registered.
- ⛔ **The email ALWAYS names the time zone, rendered for the MEETING's own
  date** (*Eastern Daylight Time* in September, *Standard* in January).
  Recipients are elsewhere; a time with no zone is a missed meeting. An unusable
  zone is **REFUSED at the route**, never swapped for UTC. ⛔ **An address is
  recorded as invited only AFTER its email job exists**, so a crash leaves it
  re-sendable — a duplicate invite is an annoyance, a missing one is somebody who
  does not know about the meeting.
- ⛔ **FOUND IN PASSING, NOT CHANGED: the billing shell still serves the 560px
  logo.** `getDefaultLogoUrl()` points at `loopcom-wordmark-560.png` — **81 KB
  into a 156×28 slot** — because the 2026-08-17 optimisation landed on
  `packages/shared/src/loopcomEmailShell.ts` and the billing one was never
  switched. So invoices, receipts, pay links, E911 and now this invite all pay
  81 KB per open instead of 34 KB. **One line, but it moves the bytes of nine
  live customer emails that are asserted byte-for-byte — Izzy's call.**
- ✅✅ **IZZY RAN THE ACCEPTANCE TEST THE SAME DAY AND IT WORKED — 2026-08-21
  17:21:43Z he scheduled a meeting ("test", code `ucb-jatg-up4`, set for 17:25)
  and invited his OWN address; the `MEETING_INVITE` job to `izzwgg@gmail.com`
  reads `SENT` at 17:21:48Z, five seconds later.** So the whole chain is proven
  by a real person: screen → route → email builder → EmailJob → outbox →
  provider accepted. ⛔ **`SENT` means the provider TOOK it, not that it looked
  right** — whether the email rendered correctly in his inbox is still only
  known to him, and **Outlook remains unverified by rendering** (no browser
  reproduces Word's engine; it is structurally hardened only because it reuses
  the billing shell).
  ⛔⛔ **This bullet said "nobody has received an invitation" for two days after
  it had stopped being true. A recorded ⏳ is a fact about the PAST — re-verify
  before repeating it.** The one-command check:
  `select status, "sentAt", "toEmail" from "EmailJob" where type='MEETING_INVITE'`.
- ⏳ **Still unproven, and both are cheap:** only **one** invitation has ever
  been sent, so the negative that matters — **inviting one more person
  afterwards sends ONE email, not the whole list again** — has never been
  exercised live; and only one meeting has ever been scheduled. (The
  TENANT_ADMIN **403** on create/list/invite IS proven, live, against
  `ezra@connectcomunications.com`.)
- ⚠️ **`ScheduleMeeting.tsx` was touched by another session's ConnectSelect
  sweep (`f6c61735`)** — the Length `<select>` is a `ConnectSelect` now. It
  builds and ships (portal `4972f0c8` carries both the schedule strings and the
  converted control), but ⛔ **nobody has picked a length from the new dropdown**,
  and per that section's own rule a converted dropdown is unproven until someone
  opens it.
- ⏳ Deliberately not built: add-to-calendar (.ics), a reminder email, and
  rescheduling (which needs its own "the time changed" email).
