# AGENT HANDOFF — a hangup clears Active Calls and Team Directory the instant it happens, web AND mobile (2026-08-31)

Izzy, 2026-08-31 (after being told twice before that this was fixed): *"If
somebody hangs up a call, in Active Calls, it should hang up when it says 'on
call.' In Team Directory, it should be in sync instantly… Right now it stays
there for another minute… Watch the AMI. Watch the ARI. The ARI is down, the
call is done."* Then: *"the same in mobile… It shouldn't wait another three
minutes until the app realizes this person has hung up."*

Commit **`2e4ebdbb`** on `feat/ivr-migration-takeover` (private-index commit —
the CAS caught another session's commit landing mid-build and rebuilt cleanly).
**telephony DEPLOYED (queue job `981abf39`, 0-active-calls window) and
container-verified** (both markers grepped in the running container's src ×3,
0 restarts, AMI connected + ARI `pbx_reconnect_success`, 0 error-level lines).
**portal deploy queued behind it** (job `772dec09` — verify per §6).
⛔ **The MOBILE half is committed and on NO phone** — it rides the next
APK/TestFlight build, which needs Izzy's word.

## 1. Why "it was fixed" was true and useless — FIVE defects stacked

Each had a different lag signature; fixing any one left the others looking like
"still broken":

| # | Where | Mechanism | Lag |
|---|---|---|---|
| 1 | portal `/pbx` page | Active Calls table polled `GET /pbx/live/combined` every **60s**, on top of a ~30s server cache | up to ~90s |
| 2 | telephony store | `reconcileLiveChannels` iterated **`getActive()` only** — a ringing/dialing call, or one that dropped below 2 valid legs after a missed AMI Hangup, vanished from snapshots but **never got a `call.remove` on the delta stream**; connected clients kept it until the 60s ghost sweep. (Page refresh fixed it instantly because `SnapshotService.getSnapshot()` runs `runStaleCleanup()` — the exact "reload fixes it, waiting takes a minute" shape.) | up to 60s |
| 3 | telephony store | one leg's Hangup missed (rename/AMI gap) → the sibling's real Hangup left the call `"up"` with a stale leg | up to 60s |
| 4 | broadcaster + all clients | `call.remove` broadcast **synchronously**, `call.upsert` rides the **async CRM-enrichment promise** (≤2.5s) — a late upsert delivered after the remove **re-inserted the dead call** on every client; nothing corrected it until the 30s evict / 60s sweep | 30–60s, intermittent |
| 5 | mobile TeamTab | `livePresence` **OR'd the raw BLF hint** (`inuse`/`busy`/`onhold`) into On Call; a stale hint is only corrected by the telephony service's **3-minute** `refreshExtensionPresence` sweep (`index.ts:329`). The web team page has always refused bare hints (`presenceFromLiveCalls`) — mobile didn't. | up to 3 min |

⛔ **The AMI happy path was NEVER the problem** — a clean final Hangup already
emitted remove synchronously (the `aa3115d4` exact-second work). The lag lived
in the fallback paths and the clients.

## 2. What shipped

**telephony `CallStateStore.ts`:**
- `reconcileLiveChannels` **widened to EVERY tracked call in ACTIVE_STATES**
  (was `getActive()`), so ringing/dialing/one-leg leftovers are reconciled
  against ARI's raw channel list too. ⛔ The 2-strike + young-call/young-bridge
  grace guards are UNCHANGED — they are what prevents the 2026-08-04 wrongful
  evictions; never remove them. A call with zero indexed uids is skipped
  (nothing to refute; the ghost sweep owns that shape). Worst-case fallback for
  a missed event: ~10s (2 × 5s polls), 15–20s young.
- **Hangup-time ARI refutation**: the store caches the latest raw ARI channel
  set (`lastAriChannelSet` + timestamp, written on every reconcile pass);
  `onHangup`, when channels remain, consults `ariRefutesCallChannels()` — every
  remaining indexed uid absent from a **fresh (≤20s), NON-EMPTY** snapshot that
  the uid **provably predates** (uniqueid-epoch ≥8s older than the snapshot) ⇒
  the call ends NOW at the real Hangup event, refuted uids dropped from the
  index. ⛔ The epoch guard is the safety against the stale-snapshot lie; the
  non-empty guard means an ARI hiccup returning `[]` can never end calls at
  hangup time (the strike-guarded reconciler covers a genuinely idle PBX).
  `uniqueidEpochMs()` is exported and unit-tested; it returns null on anything
  implausible and **null must always mean "cannot refute", never "dead"**.

**telephony `TelephonyBroadcaster.ts`:**
- **Per-call monotonic `seq`** on every `call.upsert`/`call.remove`, assigned
  **synchronously at emit time** (`nextCallSeq`) — so seq order == emit order
  even when delivery is late. Counters GC'd 10 min after last touch (piggybacks
  the health-broadcast timer).
