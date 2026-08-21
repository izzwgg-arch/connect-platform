# AGENT HANDOFF — TURN health watch: Izzy gets a text when the call relay dies (2026-08-21)

Izzy, 2026-08-21: *"Make it so that when there's ever an issue or the turn
server is ever down, I should get a text message."*

Built as **`apps/api/src/turnHealthWatch.ts`**, wired in `server.ts`
(`startTurnHealthWatch`), 18 tests. **DEPLOYED and PROVEN RUNNING** — 15
heartbeats across 24.9 min at the 2-minute interval, all `state: ok`.

## §1 What it watches, and what it is NOT

⛔⛔ **THERE ARE TWO TURN SERVERS ON THIS BOX AND CONFUSING THEM IS THE TRAP.**

| | Regular phone calls | Video meetings |
|---|---|---|
| Server | **coturn** (host service) | **LiveKit** (container) |
| IP | 45.14.194.179 (primary) | 169.58.213.204 (second IP) |
| Ports | 3478 udp+tcp, 5349 TLS | 443 TLS |
| Relay range | 49152–65535 | 30000–30049 |

**This watcher covers coturn only** — the relay behind ordinary calls. A fault
in one says nothing about the other. (LiveKit's TURN has its own separate,
still-unresolved relay problem — see the video-meetings handoff §7.)

## §2 The design

- **Probes the SAME urls the api hands clients**, gathered from BOTH sources
  `resolveWebrtcConfig` uses: env (`TURN_SERVER`, which expands to udp+tcp
  exactly as `buildEnvIceServers` does) **and the `TurnConfig` rows**. ⛔ That
  db half is load-bearing and was nearly missed: `TURN_TLS_URL` is UNSET in
  production, yet clients ARE handed
  `turns:app.connectcomunications.com:5349` — it comes from the database. A
  monitor built on env alone would silently never check TURNS, which is exactly
  where a silent certificate expiry would bite.
- **A real STUN Binding Request**, not a port check. A reply with type `0x0101`
  proves the server is *answering*; an open socket proves nothing.
- **Three states.** `down` = nothing answered. `degraded` = some answered and
  some did not — ⛔ **this is deliberately alertable**: UDP dead while TCP
  answers is a real fault (most call media is UDP) that a naive up/down check
  calls healthy.
- **Certificate expiry** warned at 10 days. A failed renewal breaks relayed
  calls silently.
- **Edge-triggered, de-duped, state in `AgentAuditLog`** (never a module
  variable — the api restarts dozens of times a day). 3 consecutive bad checks
  before it texts, one text per fault, one all-clear on recovery. Resolving the
  escalation row re-arms the alarm.
- ⛔ **The alarm is an `AgentEscalation` row — the ONLY channel that reaches a
  phone.** `ADMIN_ALERT` is muted at the send door: it would build clean, log
  clean and reach nobody. A source guard forbids it and forbids the module
  growing its own `emailJob.create`.

## §3 ⛔⛔ THE BUG THIS SHIPPED WITH, AND HOW IT WAS CAUGHT

**The first deployed version recorded NOTHING and was structurally incapable of
ever texting.**

`AgentAuditLog` requires **`actor`** and **`hash`** (sha256 tamper evidence).
Both were omitted, so Prisma rejected every write — and the call was wrapped in
`.catch(() => {})` with a comment saying "the check must never fail on its own
bookkeeping". But that row is **not bookkeeping, it IS the state**: with no
stored streak the counter never advanced past 1, so the alert threshold of 3
could never be reached.

The symptoms were perfectly reassuring: the container carried the file, the boot
line `TURN_HEALTH_WATCH_ARMED` appeared, and a hand-run returned
`{state: "ok", alerted: false}`. **It was caught only by querying for the
heartbeat row in production and finding zero.**

⛔ **THE RULES THIS EARNS:**
1. **An "armed" log line is not proof a monitor works. Query its state row.**
   `select count(*) from "AgentAuditLog" where event = 'turn_health.check'` — a
   zero there means the alarm is blind however healthy everything looks.
2. **Never swallow a write whose row IS the state.** Best-effort is right for a
   pure audit trail and wrong for the memory an alarm depends on. That failure
   is now LOUD (`could not record state — the alarm is BLIND until this is
   fixed`).
3. ⛔ **The fake db in the tests accepted anything, which is why 17 green tests
   sat on top of a write that could never succeed** — the same shape as the
   service-interruption suite that passed because its fake ignored
   `where.status`. The fake now enforces the required columns exactly as Prisma
   does, and all 5 runner tests fail against the old code.

## §4 Operating it

- **Is it alive?** `select max(ts) from "AgentAuditLog" where event =
  'turn_health.check'` — within ~2 minutes means healthy. The payload carries
  `state`, `streak`, `alerted`, `certDaysLeft` and a per-transport result list.
- **Tuning** (all env, restart to apply): `TURN_HEALTH_INTERVAL_MS` (default
  2 min), `TURN_HEALTH_DOWN_STREAK` (3), `TURN_HEALTH_CERT_WARN_DAYS` (10),
  `TURN_HEALTH_TARGET` (override), `TURN_HEALTH_WATCH_DISABLED=1` (off switch).
- **Alarm prefixes are the de-dupe keys** (`TURN_ALARM_PREFIX`): renaming one
  orphans its de-dupe and lets a persistent fault text on every cycle.

## §5 State at handoff

✅ Running and verified: 15 checks / 24.9 min, all three transports OK
(`stun_type_0x101`, `connected`, cert 61 days left), `actor=system` and a
sha256 `hash` on every row, 0 escalations (correct — nothing is wrong).

✅ Separately proven the same day, answering Izzy's actual question: **coturn is
healthy for regular calls.** A real allocation with live credentials from
`/voice/ice-servers` relayed 200 bytes each way with **0% packet loss**, and
from outside the network UDP 3478 returns a genuine STUN success. coturn has not
restarted since 2026-08-11 — ten days before any of the second-IP work — and its
ports, IP and relay range never overlapped anything built for meetings.

⏳ **NOT PROVEN: no alert has ever fired**, because nothing has broken. The
acceptance test is the first real outage, or a deliberate one — ⛔ which really
does text (562) 209-6644 and (845) 723-1213, so ask Izzy first.
⚠️ Note the watcher lives in the api: if the api itself is down, nothing checks.
That is true of every guardrail here and is an accepted limitation, not an
oversight.
