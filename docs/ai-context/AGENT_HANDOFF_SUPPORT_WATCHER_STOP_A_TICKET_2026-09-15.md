# ⛔⛔ AGENT HANDOFF — stopping ONE support ticket from being re-run (44B6TB, 2026-09-15)

READ FIRST if you are about to: kill `node watch.mjs`, hand-edit
`.watch-state.json`, answer "is ticket X still running", or stop / pause a
ticket the support watcher is working.

Area summary (one line in CLAUDE.md's HANDOFF INDEX points here):
`docs/ai-context/claude-md-sections/2026-08-31-a-customer-s-support-request-now-opens-a-claude.md`.
Code: `tools/loopcom-support-mcp/{watch.mjs,triage.mjs,run-watcher.cmd}`.

## 0. The ask and what was actually true

Izzy, 2026-09-15: *"44B6TB stop this ticket session."*

**44B6TB was already dead when he asked.** It is a PLATFORM alarm (lane
`platform`, tenant `connect-admin-tenant-v1`) — the VoIP.ms trunk guardrail for
**877-220-5058**, subaccount `344022_fox`, raised 2026-09-14 09:55. Its agent run
was claimed 2026-09-16T00:00:31.595Z and killed by the **30-minute hard timeout**
at 00:31:30.897Z:

```
"status": "failed", "attempts": 1,
"error": "run exceeded 30 min and was killed",
"report": ".../reports/44B6TB-1789516832101.md",
"sessionId": "67fda43f-bf23-43c0-ac80-5b0ccb9860a0"
```

No process, no CCD session, no `.ship-state.json` entry for it. ⛔ **The thing
that still needed stopping was the PENDING RETRY**, not a running agent. Answer
"is it running?" from `.watch-state.json` + the live process list, never from the
ticket's own `[SENT]`/`[FAILED]` badge — that badge is the ESCALATION SMS
delivery status and says nothing about the agent.

## 1. ⛔⛔ The requeue branch returns BEFORE the daily-cap check

`triage.mjs`:

```
if (prior) {
  ... stale      -> return { action: "requeue" }   // :177
  ... failedRetryable -> return { action: "requeue" }   // :190
  return { action: "skip_claimed" }
}
... if (startedToday(...) >= cap) return { action: "defer_cap" }   // :205
```

So a ticket with a prior run **never reaches the cap check**. The platform lane
was already at **3/3 for the UTC day** (44B6TB, FNPVAH, GU9ZKD) and the log was
deferring eleven other platform tickets at the cap — and 44B6TB would still have
been retried, because `failedRetryable` fires first.

⛔ **Never conclude "the cap will stop it."** The cap gates a FIRST run only.
Bounds on a retry come from `attempts < maxAttempts` (2) and the cooldowns
(`staleRunMs` 30 min, `failedRetryMs` 10 min) — nothing else.

## 2. ⛔⛔ A hand-edit to `.watch-state.json` is silently clobbered

`loadState()` is called **once**, at `main()` (`watch.mjs:389`). Everything after
that mutates an in-memory object, and `claim`/`settle`/`note` each write the
**whole file** with `saveState`. So editing the file under a live watcher writes
to something that is about to be overwritten by the next claim or settle — and
nothing anywhere reports that your edit vanished.

✅ **The procedure that works:**
1. wait until the watcher is IDLE (see §3 — this is the hard part);
2. `taskkill /PID <node watch.mjs pid> /T /F`;
3. edit `.watch-state.json`;
4. `run-watcher.cmd` restarts it (documented 30 s; measured **5 s** here) and it
   `loadState()`s your edit.

Restarting is safe for bookkeeping: `startedAt` is read from the existing state,
so the pre-existing watermark is preserved and no backfill happens.

## 3. ⛔⛔ THE ONE THAT BIT: "my ticket settled" is NOT "the watcher is idle"

My script polled `.watch-state.json` every 2 s for `claimed.GU9ZKD.status !==
"running"` and killed the watcher as soon as it saw `done`, to avoid killing a
live agent. **That reasoning is wrong**, because the poll loop iterates over
MANY tickets per poll — the watcher settles one and claims the next within the
same pass:

```
GU9ZKD  done    endedAt 2026-09-16T01:52:26.879Z
GEAGCD  running at      2026-09-16T01:52:27.497Z   <- ONE SECOND LATER
kill                    2026-09-16T01:53:50Z       <- killed a LIVE customer run
```

⛔ **The idle signal is `.watch-heartbeat.json`** — its `state` and `ticket`
fields (`working` + a ref vs `idle`). It is written on every beat precisely so a
person can see what the watcher is doing. Read that, not one ticket's status.
(The heartbeat at 01:52:27Z already said `working / GEAGCD / customer`. It was
there; I did not read it before killing.)

**Consequence and recovery.** GEAGCD was left `status: running, attempts: 1`, so
the stale-run path (`:174`) requeues it once ~30 min after its claim
(≈02:22:27Z) — the design's own recovery, working as intended. ⛔ **But the kill
SPENDS its one retry**: at `attempts 2 == maxAttempts` a second failure is
terminal and the ticket is lost in silence. Killing a live run is therefore never
free, even though it looks recoverable.

Here the cost was small — GEAGCD is **Loopcom Demo** (the demo / App Store review
tenant) asking for one website image. It could as easily have been a real outage.

## 4. What was actually changed

Only `.watch-state.json` (gitignored, local to Izzy's machine):

```json
"44B6TB": { "status": "stopped_by_owner", "attempts": 2,
            "stoppedAt": "2026-09-16T01:53:52.281Z",
            "stoppedReason": "Izzy asked to stop this ticket session (2026-09-15)." }
```

- `stopped_by_owner` is not `running` and not `failed`, so `triage` falls through
  to `skip_claimed` **forever**. `attempts: 2` is belt and braces: even if the
  status were ever put back to `failed`, `attempts < maxAttempts` is false.
- Unlike the `skipped_*` statuses it **still counts** in `startedToday` —
  correct, the run really did happen and really did consume a platform slot.
- No code change, no api/portal/worker change, no migration, no deploy, no PBX
  or VoIP.ms write.

Script used (kept for the recipe, not part of the repo):
`<scratchpad>/stop-44B6TB.mjs`. ⛔ Its first version was written through a
`bash <<'EOF'` heredoc and the `\` in its Windows paths collapsed to `\`, so
`...\tools\...` became a TAB; it died on the first read. **Write Windows paths
with forward slashes**, or use the Write tool rather than a heredoc.

## 5. Verified after the fact

- `44B6TB` → `stopped_by_owner`, and the RESTARTED watcher (fresh pid) has not
  re-claimed it.
- `GU9ZKD` → `done` at 01:52:26Z with its report — the wait did protect it.
- Watcher alive again on a new pid, polling, running FNPVAH's ship checks.
- ✅ **PROVEN, not assumed — the stale-run requeue DID fire.** A background watch
  polled the state file every 15 s and caught the re-claim:
  `02:23:06.662Z  GEAGCD  status running, attempts 2` — **30 min 39 s** after the
  original 01:52:27Z claim, i.e. the first poll past `staleRunMs`. So the
  recovery path in §3 is real, and a run killed mid-flight genuinely does come
  back on its own. ⛔ It came back at **attempts 2 == maxAttempts**: the bound is
  now spent, and if this attempt also dies the ticket is terminal and lost in
  silence. That is the true cost of killing a live run, and it is why the
  heartbeat must be read first.
- ⏳ Still open at the time of writing: that retry was **still running** at
  02:40Z (heartbeat live, 17 min in). It either settles `done` or hits its own
  30-min kill at ~02:53Z. Ordinary operation either way — nothing here depends
  on which.

## 6. ⛔⛔ CORRECTION, and the thing that actually matters: 877-220-5058 is an ORPHAN, and the SAME alarm files a NEW ticket every 6 hours

I first wrote here that 877-220-5058 is "still unregistered and callers still get
a busy signal." **That is wrong and it is the misleading direction** — it reads as
a live customer outage. `AGENT_HANDOFF_VOIPMS_DUPLICATE_SUBACCOUNTS_2026-09-02.md:249`
establishes the opposite:

> toll-free **877-220-5058** routes to `344022_fox`, which VoIP.ms answers
> `invalid_account` for (the subaccount no longer exists). It is an orphan — **no
> PBX inbound route, no `ombu_tenant_dids` row, no Connect tenant, `TenantSmsNumber`
> unassigned, 0 calls — so no customer is affected**; it needs a decision (release
> it, or route it).

⛔⛔ **And therefore stopping 44B6TB stops ONE ticket, not the noise.** The trunk
guardrail re-arms on a 6 h de-dupe (the 09-04 handoff's "it will text once" was
wrong — corrected in
`claude-md-sections/2026-09-09-the-mcp-ain-t-picking-up-tickets-pickup-is-autom.md:24`:
**20 escalations for this one orphan in 7 days**). Each re-fire is a **NEW
reference**, so it has **no prior** in `.watch-state.json` — `stopped_by_owner` on
44B6TB does nothing for it, and the new ref is claimable the moment the platform
lane has budget. It is also what spends the 3/day platform lane at midnight, which
is why eleven other platform tickets logged "platform cap 3/day reached" during
this task.

⛔ **So "stop this ticket session" cannot be satisfied durably at the ticket
level.** The durable stops are Izzy's, and all three are still untaken since
2026-09-09: **release the number**, **route it**, or **add an ignore list to the
guardrail** so a known orphan stops filing tickets. Nothing here touched VoIP.ms
or the PBX.

## 7. ✅ 2026-09-16 — muted at the source, all its tickets stopped

Izzy: *"stop that ticket and stop it from telling me this. I know it already."*

**Code (api `737331c3`, deployed + container-verified).** `IGNORED_TRUNK_ORPHANS: Map<subaccount,
exact numbers>` = `344022_fox → ["8772205058"]`. `decideTrunkVerdict` takes an optional
`ignoredOrphans` (default empty, so the pure decision and its existing fox test are unchanged) and drops
a subaccount from `unregisteredNow` only when its DID set matches exactly. `runVoipmsTrunkSweep` passes
the constant (overridable via `opts.ignoredOrphans`). Consequences traced: the audit row's
`unregisteredNow` no longer carries fox, so it is never a "previous" either; offenders/SMS/report derive
from that list; the de-dupe key is unchanged; the support-loop guardrail stops counting fresh fox
escalations as unworked because none are filed. New test proves: fox muted across 3 sweeps (0
escalations); a second number on the same dead subaccount still alarms; a real trunk (inii mini shape)
still alarms under the mute. 15/15.

**Watcher.** The 9 queued never-run fox tickets + 44B6TB are `stopped_by_owner`, `at:
2000-01-01` (never counted against the cap). Done by a script that only killed the watcher when
provably idle and re-checked immediately before the kill; the restarted watcher kept all 10.
⛔ First version of that script never proceeded: its `*Work LoopCom support ticket*` process search
matched its OWN PowerShell probe. Filter by `Name -eq 'claude.exe'`.

**Deploy race (the trap).** Two direct api deploys started 25 s apart share `/opt/connectcomms/app`.
Mine checked out `737331c3`, the other checked out `fb563e27` mid-build; my log still said
`verify: container commit 737331c3 matches target` / `success`, the container ended on `fb563e27`
with no fix. Caught only by `/app/.build-commit` + grepping for `IGNORED_TRUNK_ORPHANS`. Redeployed
after confirming no deploy process was running and that the tip added no other api change.

**Live proof.** See the line appended below by the sweep check (first sweep after the 10:52Z boot).