- The async enriched send **re-checks the store at send time** — call gone or
  `hungup` ⇒ the stale upsert is dropped (protects OLD clients that don't
  understand seq yet).

**portal:**
- `services/callStreamOrder.ts` — `createCallSeqTracker`: drops upserts whose
  seq ≤ the last applied message for that call (tombstones survive removes, map
  capped at 2000, oldest pruned). ⛔ **Reset on EVERY snapshot** — a restarted
  server restarts its counters at 1; stale high-water marks would silently drop
  every new message. ⛔ Messages with no seq are ALWAYS applied (never stricter
  than the server). Wired into `hooks/useTelephonySocket.ts` (both snapshot
  paths reset; upsert gated; remove noted).
- `/pbx` page: the Active Calls table + KPI now come from
  `useTelephony().activeCalls` scoped via `callsForTenant` (the dashboard's
  idiom, incl. the one-shot extension-rows fetch); a 1s duration tick runs only
  while calls are on screen. **The 60s HTTP poll survives ONLY for CDR-today
  metrics and endpoint registration counts.**
- `types/liveCall.ts`: `seq?: number` on `LiveCall`.

**mobile:**
- `screens/tabs/teamPresence.ts` (NEW, pure — extracted from TeamTab so it is
  node-testable): `livePresence` now mirrors the web rule — **live calls are
  the ONLY source of On Call/Ringing**; a busy/ringing-shaped hint with no live
  call is Available; `idle` → Available; no hint → Offline. ⛔ Never OR the
  hint back in.
- `api/realtime.ts`: same seq-drop rule inline (reset on snapshot), plus an
  **AppState foreground reconnect** — on `active`, if the socket is not
  OPEN/CONNECTING, reconnect immediately with fresh backoff (a reconnect always
  yields a fresh snapshot, correcting anything missed while backgrounded).
  ⛔ Never force-close a CONNECTING socket there — its late onclose clobbers
  the replacement and double-connects.
- `types/index.ts`: `seq?: number`.

## 3. Proof — tests

- `apps/telephony/src/telephony/state/CallStateStore.instantHangup.test.ts` —
  9 tests. **5 fail replayed against HEAD** (the widened sweep + hangup-time
  refutation); the 4 that pass on both trees are the safety invariants (live
  channels never evicted, young-call grace, empty-snapshot refuses, no-snapshot
  refuses) — that is by design.
- `apps/telephony/src/telephony/websocket/TelephonyBroadcaster.seq.test.ts` —
  4 tests incl. THE RACE (enrichment resolving after hangup delivers nothing)
  and out-of-order delivery carrying emit-time seqs. **4/4 fail against HEAD.**
  ⛔ `apps/telephony`'s test glob had NO `src/telephony/websocket/*.test.ts`
  entry — added; a broadcaster test was structurally unrunnable before.
- `apps/portal/lib/liveCallInstantSync.test.ts` — 9 tests (tracker rules + two
  wiring guards: the hook uses the tracker; the /pbx page renders WS calls and
  `activeCalls?.calls` from the polled payload appears nowhere). Registered in
  the portal's explicit test list.
- `apps/mobile/src/screens/tabs/teamPresence.test.ts` — 6 tests (the stale-hint
  shape, live-call precedence, tenant isolation) + source guards (TeamTab
  imports the shared module and has no second `livePresence`; realtime.ts keeps
  the seq drop + AppState listener). Registered as `test:team-presence`.
