# AGENT HANDOFF — CDR silent loss + live-call sync hardening (2026-08-04)

Session: started from "RelaxTires ext 101 doesn't see his calls from today" and
ended with the CDR pipeline and the live Active-Calls/BLF picture hardened in
production. Everything below is deployed and verified live unless marked open.

## TL;DR for a future agent

- **Calls were being permanently ERASED from every tenant's call history** —
  ~100–200/day since ~June, invisible until a customer stared at an empty day.
  Root cause was NOT the Aug-2 tenant-leak fixes; it was the live-call tracker
  wrongly killing calls + a CDR filing chain with single points of failure.
- Fixed by commits **`5060032f`** (4-layer CDR loss protection),
  **`2f0850e7`** (orphan-net fork-leg guard), **`aa3115d4`** (live-sync
  rewrite: channel-truth liveness, exact-second hangup, snapshot union,
  tenant-correction rebroadcast). All deployed to prod via the deploy queue
  from branch `feat/ai-agent`; telephony container verified running them.
- **332 lost calls (Aug 1–4) were backfilled** from the PBX's own CDR table
  through the real `/internal/cdr-ingest` endpoint. Pre-Aug-1 losses are NOT
  backfilled (open item).
- Post-deploy soak: 52 calls / 22 hangups / **0 wrongful evictions / 0 errors**
  (the old code killed a live call every few minutes).

## The original bug chain (why calls vanished)

1. `reconcileActiveBridges` (CallStateStore) force-evicted any bridged call
   whose bridges were missing from the latest ARI poll snapshot.
   The snapshot lies two ways:
   - **Stale**: taken before several awaits in the poller tick; a call bridged
     0.8s earlier looked absent (Relax Tires linkedId `1785860821.162724`,
     evicted 20s into a 5-minute call).
   - **Blind by design**: `computeBridgedActiveCalls` "qualifying bridge"
     rules require ≥2 non-Local channels per bridge. A queue/ring-group call
     is TWO half-bridges (trunk↔Local, Local↔agent), each with ONE non-Local
     leg — both excluded, always. **Every queue call looked dead.**
2. Eviction emitted only `callRemove`, never the hungup `callUpsert` that
   drives CdrNotifier → nothing filed at eviction.
3. The call stayed in the store only 30s (`HANGUP_RETAIN_MS`). If the real
   AMI Cdr events arrived later (any call >30s past eviction), `onCdr` found
   no call and silently returned → **the record never existed anywhere**.
4. Separately: CdrNotifier retried a failed ingest POST only 3×/~7s — every
   api-container deploy permanently ate the calls that ended during it.

## What shipped (all in prod)

### `5060032f` — CDR can never be lost again (4 independent layers)
1. Reconcile eviction needs 2 consecutive absent polls + 15s young-call grace.
2. EVERY eviction path (`forceEvictZombie`, ghost sweep, duration-stale,
   `clearAll` on AMI disconnect) emits **`callEvicted`** → CdrNotifier files a
   provisional record. Wired in `telephony/index.ts` straight to the notifier —
   deliberately NOT via `callUpsert` (no push/broadcast side effects).
3. **Orphan-CDR net**: an AMI Cdr event whose linkedId isn't in the store is
   synthesized into a minimal call (`synthesizeCallFromCdrEvent`) and filed.
   Times come from the linkedId epoch + durations — NEVER parse the PBX's
   local-time strings (they're timezone-skewed; `UNIX_TIMESTAMP(calldate)` on
   the PBX MySQL is ~4h off).
