# ⛔⛔ AGENT HANDOFF — a hangup clears Active Calls + Team Directory INSTANTLY now, web and mobile (2026-08-31) — READ FIRST for ANY "the call stayed on screen after hangup", before touching reconcileLiveChannels/TelephonyBroadcaster, before adding anything to the /ws/telephony stream, or before deriving "on call" on any client

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_INSTANT_HANGUP_SYNC_2026-08-31.md`**
(`2e4ebdbb` on `feat/ivr-migration-takeover`. ✅ **telephony DEPLOYED (queue job
`981abf39`, verified 0-active-calls window) and container-verified** — both fix
markers grepped ×3 in the running src, 0 restarts, AMI+ARI reconnected, 0 error
lines. Portal deploy = job `772dec09` (verify per handoff §6). ⛔ **The MOBILE
half is committed and on NO phone — it rides the next APK/TestFlight build,
Izzy's call.**) Izzy: *"I've asked this many times and I was told it was fixed…
100% in sync, instantaneous… Watch the AMI. Watch the ARI. The ARI is down, the
call is done."* Memory: [[hangup-sync-five-defects-one-symptom]].

- ⛔⛔ **"IT WAS FIXED" WAS TRUE AND USELESS — the one symptom was FIVE stacked
  defects**, each with its own lag: (1) the `/pbx` Active Calls table POLLED
  HTTP every 60s (+~30s cache) — now rides the WS feed like the dashboard;
  (2) **the delta-stream gap**: `reconcileLiveChannels` swept `getActive()`
  ONLY, so a ringing call or one that lost a leg to a missed AMI Hangup never
  got a `call.remove` pushed — clients held it until the 60s sweep (page
  refresh fixed it instantly, the tell) — now it sweeps EVERY tracked
  active-state call against ARI's raw channel list; (3) a missed sibling-leg
  Hangup left the call "up" — the store now caches the latest raw ARI set and
  **refutes stale legs at the real Hangup event** (uniqueid-epoch guarded,
  fresh NON-EMPTY snapshots only); (4) ⛔⛔ **the resurrection race** —
  `call.remove` is sent synchronously but `call.upsert` rides the async
  CRM-enrichment promise, so a late upsert re-inserted the dead call on every
  client: every call message now carries a **per-call monotonic `seq` assigned
  synchronously at emit time**, the enriched send re-checks the store
  (hungup/gone ⇒ dropped), and clients drop stale seqs (portal
  `services/callStreamOrder.ts`; mobile inline in `api/realtime.ts`);
  (5) ⛔ **mobile TeamTab OR'd the raw BLF hint into On Call** and a stale hint
  is only corrected by the 3-MINUTE presence sweep — it now mirrors the web
  rule (`screens/tabs/teamPresence.ts`): **live calls are the ONLY source of
  On Call/Ringing on every client; never OR a hint back in.**
- ⛔ **The reconciler's 2-strike + 15s-grace guards are UNCHANGED and
  load-bearing** (they prevent the 2026-08-04 wrongful-eviction class); the
  widening only extends WHICH calls are swept. An empty ARI snapshot refutes
  nothing at hangup time, ever; `uniqueidEpochMs()` returning null means
  "cannot refute", never "dead".
- ⛔ **Clients must reset their seq state on EVERY snapshot** — a restarted
  server restarts counters at 1, and stale high-water marks silently drop all
  new messages. A message with no seq (older server) is always applied.
- ✅ **STRESS-PROVEN LIVE** (Loopcom Demo only, harness in the handoff): 35
  calls — 20 echo-test, 5 ring-aborts, a 10-call concurrent burst —
  **hangup → WS remove median 163 ms, max 1.10 s, 0 resurrections, 0 messages
  missing seq, 0 leftover calls**; 28 new tests, 9 of which fail replayed
  against HEAD; suites at their documented baselines. ⛔ **When measuring this,
  join on the FIRST remove per callId** — every call legitimately emits 2–3
  removes (hangup + the 30s evict) and a greedy joiner invents multi-second
  lags. ⛔ `apps/telephony`'s test glob had NO websocket entry — added; check
  the glob before believing a broadcaster test runs.
- ⏳ **NOT PROVEN: no human has watched a screen during a real hangup since the
  deploy**, and the missed-event paths only show themselves when AMI actually
  drops an event (`ari_refuted_stale_legs_forced_hangup` /
  `ari_no_live_channel` in the telephony log are the tells). Acceptance: hang
  up a real call mid-call and mid-ring — dashboard, Team Directory and `/pbx`
  all clear within ~1s; mobile only after the next app build.