- Suites: telephony **284/287** (3 = the documented pre-existing smarthome
  local-shell failures), portal **420/423** (2 documented pre-existing + 1 =
  another session's in-flight SignalWire wizard WIP, not ours). Typechecks:
  telephony **41 = exact baseline** (the 2 TelephonyBroadcaster entries are the
  pre-existing `snapshotTimer.unref` ones, line-shifted), portal 0, mobile 0.

## 4. Proof — live stress run (2026-08-31, Loopcom Demo T102 only)

Harness (both preserved in the session scratchpad): `ws-watch.js` on loopcom —
mints a 60-min SUPER_ADMIN token from `JWT_SECRET`, connects to the real
`wss://…/ws/telephony`, logs every call message with ms timestamps, flags
resurrections and missing seqs; `stress-driver.sh` on the PBX — 20 sequential
echo-test calls (`Local/*43@T102_cos-all`, answers instantly, rings NO
hardware), 5 ring-aborts at demo ext 101 (hung up mid-ring; demo phones buzz
briefly), and a 10-call concurrent burst, hangups via
`channel request hangup <exact channel>`. ⛔ **Never `hangup request all`** — a
real customer call could be live. Both clocks NTP-verified before trusting
cross-machine deltas (loopcom 1.2ms off; PBX synchronized).

**Results — 35 calls, 128 upserts, 105 removes:**
- **hangup → first WS remove: median 163 ms, p95 ~1.0 s, max 1.10 s** (the ~1s
  cases are the ring-aborts tearing down wake-dial legs; negative values are
  removes that beat the ssh command's own return — faster than measurable).
- **RESURRECTIONS: 0.** Missing seq: 0 of 233 messages. Leftover channels
  after every phase: 0. Stragglers: 0. No real customer call was touched.

⛔ **Analysis trap worth keeping: a greedy hangup→remove joiner reads the
duplicate removes as multi-second latencies.** Every call legitimately emits
2–3 removes (hungup-upsert remove + callRemove + the 30s evict) — join on the
FIRST remove per callId or the numbers lie exactly like the bug you fixed.

## 5. What is deliberately NOT changed

- The 2-strike + 15s grace reconciler guards, `HANGUP_RETAIN_MS` (30s store
  retention — invisible to clients, needed for late Cdr correction), the 60s
  ghost sweep (now a rarely-reached last resort), the 5s ARI poll cadence.
- The `bridge:<id>` ARI-only-row remove diff in `index.ts` (~5s — those rows
  never came from AMI and have no faster signal).
- `TelephonyContext`'s `state !== "hungup"` client filter.
- The mobile 3-minute presence refresh (it is now only re-sync for
  available/offline, which is its proper job).

## 6. Verify / accept

- Telephony container: `docker exec app-telephony-1 grep -c
  ariRefutesCallChannels /app/apps/telephony/src/telephony/state/CallStateStore.ts`
  → ≥1 (runs from src via tsx — there is no dist).
- Portal (job `772dec09`): grep the shipped chunk for the minified survivor of
  `callStreamOrder` — e.g. `grep -rl "acceptUpsert" /app/.next/static/chunks`
  in `app-portal-1`, and the /pbx page chunk for `Updates: instant on hangup`.
  ⛔ An already-open tab/desktop window keeps the OLD bundle until reloaded.
- **Human acceptance:** two phones on one tenant + a portal window on Team
  Directory and the dashboard; hang up mid-call and mid-ring — the row must
  clear and the person flip to Available within ~1s on every surface. On
  `/pbx`, same. Mobile: ONLY after the next app build ships.
- ⏳ **NOT PROVEN:** no human has watched a screen during a real hangup since
  the deploy; the missed-hangup paths (widened reconcile + ARI refutation) are
  proven by unit test + the code in the container, not by a live missed event —
  they are, by nature, only observable when AMI drops an event
  (`ari_refuted_stale_legs_forced_hangup` / `ari_no_live_channel` in the
  telephony log are the tells).

## 7. Open

1. ⏳ **Mobile build + publish** — the TeamTab/realtime fixes reach phones only
   with the next APK (fleet) + TestFlight build. Izzy's call, per the standing
   publish rule.
2. ⏳ The `/pbx` page's OTHER tiles still poll at 60s (CDR-today counts,
   endpoint registration) — correct for CDR data, stated on the page.
3. ⚠️ Noticed in passing (tracer findings, untouched): the dashboard's IVR
   analytics fetch uses backslashes in a template literal
   (`dashboard/page.tsx:196` — malformed URL), and
   `crm/wallboard/page.tsx:728,1014,1043` has `\` where `/` and `</Link>` are
   intended. Pre-existing, not in scope.
4. ⚠️ The 3rd portal-suite failure belongs to another session's in-flight
   SignalWire wizard work (their files were mid-edit in the shared tree).