4. **Durable retry queue**: failed posts go to Redis `telephony:cdr:retry:v1`,
   drained every 30s until the API accepts. Survives api AND telephony
   restarts. 4xx = fatal (don't retry); 5xx/network = queue.

### `2f0850e7` — orphan net must skip queue fork legs
A queue ring fans one `Local/` leg per agent; each leg's Cdr event carries no
parent linkage so its linkedId collapses to its own uniqueid. Filing those
created **one phantom "missed call" row per agent per ring**. Guard: skip
orphan filing when channel starts `Local/` AND `linkedId === uniqueid`.
A Local leg carrying its PARENT's linkedId (ring-group forward legs — the
forwarded call's ONLY Cdr records on this PBX) still files. A self-rooted
PJSIP leg (normal outbound) still files.

### `aa3115d4` — live screen in exact sync
1. **`reconcileLiveChannels` replaces `reconcileActiveBridges`**: a call is
   dead only when NONE of its channel uniqueids exist in ARI's **raw
   /channels list** (`BridgedActiveResult.rawChannelIds`, new field). ⛔ Never
   use the qualifying-bridge list for liveness decisions — that's the exact
   mistake that killed live calls for months. Poller now emits `update`
   BEFORE its enrichment awaits (less snapshot staleness).
2. **Exact-second hangup**: `onHangup` resolves the recorded channel name via
   uniqueid (Asterisk masquerade renames — `<ZOMBIE>` — never matched the
   exact-string filter, leaving stuck calls until the 60s sweeper), and a call
   with zero live channelIndex entries ends IMMEDIATELY regardless of stale
   channel strings.
3. **WS page-load snapshot = UNION** of the AMI store + ARI-only bridges
   (was either/or: one qualifying bridge anywhere hid every tracked
   non-qualifying call — a portal opened mid-queue-call showed nothing).
4. **Tenant isolation on the live feed**: when the T-marker corrects a
   mislabelled call's tenant mid-call, the store now emits `callRemove` first
   (broadcast to ALL) so the WRONG tenant's screens clear that second; the
   follow-up upsert re-adds it for the right tenant only. Previously the wrong
   company watched someone else's call for its whole duration. Rest of the
   isolation chain audited OK: `buildTenantFilter` (null-tenant → admins
   only), `SnapshotService` same rule, `tenantAliasesEqual(null,·)=false`.

Tests: `CallStateStore.cdrLoss.test.ts` — 13 tests including exact replicas of
the live incidents (fresh-bridge stale-snapshot kill, the Gesheft
non-qualifying-bridges kill, masquerade-rename stuck call, fork-leg phantom,
tenant-correction rebroadcast). Suite: 148/151 — the 3 failures are
pre-existing `src/smarthome/*` env-validation failures, untouched.

## The backfill (332 calls restored)

- Script pattern preserved on loopcom at `/tmp/backfill-lost-cdrs.js` (also in
  this machine's session scratchpad). Input: TSV export of `asterisk.cdr` legs
  (read-only) → group by linkedid → diff vs ConnectCdr → POST through the real
  ingest endpoint (so attribution/direction/dispo-merge apply).
- ⛔ **Seed-post trick is mandatory**: the ingest handler push-notifies
  missed calls on BRAND-NEW rows. Post each call first with
  `disposition:"unknown"` (creates row, no push), then the real payload.
- Direction must be patched post-hoc for inbound: the PBX's trunk legs write
  NO cdr row, so the API's heuristic sees only tenant-side contexts and stores
  "outgoing". The DID column is ground truth.
- The PBX `cdr` table groups fork legs under the parent linkedid — backfill by
  linkedid grouping produces NO phantoms (unlike the AMI event stream).
- Verification: all 2,452+ PBX calls Aug 1→now have ConnectCdr rows, 0
  unattributed, 0 wrong-tenant.

## Phantom-row cleanup (done, reversible)

The orphan net's first hour (before `2f0850e7`) filed ~63 phantom per-agent
rows. They are **hidden, not deleted**: `isForwarded=true` (the
`/voice/me/calls` endpoint filters `isForwarded:false`). Real calls were
distinguished by **trunk-channel presence** (`PJSIP/` not followed by `T\d+_`
in channelsSeen — fork legs never have one) and unhidden. If any customer
reports a missing call from Aug 4 evening, check `isForwarded=true` rows first.

## Deploy / ops notes

- Deploy queue: `POST http://127.0.0.1:3910/ops/deploy/enqueue`, token from
  `DEPLOY_QUEUE_TOKEN` in `/opt/connectcomms/env/.env.platform`, body
  `{"service":"telephony","branch":"feat/ai-agent",...}`. Jobs run serially;
  poll `/ops/deploy/jobs`. Branch `feat/ai-agent` is the deploy branch; local
  work lands on `feat/ivr-migration-takeover` and fast-forwards into it
  (verify `git merge-base --is-ancestor` before pushing — another session
  commits to the same branch concurrently).
- An api deploy job `57d2a298` (18:07 UTC, another session's) FAILED at
  restart — not investigated here.
- ⚠️ Session mishap, resolved: a `git stash push` with a bad pathspec (`-C`
  changed git's cwd) popped the OLD stash@{0} ("mobile cold-boot + iOS DND",
  June-era) into the working tree, conflicting 4 mobile files
  (IncomingCallFirebaseService.java, withIosVoipPush.js,
  NotificationsContext.tsx, voipPush.ts). All 4 restored to HEAD;
  **stash@{0} itself is intact in the stash list** — do not drop it.

## Open items

1. **Pre-Aug-1 backfill**: losses go back to ~June (~100–200/day). Same
   script + wider PBX export works. Needs Izzy's go-ahead (volume).
2. `src/smarthome/*` tests fail locally on env validation (pre-existing).
3. The `test` tenant (T21) had 1 unresolvable call in the backfill window.
4. Longer soak: only ~10 min of clean runtime observed at handoff. Watch
   `zombie_force_evicted` (should stay ~0; each one now files a CDR),
   `cdr-retry-queue` depth (should stay 0), `TENANT_CORRECTED` (each one now
   rebroadcasts a remove), and `filing orphan`/`filing provisional` lines.
