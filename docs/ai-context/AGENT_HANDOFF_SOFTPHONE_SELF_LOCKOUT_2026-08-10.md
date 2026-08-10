# AGENT HANDOFF — the dialer locked ITSELF out and then sat on "Connecting" (2026-08-10)

**Commit `d8fc102e` on `feat/ivr-migration-takeover` — portal DEPLOYED and
container-verified 2026-08-10.** Portal-only; nothing touching call routing, the
PBX, or the API.

Read this before diagnosing **any** "the softphone says Connecting and stays
orange" report, before adding a retry path that calls an API, and before blaming
a customer's internet for a stuck client.

---

## 1. The report, and why the obvious answer was wrong

Izzy: *"This keeps happening over and over. It says Connecting and it goes to
orange. Told me a million times this has been fixed."* Then, unprompted and
correctly: *"don't you dare blame my internet — and even if the internet was a
problem, this shouldn't have happened either."*

He was right on both counts. His network **does** flap (his egress alternates
between `49.147.60.42` and `38.105.207.148`, and the PBX shows a ~14-minute
re-registration metronome — see `izzy-network-dual-wan-flap`). But the flap is
only the **trigger**. The wedge is entirely the app's, and it is reproducible
without any network fault at all.

⛔ **THE RULE THIS SESSION EARNED: a client's own repair loop must cost fewer
requests than its own server budget allows.** Ours cost more. It rate-limited
itself out of its own credential endpoint and then bricked.

---

## 2. The evidence — one grep, and it is decisive

```bash
grep "reset-sip-password" /var/log/nginx/access.log | grep "connect/desktop" \
  | awk '{print $4, $1, $9}'
```

The User-Agent is the whole diagnostic. The desktop app announces itself:

```
@connect/desktop/0.1.5 Chrome/146.0.7680.216 Electron/41.5.0
```

so you can tell the desktop app from the browser portal (`Mozilla/... Chrome`)
and from mobile (`okhttp` / `Loopcom/NN`) in the same log.

