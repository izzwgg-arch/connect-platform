# ⛔⛔ Old nginx workers 502 after a blue/green deploy (2026-09-16) — READ before touching `deploy_{api,portal}_rollout_write_upstream_port`, the upstream include files in `/opt/connectcomms/nginx/`, or `worker_shutdown_timeout`

**Status: ROOT CAUSE PROVEN on the live box. Fix WRITTEN + TESTED, NOT DEPLOYED — waiting for
Izzy's OK** (it changes what nginx loads on the next api/portal deploy). Branch
`claude/nginx-upstream-backup` (scripts + test + `docs/nginx/README.md`). Nothing on the server
was changed: no nginx edit, no reload, no deploy.

## What happened
~21:46 server time: a Chrome tab on `https://app.loopcom.net` got `502 Bad Gateway` on EVERY page
(incl. `/login`) for 16 min, while curl from the server and a fresh connection on the other
hostname got 200.

## Mechanism (measured, read-only)
- `nginx -s reload` starts a new worker generation; old workers show
  `worker process is shutting down` and **stay alive as long as any client connection stays open**.
  `nginx.conf` has **no `worker_shutdown_timeout`**. At 23:08 there were **28 old workers** from
  generations reloaded at 14:27, 18:04, 22:06 and 22:58. Every one of them was held only by
  WebSockets: `/ws/telephony` → :3003 (`proxy_read_timeout 86400`) and `/sip` → PBX :8089 (3600).
- ⛔⛔ **An old worker still routes to the port that was active at ITS reload.** The portal
  rollout reloads twice (→ candidate :3005, then → stable :3000) and then removes the candidate.
  Workers from the "→ :3005" generation that still hold a browser connection get
  `connect() failed (111: Connection refused) … upstream: "http://127.0.0.1:3005/…"`.
- The incident, from `error.log`: worker **3656778**, connection **\*442967**, client 50.48.58.53,
  HTTP/2, `/texting-registration/…` and `/version`, refused to **:3005** from 21:46:19 to 22:02:22.
  (Why that one HTTP/2 connection outlived 75 s idle gaps is NOT proven — the fact that it did is.)
- ⛔⛔ **The API does the same and it is bigger:** today **937 refused to api candidate :3004**,
  almost all in two ~75 s bursts (04:16, 05:36 — many pids of one generation each, ≈ keepalive
  window), plus **288 to :3001** (older generations during the stable recreate). access.log: 571
  502s in hour 04, 498 in hour 05. Mobile/desktop apps' `/api` traffic ate those.
- Upstreams: `/etc/nginx/conf.d/connect-{api,portal}-bluegreen-upstream.conf` =
  `upstream connect_X_active { include /opt/connectcomms/nginx/connect-X-upstream-active.conf; }`;
  the include is ONE line written by `deploy_X_rollout_write_upstream_port`. No
  `proxy_next_upstream` / `max_fails` / `keepalive_timeout` overrides anywhere in `/etc/nginx`.
  ⛔ `/etc/nginx/sites-enabled/connectcomms` is a REAL file (loopcom vhost is a symlink).

## The fix (branch `claude/nginx-upstream-backup`)
The include becomes TWO lines: active port + the other blue/green port as `backup`, both
`max_fails=0`:
```
server 127.0.0.1:3000 max_fails=0;
server 127.0.0.1:3005 backup max_fails=0;
```
Every generation names both ports, so whichever container is gone, a refused connect is retried
on the one that is alive. **No connection is cut, nothing waits on old workers.**
Walk-through: steady G0 `3000,3005b` → cutover G1 `3005,3000b` → stable recreate (3000 briefly
down: G0 falls to 3005 ✓) → normalise G2 `3000,3005b` → candidate removed (G1 falls to 3000 ✓).
- `read_active_port` still takes the FIRST port = primary, so rollback targets are unchanged.
- `max_fails=0` matters: a two-server upstream starts failure accounting (a single server ignores
  it); with the default `max_fails=1` one slow request would park the live port for 10 s in that
  worker and send its traffic to a port nobody listens on.

### Proof
- **Isolated test nginx on loopcom** (host `/usr/sbin/nginx` 1.24, own prefix/pid/log in `/tmp`,
  127.0.0.1:390xx only, `timeout 20`, removed afterwards — the live nginx untouched):
  one-line upstream to a dead port → **502**; dead primary + live backup → **200 ×3 GET + 200 POST**;
  both alive → primary only; `max_fails=0` primary dead → 200 ×4 and the primary was retried
  every time (4 refused logged) — `nginx -t` accepts the exact two-line syntax.
- `bash scripts/lib/deploy-rollout-probe.test.sh` → **36 passed**; the 8 new file-shape assertions
  **FAIL when replayed against HEAD's** rollout scripts (28/8).

### Blast radius (traced)
- Only the two include files change; every vhost/location stays as is.
- Steady state: a GET that TIMES OUT on the live port is retried once on the backup port (nothing
  listens → refused) → **502 instead of 504**. POSTs already sent are never retried
  (`proxy_next_upstream` default excludes non-idempotent). Refused connects retry for any method
  (request never reached the upstream) — proven with POST above.
- During the deploy window a timed-out idempotent GET could be retried on the other container.
- The post-cutover public verify could be satisfied through the backup (old stable) if the
  candidate died between its direct `/ready` probe and the public probe — narrow masking.
- `nginx -t` runs before every reload; if it failed, the running config stays loaded (deploy fails,
  no outage).
- ⛔ **Rollout-script changes take effect on the deploy AFTER the one that ships them** (the script
  is sourced before git sync — see `2026-08-21-every-api-and-portal-deploy-was-rolling-itself-b.md`).
  Old single-line generations alive at that moment still 502 until they drain; to close that too,
  deploy api and portal once each after merging.

### Rejected / not recommended: `worker_shutdown_timeout 30s`
It would kill old workers 30 s after every reload — dozens per day (the upstream dir has 660
`.pre-<job>` backups). That cuts every WebSocket each deploy: `/sip` (softphone SIP-over-WSS;
`apps/portal/hooks/useSipPhone.ts` reconnects with backoff, but in-call hold/transfer/BYE signaling
is lost until it re-registers — media is direct), `/ws/telephony` (live feed shows "reconnecting"),
`/meetws` (LiveKit reconnect), `/ws/` :3002. Mobile reconnect behaviour NOT checked. It also
would not fully fix the 502: 30 s of refused requests remains after each candidate removal.
A long value (e.g. hours) would only cap memory from old workers; optional, not needed.

## ⏳ Open
- **Izzy's OK**, then merge `claude/nginx-upstream-backup` into `feat/ivr-migration-takeover`,
  deploy api + portal, and on the box confirm the include files have two lines
  (`cat /opt/connectcomms/nginx/connect-*-upstream-active.conf`) and that
  `grep -c "127.0.0.1:300[45]" /var/log/nginx/error.log` stops growing after the NEXT deploy.
- Found in passing: `/opt/connectcomms/nginx/` holds 660 `*.pre-<job-uuid>` backup files that are
  never pruned (harmless, untidy). A `.pre-manual` at 22:06:26 means someone hand-wrote the portal
  include and reloaded then — not investigated.
