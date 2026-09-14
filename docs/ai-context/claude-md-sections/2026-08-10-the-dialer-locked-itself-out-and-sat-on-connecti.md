# ⛔⛔ AGENT HANDOFF — the dialer locked ITSELF out and sat on "Connecting" (2026-08-10) — READ FIRST for ANY "softphone stuck on Connecting / orange" report, before adding a retry path that calls an API, and before blaming a customer's internet

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SOFTPHONE_SELF_LOCKOUT_2026-08-10.md`**
(commit `d8fc102e` on `feat/ivr-migration-takeover` — **portal DEPLOYED and
container-verified**; portal-only, nothing touching call routing or the PBX.)

- ⛔ **THE RULE: a client's own repair loop must cost fewer requests than its own
  server budget allows.** Ours cost more. Every UA rebuild re-fetched
  `/voice/me/extension` (**60/hr**) *and* `/voice/me/reset-sip-password`
  (**30/hr**) — and the watchdog rebuilds every **~50 s (~72/hr)**, so any client
  on a flapping network **reliably rate-limited itself out of its own credential
  endpoint**. It never needed to re-fetch: the secret does not rotate
  (`issueOneTimeProvisioningForUser` returns the STORED encrypted password and
  only stamps `sipPasswordIssuedAt`). ⛔ Both limits are keyed **per user, not per
  device** — two desktop installs on one login share one budget.
- ⛔ **Every failure path in `init()` was a DEAD END, and the UI lied about it.**
  Each early return did `setError()` and stopped, leaving **no UA, no watchdog,
  no timer** — all the recovery machinery lives *inside* the UA that was never
  built. The 429 message read *"Reload the page to retry"*: the code knew it was
  wedged and **made the human the recovery mechanism**. And `regState` was never
  updated on the way out, so the dialer kept rendering the amber **"Connecting"**
  of a connection already torn down. That is the whole mystery of "restarting
  fixes it". Fixed via `sipCredsRef` (rebuilds now cost **zero** API calls) +
  `scheduleInitRetry()` on every path + honest `setRegState("failed")`.
- ⛔ **THE DIAGNOSTIC, one grep — and the SILENCE is the proof:**
  `grep "reset-sip-password" /var/log/nginx/access.log | grep "connect/desktop"`.
  The User-Agent names the client (`@connect/desktop/0.1.5 … Electron`) so you can
  separate desktop from browser from mobile. On 2026-08-10 it showed **101
  fetches** from one desktop (healthy = **one per sign-in**), one every ~50 s,
  a **429 at 06:15:47 ET**, then **46 minutes of ZERO requests** — while a second
  install on the same network kept ticking every ~8 min. **A client fighting a bad
  network gets NOISIER; a client that stops asking has quit.** Izzy's screenshot
  was stamped 06:35 — 20 minutes into the wedge. He said it wasn't his internet
  and he was right. ⛔ Nginx logs are **CEST = his clock + 6h**.
- ⛔ **The desktop app loads the HOSTED portal**, so a portal deploy reaches every
  install with **no new build** — but an **already-open window keeps the old
  bundle until it is restarted**. "It's deployed" without "now restart it" leaves
  the customer looking at the identical bug.
- ⛔ **Deploy traps re-confirmed:** `pgrep -f run-heavy` in an ssh one-liner
  **matches its own command line** and invented a heavy job that did not exist
  (`ps -o pid,etime,cmd -p <pid>` → "PID gone") — same self-match as
  `pgrep -f deploy-direct`. And the server clone was **two commits behind
  origin**, so the incremental bundle failed `Repository lacks these prerequisite
  commits` — `git fetch origin <branch>` there FIRST, then apply the bundle.
- ⏳ **NOT PROVEN: nobody has watched the dialer recover from a real network drop
  on the new code.** Proven as plumbing only (typecheck clean, new strings live in
  `app-portal-1`'s `.next`, old dead-end string gone). **The acceptance test is a
  number:** re-run the grep above — fetches should fall from **101/day to ~one per
  sign-in**, with **zero 429s**. ⛔ Do NOT "fix" a recurrence by raising the
  server-side limits; the limit is the safety net that caught this.
