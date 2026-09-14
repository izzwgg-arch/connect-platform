# ⛔⛔ AGENT HANDOFF — TURN health watch: Izzy is TEXTED when the call relay dies, and its first version was silently BLIND (2026-08-21) — READ FIRST before touching `turnHealthWatch.ts`, before adding ANY monitor whose state lives in `AgentAuditLog`, or before answering "is TURN working for regular calls?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TURN_HEALTH_WATCH_2026-08-21.md`**
(api DEPLOYED and PROVEN RUNNING — 15 heartbeats over 24.9 min at the 2-minute
interval, all `state: ok`. No migration, no PBX write, no env change.)
Izzy: *"when there's ever an issue or the turn server is ever down, I should get
a text message."*

- ⛔⛔ **THERE ARE TWO TURN SERVERS ON THIS BOX — never reason about one from the
  other.** Regular phone calls = **coturn**, host service, PRIMARY IP
  45.14.194.179, ports 3478/5349, relay 49152-65535. Video meetings =
  **LiveKit**, container, SECOND IP 169.58.213.204, port 443, relay
  30000-30049. **This watcher covers coturn only.**
- ✅ **REGULAR CALLS ARE HEALTHY, proven not asserted (2026-08-21):** a real TURN
  allocation with live credentials from `/voice/ice-servers` relayed 200 bytes
  each way with **0% packet loss**; from outside, UDP 3478 answers a genuine STUN
  Binding Success. coturn has **not restarted since 2026-08-11**, ten days before
  the second-IP work, and its IP/ports/relay range never overlapped any of it.
- ✅ **The alarm** raises an `AgentEscalation` (⛔ the ONLY channel that reaches a
  phone; `ADMIN_ALERT` is muted at the send door and a source guard forbids it).
  Real STUN Binding Request, not a port check. 3 consecutive bad checks before it
  texts, one text per fault, one all-clear, cert-expiry warning at 10 days.
  ⛔ It probes the urls clients ACTUALLY get, from env **and the `TurnConfig`
  rows** — `TURN_TLS_URL` is UNSET in prod while the `turns:` url comes from the
  DB, so an env-only monitor would silently never check TURNS.
- ⛔⛔⛔ **ITS FIRST DEPLOYED VERSION RECORDED NOTHING AND COULD NEVER HAVE
  TEXTED.** `AgentAuditLog` requires **`actor` and `hash`**; both were missing, so
  Prisma rejected every write while a `.catch(() => {})` swallowed the error. With
  no stored streak the counter never passed 1 and the threshold of 3 was
  unreachable. **Everything looked fine**: file in the container, boot line
  `TURN_HEALTH_WATCH_ARMED`, hand-run returning `{state:"ok"}`.
  ⛔ **AN "ARMED" LOG LINE IS NOT PROOF A MONITOR WORKS — QUERY ITS STATE ROW.**
  `select count(*) from "AgentAuditLog" where event='turn_health.check'`; zero
  means blind. ⛔ **Never swallow a write whose row IS the state** (best-effort is
  right for an audit trail, wrong for an alarm's memory) — that failure is loud
  now. ⛔ And **the fake db accepted anything, which is why 17 green tests sat on
  a write that could never succeed** (the service-interruption shape); it now
  enforces Prisma's required columns and all 5 runner tests fail against HEAD.
- ⏳ **NOT PROVEN: no alert has ever fired** — nothing has broken. A deliberate
  test really does text (562) 209-6644 and (845) 723-1213, so ask Izzy first.
  ⚠️ The watcher lives in the api, so if the api is down nothing checks — the
  same accepted limitation as every other guardrail here.
