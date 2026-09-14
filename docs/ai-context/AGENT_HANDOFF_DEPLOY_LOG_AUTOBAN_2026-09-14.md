# Deploy Center queued-log polling caused the office IP ban — 2026-09-14

## Proven cause and recovery

Owner reported Forbidden and requested a permanent fix for any deploy. Read CLAUDE.md, the profile-menu handoff, security/tenant-isolation and mini-dialer autoban records before diagnosis. Windows SSH was explicitly approved for read-only diagnostics because the canonical Linux tool is unavailable. The repo key was rejected for its Windows ACL; the first connection authenticated via an available SSH identity. Subsequent reads used the existing protected key at C:/Users/izzyw/.ssh/connect2_ed25519. No key contents were output or permissions changed.

- `/dashboard`, `/login`, `/api/health`, and the legacy hostname login returned plain nginx **403**, not 404.
- Live `/etc/nginx/connectcomms/denylist.json` confirmed client `50.48.58.53` blocked at **2026-09-14T22:29:11.372374Z** until **23:29:11.372374Z**. Reason `req/min>600, 404>60/5m`; counters **670 requests / 74 404s / 0 counted 401s / 0 exploit hits**. The label says req/min but the script counts a five-minute window.
- Read-only aggregation of nginx access.log proved **all 74 404s were `/api/admin/deploy/jobs/10fee31a-fd98-45b7-9071-0e856e6bb7e5/log`**, polled while the job waited behind an API deployment. No query strings/tokens were printed. Existing UI queried every 3 seconds; the public API forwarded the queue's `log_not_available` 404 as an error. The ban needed two signals (>600 requests and >60 404s); this ordinary UI state supplied the second signal.
- The portal deployment itself **succeeded** at **22:33:03 UTC**. Its log ends `[deploy-portal] done 8b866ed6 requested_by=izzywgg@gmail.com (Deploy Center)`, with blue/green cutovers, both public readiness checks, stable port 3000 and marker verification. A later release moved the running portal to `12d2c318`, which contains `8b866ed6`; compiled profile-menu marker `Check status again` was found inside the live portal chunk. Earlier claims that compilation was still active were stale browser data after the ban, not actual server state.
- Owner explicitly approved removing **only this false-positive ban** using `/opt/connectcomms/scripts/unblock_ip.sh 50.48.58.53`. Script reported success; both public login hostnames and Loopcom API health then returned **200**. No allowlist entry, threshold change, PBX change, or broad security bypass.

## Permanent fix (local validation complete; rollout pending)

`apps/api/src/deployLogRoutes.ts` owns the existing SUPER_ADMIN log route. Validate the ID and verify the real job first; queued jobs return HTTP 200 with pending/available metadata without asking for a nonexistent file. A real job whose log has not appeared yet (or was not retained) also has a normal unavailable/waiting representation. Unknown jobs, auth failures, malformed queue responses and real read/transport failures keep their error semantics. The queue's file-path fence is unchanged. This covers every service, including API, portal, worker, telephony, realtime and full-stack, and protects already-open old portal clients as well.

The actual Deploy Center uses a sequential poller: 10 seconds after each successful response, 30 after temporary failure, no overlapping requests, no hidden-tab polling, stop on authentication/permission/missing-resource errors. Queued log drawers make no log requests; terminal logs load once. Drawer state follows the current job row instead of a frozen snapshot. Errors mark displayed job/log data as stale and manual Retry restarts polling. Global queue/security infrastructure remains unchanged.

## Verification

- **15/15 focused tests passed**: real Fastify route injection, every service queued, running-log creation race, terminal missing log, real log content/line limits, auth/invalid ID/unknown job/error preservation, malformed queue response; replay of all **74** incident requests generates **zero public 404s**. Poll tests cover slow requests, visibility, backoff, stop, cleanup and <=31 requests per loop in five minutes.
- Existing PBX mutation safeguards **6/6 passed**; no live PBX mutation.
- Portal typecheck passed after final runtime edits. API typecheck reports **84 existing diagnostics**, none in the new route module or registration; it is not a green whole-API typecheck.
- Actual Deploy Center React page in a local Chrome fixture: queued drawer showed waiting and **zero log requests**; transitioned to running and displayed log; simulated failures produced stale job and log alerts; manual refresh recovered SUCCESS; terminal log loaded once. Fake backend only; these tests made no live enqueue.
- `git diff --check` passed. Source caller search found the public log route used by Deploy Center; internal queue helpers remain unchanged.

## Release / outstanding

API and portal runtime release pending. Use the existing scripts/queue, API first so old clients immediately stop generating expected 404s. Keep blue/green enabled. Verify exact job done SHA, running-container code, browser behavior and the absence of renewed ban after a five-minute observation window. No claim that every possible future Forbidden error is impossible; this specific proven trigger has regression coverage.

Original profile-menu/DND work remains in the release history. A real extension-wide DND incoming-call acceptance test still awaits the owner's chosen company/extension; do not claim it happened.
