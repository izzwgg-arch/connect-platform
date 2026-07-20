# PW-2+ Live-PBX Runbook — extra-careful, T21-first

_Version 1.0 — 2026-07-19. Owner: Izzy. Pilot tenant: **T21 "Landau Home"** (label `test`). Author: Claude (Cowork)._

## The one rule above all others

> **Nothing that exists on the PBX right now is modified, in any way, shape, or form.**
> Every validation CREATES a new, clearly-marked throwaway object, verifies it, then
> DELETES it. Existing tenants, extensions, IVRs, DIDs, routes, ring groups, queues,
> and time conditions are proven **byte-identical before and after** every single step.
> If any before/after check differs by one byte → STOP, roll back, do not proceed.

**Pilot scope:** all first-time validation happens ONLY on **tenant 21 (Landau Home)**.
T21 today has exactly **one** extension — **101 "Home"** — which is **off-limits, never
touched**. Throwaway test objects use the reserved number **9001** (and 9002 if needed),
which do not exist anywhere in T21. Only after T21 is fully proven do we roll out wider.

**Every window is:** owner (Izzy) present · off-hours · one object type at a time ·
snapshot → act → verify-new → verify-existing-unchanged → roll back the throwaway →
verify clean. No batching, no shortcuts.

---

## 0. Prerequisites (do once, before any window)

- [ ] **P-0.1 — Owner present + off-hours window agreed.** Confirm low/no live-call time (Watchman load guard also blocks if the PBX is busy).
- [ ] **P-0.2 — Fresh full snapshot of T21.** Read-only dumps saved on loopcom (NOT the PBX), timestamped:
  ```bash
  # from the loopcom sandbox, over the PBX read-only key:
  ssh -i /tmp/pbx_key root@209.145.60.79 \
    'for t in ombu_extensions ombu_extensions_vm ombu_devices ombu_inbound_routes \
              ombu_ivrs ombu_ivr_entries ombu_ring_groups ombu_ring_group_members \
              ombu_time_conditions ombu_queues; do \
       echo "-- $t --"; mysql -N -B -e "SELECT * FROM ombutel.$t WHERE tenant_id=21 ORDER BY 1"; \
     done' > /var/backups/t21-baseline-$(date +%Y%m%dT%H%M%S).txt
  ```
  Keep this file. Every "verify unchanged" step diffs against it.
- [ ] **P-0.3 — Global VitalPBX backup exists.** Confirm a recent `vitalpbx make-backup` is available (owner-run, read the list only). This is the whole-system safety net; we never rely on it, but it must exist.
- [ ] **P-0.4 — Whole-PBX config checksum.** Capture a hash of the generated Asterisk config so we can prove the *running dialplan* is untouched:
  ```bash
  ssh -i /tmp/pbx_key root@209.145.60.79 \
    'find /etc/asterisk -type f -newermt "1970-01-01" -printf "%p %s\n" | sort | sha256sum'
  ```
  Record the hash. Re-check after each window — it may only change for the throwaway object and must return to baseline after rollback.
- [ ] **P-0.5 — API connectivity (agent side, loopcom only).** Set `PBX_BASE_URL` + `PBX_API_TOKEN` in `/opt/connectcomms/env/.env.platform` (currently empty). This lets the executor reach the API for the API-native creates. Agent-side only; does not touch the PBX.
- [ ] **P-0.6 — Kill switch reachable.** Confirm `AGENT_KILL_SWITCH=1` (or `AGENT_ENABLED` unset) halts the agent instantly, and that `AGENT_PBX_LIVE_WRITES` is currently **unset**.

---

## Window A — API-native creates (the real PW-2). Lowest risk.

Validates: **create tenant, create queue, create device** — all via the official VitalPBX
API (audit-confirmed real endpoints). These are the safest because the API does its own
integrity handling.

**A does NOT create a throwaway tenant on the live box** unless you want the full path; the
gentler pilot is to validate **queue + device under T21** (throwaway 9001), since T21 already
exists. Tenant-create is validated last, as its own sub-step, because a tenant is the largest object.

1. [ ] Baseline: capture P-0.2 dump + P-0.4 hash.
2. [ ] Enable live writes for ONLY the API caps, ONLY for this window:
   ```bash
   # agent side, loopcom:
   AGENT_PBX_LIVE_WRITES=1  # + flip liveEnabled:true for pbx.P5, pbx.P11 only
   docker compose ... up -d --no-deps agent
   ```
3. [ ] **Queue (P11):** create queue `ZZ-TEST-QUEUE-9001` under T21 via the agent action (owner auto-approve). Verify it exists via API read.
4. [ ] **Device (P5):** create a throwaway device on a throwaway extension context. Verify via API read.
5. [ ] **Verify existing unchanged:** re-dump T21 (P-0.2) and diff against baseline — the ONLY new rows must be our throwaway queue/device; extension **101** row must be identical. Re-check P-0.4 hash.
6. [ ] **Roll back:** delete the throwaway queue + device (owner-run). Re-dump + re-hash → must return to baseline exactly.
7. [ ] Disable live writes (`AGENT_PBX_LIVE_WRITES` unset, liveEnabled back to false). Redeploy agent.
8. [ ] **Sign-off:** record the before/after diffs (empty except throwaways) in the ledger.