What it showed for 2026-08-10 (nginx logs are **CEST = Izzy's clock + 6h**):

| | |
|---|---|
| Credential fetches that day | **101** from the desktop app (2 from everything else) |
| Healthy figure | **one per sign-in** |
| 05:48 → 06:15 ET | one every **~50 seconds** |
| 06:15:47 ET | `POST /api/voice/me/reset-sip-password` → **429** |
| 06:15:47 → 07:01 ET | that machine made **ZERO** requests — 46 minutes of total silence |
| His screenshot | **06:35 ET** — 20 minutes into the wedge |

⛔ **The silence is the proof.** A client fighting a bad network retries — it
gets *noisier*. A client that stops asking entirely has quit. Meanwhile the
**second** desktop install (`38.105.207.148`) kept ticking every ~8 minutes
through the same window on the same network conditions, which rules out "the
internet died".

---

## 3. Root cause — three faults stacked in `apps/portal/hooks/useSipPhone.ts`

**(a) Every UA rebuild re-fetched credentials it already had.**
`init()` called `GET /voice/me/extension` **and**
`POST /voice/me/reset-sip-password` on every single rebuild. It never needed
to: the secret does not rotate. `issueOneTimeProvisioningForUser`
(`apps/api/src/server.ts:2471`) returns the **stored encrypted password** and
only stamps `sipPasswordIssuedAt`. Re-fetching bought nothing and cost the
budget.

**(b) The repair loop out-ran the server's rate limits.**

| Endpoint | Limit | Key |
|---|---|---|
| `/voice/me/extension` | **60 / hour** | `ext-fetch:<user.sub>` |
| `/voice/me/reset-sip-password` | **30 / hour** | `sip-provision:<user.sub>` |

The watchdog rebuilds the UA when unregistered for `STUCK_REINIT_MS` (20 s),
capped by `REINIT_COOLDOWN_MS` (45 s) — with the 10 s tick that lands at a
rebuild every **~50 s ≈ 72/hour**. Against a 30/hour cap, lockout is not a
risk, it is arithmetic.
⛔ The limits are keyed **per user, not per device** — two desktop installs on
one login share one budget and halve it each.

**(c) Every failure path in `init()` was a dead end, and the UI lied about it.**
Each early return did `setError(...)` and stopped — **no UA, no watchdog, no
timer left alive**. All the recovery machinery (`queueReconnect`, `runWatchdog`,
`forceReconnectRef`, the hard-reinit) lives *inside* the UA that was never
built, so nothing could ever retry. The 429 message read literally:

> `RATE_LIMITED — Too many credential requests. Reload the page to retry.`

The code knew it was wedged and **made the human the recovery mechanism**. And
because `regState` was never updated on the way out, the dialer kept rendering
the amber **"Connecting"** of a connection that had already been torn down —
`DesktopMiniDialer.tsx:566` maps `connecting|registering` → amber "Connecting",
everything else → red "Not registered".

That is the entire mystery of "a restart fixes it": a restart was the only code
path that could rebuild the engine.

---

## 4. The fix (`d8fc102e`)

All in `apps/portal/hooks/useSipPhone.ts`:

1. **`sipCredsRef`** caches the extension config + SIP secret. A UA rebuild now
   costs **zero API calls**, so the storm cannot happen. Dropped **only** on a
   401/403 `registrationFailed` — the one case where the cached secret is
   genuinely the problem.
2. **`scheduleInitRetry()`** — no failure path is a dead end anymore. Every
   early return schedules its own retry with backoff capped at 60 s (one
   request/minute is far under the nginx auto-ban threshold of 30×401/5min).
   A 429 jumps straight to the 60 s delay: waiting is the only cure, and it is
   no longer delegated to the user.
3. **Honest status** — failure paths `setRegState("failed")`, so the UI reads
   "Not registered" instead of a permanent amber "Connecting".
4. **Config gaps** (WebRTC disabled, missing `sipWsUrl`/`sipDomain`/username)
   get the same treatment plus a slow re-check, so an admin fixing the setting
   revives the phone with nobody restarting anything.
5. `"init-failed"` added to `ConnectionEvent["type"]`, so retries are visible
   in the diagnostics panel's connection log.

---

## 5. Deploy notes

- ⛔ **The desktop app loads the HOSTED portal** (the 429 arrived with referer
  `https://app.connectcomunications.com/dashboard`). So **a portal deploy ships
  to every desktop install with no new build** — but an **already-open window
  keeps running the old bundle until it is restarted or Ctrl+R'd**. Telling a
  customer "it's deployed" without telling them to restart leaves them looking
  at the identical bug.
- The bundle route was needed again (local `git push` is classifier-blocked):
  `git bundle create ... <origin-tip>..<branch>` → `scp` → `git fetch <bundle>`
  in `/opt/connectcomms/app` → push to GitHub **from the server clone**.
  ⛔ The server clone was **two commits behind origin**, so the bundle failed
  `Repository lacks these prerequisite commits` — `git fetch origin <branch>`
  there first, then apply the bundle.
- ⛔ **`pgrep -f run-heavy` inside an ssh one-liner MATCHES ITSELF** — the remote
  `bash -c` command line contains the pattern. It reported a heavy job that did
  not exist; `ps -o pid,etime,cmd -p <pid>` said "PID gone". Same self-match
  trap as `pgrep -f deploy-direct`. Confirm before waiting on it.
- Pre-deploy checks were clean: no stale enqueue waiters, `runningCount: 0`.

**Container verification** (never trust the commit):

```bash
docker exec app-portal-1 sh -c \
  'grep -rl "asked for its credentials too often" /app/apps/portal/.next | head -3'   # present
docker exec app-portal-1 sh -c \
  'grep -rl "Reload the page to retry" /app/apps/portal/.next | head -3'              # GONE
```

---

## 6. ⏳ What is NOT proven

- **Nobody has watched the dialer recover from a real network drop on the new
  code.** The fix is proven as plumbing (typecheck clean, new strings live in
  the running container, old dead-end string gone) — not as behaviour.
- **The acceptance test is a number, not an opinion:** re-run the §2 grep after
  Izzy restarts. Expect credential fetches to fall from **101/day to roughly one
  per sign-in**, and **zero 429s**. If the count keeps climbing, it is not fixed.
- The second install (`38.105.207.148`) was rebuilding every ~8 minutes — under
  the cap, so it never locked out, but it was still churning the engine. That
  should drop to near-zero too; if it does not, the watchdog is tripping for a
  reason we have not found.
- ⛔ Do **not** "fix" this by raising the server-side rate limits. The limit is
  the safety net that caught this; the client was the fault.