---

## Window B — Extension + voicemail-to-email via the helper. Medium risk (DB + gen-conf).

Validates: `connect-create-extension-helper.sh` — the DB-insert + scoped `gen-conf` path.

1. [ ] **Install the helper on the PBX** (owner-run, one-time): copy `scripts/pbx/connect-create-extension-helper.sh` to the PBX (e.g. `/usr/local/bin/`), `chmod 700`. This is placing a script only — it writes nothing until invoked with `--commit --owner-window`.
2. [ ] Baseline: P-0.2 dump + P-0.4 hash.
3. [ ] **DRY-RUN first (writes nothing):**
   ```bash
   ssh -i /tmp/pbx_key root@209.145.60.79 \
     '/usr/local/bin/connect-create-extension-helper.sh --tenant-id 21 --ext 9001 \
        --name "PW2 Test" --email "izzywkg@gmail.com" --vm'
   # prints the plan + SQL, writes nothing. Confirm the SQL only INSERTs ext 9001.
   ```
4. [ ] **COMMIT (throwaway 9001 only):** re-run with `--commit --owner-window`. The helper: pre-checks 9001 is free, snapshots T21, inserts ext 9001 + its VM row, runs `gen-conf`, verifies, and would auto-rollback on any failure.
5. [ ] **Verify new:** ext 9001 exists, mailbox row exists, voicemail-to-email set to izzywkg@gmail.com.
6. [ ] **Verify existing untouched:** diff T21 dump vs baseline — only new rows are 9001 + its VM. **Ext 101 "Home" row byte-identical.** P-0.4 dialplan hash changed only for 9001's context.
7. [ ] **Register a phone to 9001** (optional) and leave a test voicemail → confirm it emails izzywkg@gmail.com. Proves the whole path works.
8. [ ] **Roll back:** delete ext 9001 + its VM row (helper supports this, or owner-run), `gen-conf`, verify T21 dump + dialplan hash return to baseline **exactly**.
9. [ ] **Sign-off.**

---

## Window C — Device attach to the new extension (API). Runs only if B passed.

1. [ ] Recreate throwaway ext 9001 (from B) or use a fresh 9002.
2. [ ] Create a PJSIP device on 9001 via the agent (P5, API). Optionally `send_welcome_email` to izzywkg@gmail.com.
3. [ ] Verify device registers (a softphone can log in). Verify T21 otherwise unchanged.
4. [ ] Roll back device + extension. Verify baseline restored.

---

## Window D — Operational actions A1–A12 (reversible). Validate before customer use.

Only the **reversible** ones, on throwaway ext 9001 (never 101):
1. [ ] **A7 DND** on 9001 → verify set → auto-revert fires → verify cleared → T21 unchanged.
2. [ ] **A1 forwarding** 9001 → 101-context test target, short TTL → verify → auto-revert → verify cleared.
3. [ ] Confirm every action emailed izzywkg@gmail.com and audit-logged.
4. [ ] Roll back throwaway ext. Baseline restored.

**IVR switch (A3), ring groups, time conditions, outbound routes are NOT validated in the
pilot** — they're DB+gen-conf, higher blast radius, and T21 has no IVR to safely test against.
They get their own dedicated windows later, each with a throwaway object, only if/when you
want them live.

---

## Window E — Full tenant create (largest object). Last, most careful.

1. [ ] Create a throwaway tenant `ZZ-PW2-TESTCO` via the agent (P1, API) — a NEW tenant, so it cannot affect any existing one.
2. [ ] Run the full bulk plan against it: 1–2 throwaway extensions + voicemail + device.
3. [ ] Verify the new tenant works end to end; verify **T21 and every other existing tenant** byte-identical (spot-check 3 tenants' dumps).
4. [ ] **Delete the throwaway tenant entirely.** Verify no orphan rows; verify all existing tenants unchanged.
5. [ ] **Sign-off:** this proves owner onboarding end-to-end without touching anything real.

---

## Rollout (only after A–E all green on T21)

- **R-1:** Enable owner-mode provisioning for **real T21 use** first (Landau Home) — you create real extensions there and live with it for a few days.
- **R-2:** Extend to 2–3 more low-risk tenants you choose, one at a time, each with a baseline snapshot + verify-unchanged.
- **R-3:** General availability across the PBX, still owner-approved per action, still snapshot-per-tenant.
- Every stage keeps: kill switch, additive-only, ownership ledger, per-op approval, auto-revert, live-load guard, before/after verification.

## Hard stops (any of these = abort + roll back immediately)

- Any existing row differs before/after.
- The `/etc/asterisk` config hash doesn't return to baseline after rollback.
- Watchman reports elevated PBX load, or any active call on an affected object.
- A `gen-conf` warning/error of any kind.
- Any verify step is ambiguous. When in doubt, we stop — never "try again."

## What never happens, even in a window

- No edit or delete of any pre-existing tenant/extension/IVR/DID/route/queue/time-condition.
- No global reload or PBX service restart.
- No trunk/SIP-transport/network change.
- Nothing touching payments or pension.
- No unattended run — owner present for every live write in every window.
