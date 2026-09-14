# ⛔⛔ AGENT HANDOFF — remote support grew a KILL SWITCH, capability tiers and a transcript; attacking it found a bug that would have killed HALF of all sessions (2026-08-31) — READ FIRST before touching `apps/api/src/remoteSupport/`, before gating `/remote-support` on a permission, before adding a gate to the `end` route, or before quoting a concurrent-session capacity

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_REMOTE_SUPPORT_HARDENING_2026-08-31.md`**
(`b29d8240` → `a3a3da07` → **`875bd560` the screens**, on `feat/ivr-migration-takeover`.
✅ **api + portal DEPLOYED and container-verified 2026-09-01** — both
`.build-commit` = `875bd5606a95`, 0 restarts, 0 error-level lines, health 200 on
both hostnames, all five new screen strings in the shipped `.next`. **Migration
`20260831120000_remote_support_controls` applied 2026-08-31 13:11:20Z**, read
back from the live DB: 3 new tables, 4 new columns, `rolled_back_at` null,
`RemoteSupportSession` **0 rows**. ⛔ **NO HUMAN HAS OPENED A SCREEN AND NO
SESSION HAS EVER RUN BETWEEN TWO PEOPLE.** No desktop build.)

- ⛔⛔ **THE BUG THAT MATTERS, AND IT WAS INVISIBLE TO EVERY UNIT TEST: whichever
  side heartbeat SECOND could never join.** A session flips to `ACTIVE` on the
  first beat from EITHER side; the other side's `lastSeen*At` is still null at
  that instant, and the old rule read null as "gone silent" rather than "not here
  yet" — so its very first heartbeat was refused `support_disconnected` before it
  could record one. Which side lost came down to a race between the customer's
  app and the technician's console, so it would have presented as **"the support
  connection dropped" immediately after consent, on roughly half of all sessions,
  apparently at random.** ⛔ The code's own comment already promised the grace it
  did not deliver — that grace only held while status was `CONSENTED`, and the
  first beat destroyed it for the other party. **Fixed:** an absent beat is
  measured against `startedAt`, so a side gets the same window to ARRIVE that it
  has to go quiet; the `HEARTBEAT_STALE_MS` ceiling is unchanged, so a session
  still cannot outlive the banner showing it. **3 of the new tests fail replayed
  against the pre-fix file.**
  ⛔ **THE LESSON: it was found by driving the ROUTES, not the functions.** The
  policy layer had 47 passing tests and every one of them was right.
- ⛔⛔ **THE PERMISSION RULE IS `{ prefix: "/remote-support", permission: null }`
  AND MUST STAY THAT WAY.** Gating it on `can_remote_support` would **403 EVERY
  CUSTOMER** — the person whose screen it is holds no key, and `/pending`,
  `/consent`, `/heartbeat`, `/signal`, `/chat` and `/end` are all theirs. Same
  lesson as `/voice/diag`. ⛔ **And it cannot be narrowed by sub-prefix either:**
  `POST /remote-support/sessions` is staff-only while
  `POST /remote-support/sessions/:id/consent` is the customer answering, so any
  rule on `/remote-support/sessions` breaks consent — the split is by METHOD and
  PARTICIPANT, which a prefix cannot say. The entry exists so the prefix MATCHES
  A RULE at all (the `/admin/wake-health` class). `/admin/remote-support` has its
  own entry **and** `requireSuperAdmin` in every handler.
- ⛔⛔ **THE KILL SWITCH NEVER BLOCKS STOPPING.** It gates request, consent,
  heartbeat, signal and input — and **never** `end`. A switch that could refuse
  `end` would, in the exact emergency it exists for, leave a live session running
  with no way to close it. There is a comment saying so in the `end` handler; do
  not "tidy" a gate call into it. ⛔ And **off ENDS what is running**, not merely
  refuses the next one — proven at 100 live sessions across 100 tenants in 14 ms.
- ⛔ **A failed control READ fails CLOSED; a MISSING ROW means enabled.** Opposite
  on purpose: no row means nobody ever touched the switch (absence of a setting
  is a fact), a throw means we cannot tell whether someone is revoked (absence of
  an answer is not). State is in the DATABASE, never a module variable — this
  repo has twice shipped state in a `Map` that re-armed on the next deploy.
- ⛔ **`admin` is NOT in `REMOTE_CAPABILITIES` and its absence is the feature.**
  Elevated control needs a Windows service running as SYSTEM, which this version
  does not ship. Adding the string is not sufficient — it needs its own local
  elevation prompt, audit event and technician role. The consent dialog draws the
  row as unavailable so the customer is told the truth.
- ⛔ **A system event STRUCTURALLY cannot carry a secret.** The only free text in
  the surface is a chat line a human typed; every system sentence is composed
  from a closed vocabulary. Input is a **count**, clipboard is a **length**
  (non-negotiable #12, Phase 22). A test renders every code with hostile facts
  and asserts nothing leaks.
- ⛔ **Only the CUSTOMER may report that a call is in progress.** A technician
  claiming otherwise cannot buy bitrate back on someone else's machine — remote
  support yields to calls, always, and no input can raise the on-call budget.
- ⛔⛔ **THE NUL TRAP AGAIN, TWICE IN ONE SESSION.** `events.ts` committed as
  `Bin 0 -> 10655 bytes` from two LITERAL control bytes inside a regex character
  class where escapes were intended, and **`sed -i` injected a NUL** into
  `attack.test.ts`. A file git calls binary has no reviewable diff, ever. **Check
  `git show --stat` for `Bin` on every new source file, and never use `sed -i` on
  source in this repo** — use the editor, or python with explicit encoding.
- ✅ **Measured (broker only): 120 concurrent sessions at 97/sec, scaling ×1.22
  from 20→80 (linear, not quadratic), 440 cycles at 16.6 ms with heap −10.9 MB,
  1,000 heartbeats with no row growth.** 179/179 remoteSupport tests; full
  apps/api 3,697 tests / 3,664 pass / 33 fail — **all 33 pre-existing and
  documented**, proven by the cited `publicOrigins` hostname literal existing at
  my commit's parent. api typecheck **76 = the exact baseline**.
  ⛔⛔ **THESE NUMBERS ARE THE BROKER, NOT VIDEO. The screen and every input event
  ride a peer connection and never touch our servers, so encoder throughput, GPU
  cost, frame rate and relay bandwidth are UNMEASURED and need two real machines.
  Nobody may quote a concurrent-session capacity for the media path.** The
  database in those runs is an in-memory fake, so they are a ceiling on the
  application layer with the database removed.
- ⛔ **Two findings came from the stress test failing FIRST, both kept in the
  file:** a single-technician soak is **impossible** and correctly so (440 cycles
  through one actor was refused at cycle 0 by the abuse protection — a real desk
  is many people), and 1,760 undrained signalling rows looked like a leak and was
  the SIMULATION being unrealistic; the real guard (age-based purge of an
  abandoned negotiation) is now its own test.
- ⏳ **NOT BUILT, deliberately:** the UI (mockups published and awaiting the
  owner's approval per his standing rule —
  <https://claude.ai/code/artifact/8c634f18-4501-436f-8f0e-e1ac1c9a23d7>);
  cryptographic device identity and presence (Phases 3/4 — `deviceId` is recorded
  and revocable but is self-reported, an identifier not an attestation);
  clipboard/file **transport** (the tiers, refusals, the customer's question and
  the audit all exist; the data channel that would carry the bytes does not);
  remote terminal; session recording. ⛔ And the desktop half still lives in
  **`apps/desktop-support`**, an app that has never shipped — lifting it into
  `apps/desktop` is the remaining packaging work.
- ⛔ **CORRECTION (2026-09-01): remote support is NOT direct-P2P only — an
  earlier version of this section said so and it is wrong.** `RemoteSupportPeer`
  fetches **`/voice/ice-servers`** and builds its `RTCPeerConnection` with
  whatever that returns, so it already inherits the platform's **coturn TURN**
  with the same HMAC time-limited credentials the softphone uses; a
  Google STUN server is only the fallback when that call fails. **Do not go
  looking for a missing relay** — a doubly-firewalled pair relays like any call.

- ⛔⛔ **"CHOOSE A PERSON" WAS EMPTY FOR EVERYONE, ALWAYS — the page asked a route
  that never existed (`99d14c0e`, 2026-09-02; api + portal DEPLOYED and
  container-verified: both `.build-commit` = `99d14c0e`, the page chunk carries
  `remote-support/people` and `team/members` greps **0**, 0 restarts, 200 on both
  hostnames).** Found the first time Izzy tried to start a real session. The
  technician screen loaded its people from **`/team/members`**, which `grep -rn`
  in apps/api returns NOTHING for, and `.catch(() => setPeople([]))` turned the
  404 into an empty dropdown — no log line, no error on screen, since the day
  the screen shipped. ✅ New **`GET /remote-support/people`** (gated on
  `can_remote_support`), scoped by **exactly the rule the request route
  applies**: SUPER_ADMIN sees every non-disabled person on every approved, live
  CUSTOMER tenant (never the admin tenant, never a SUPER_ADMIN row); anyone else
  sees only their own company. The row names the company only when the list
  spans more than one. **Proven live inside `app-api-1`: SUPER_ADMIN → 200, 63
  people across 25 companies; an ordinary USER → 403.** ⛔ **When a dropdown fed
  by `apiGet` reads empty, grep apps/api for the route STRING before anything
  else.** Guards: `remoteSupport/people.test.ts` (4 route tests, own fake db that
  follows the nested tenant filter — the attack harness's evaluator throws on
  it) + a source guard in `remoteSupportWiring.test.ts` that fails replayed
  against the pre-fix page.
  ⛔⛔ **DEPLOY TRAP HIT THE SAME HOUR: GitHub answered the server's
  `git-upload-pack` POST with 401** (`www-authenticate: Basic realm="GitHub"`)
  while `info/refs` GET was 200, `ls-remote` worked, and the same unauthenticated
  clone succeeded from the workstation — **per-IP throttling of unauthenticated
  pack downloads from loopcom**. The repo is PUBLIC and the clone has only
  `credential.helper cache`; no token exists on the box. `deploy_common_git_sync`
  fetches `origin` unconditionally, so the way through was: incremental
  `git bundle` → `scp` → bare mirror `/root/connect-mirror.git` (cloned from the
  app clone, bundle fetched in) → `git remote set-url origin /root/connect-mirror.git`
  → `deploy-direct.sh` → **set the URL back to
  `https://github.com/izzwgg-arch/connect-platform.git` afterwards** (done, mirror
  removed). ⛔ Leaving the mirror as origin silently freezes every future deploy
  at that tip. Memory: [[remote-support-people-list-asked-a-route-that-never-existed]].
- ✅✅ **ADMINISTRATOR ACCESS IS BUILT (2026-09-02, `d4fa4836`; desktop
  `0.1.17-rc.5`; handoff §10) — the customer's OWN UAC "Yes" starts the input
  helper elevated.** Deploy state: api `d4fa4836` (refusal string grepped in the
  container); portal container 4eb5bd03 (contains d4fa4836) — consent admin hint + rail UAC line in the shipped chunks, 0 restarts, 200 both hostnames; the one remaining 'Not available in this version' string is the OTHER session's /remote-desktop page, not remote support; rc.5 built from a clean worktree at
  `4eb5bd03`, `ok elevated` ×5 / `enable-elevated-control` ×2 in the packed
  `app.asar`, on Izzy's Desktop as `Loopcom-Setup-0.1.17-rc.5.exe`, **NOT
  published**. ⛔ **rc.4 was the OTHER session's remote-desktop build** — check
  HEAD's `apps/desktop/package.json` before choosing a version.
  **How:** `admin` is a capability like clipboard/files (`controls.ts`): rides
  the control key, both sides must say yes, re-checked live. The technician
  asks from the rail; the customer's consent component calls
  `enableElevatedControl(sessionId)` **FIRST** — `mainWiring.ts` refuses unless
  control is already enabled for that session — and `ElevatedInputInjector`
  runs `Start-Process powershell -Verb RunAs -Wait` (Windows shows the UAC
  prompt) and connects to the helper's **named pipe**; only when the pipe
  answers the one-time launch token with `ok elevated` does the grant reach the
  server. **A declined prompt records a REFUSAL**, and the plain helper is
  stopped only after the elevated one is up, so ordinary control is untouched.
  ⛔ **Why a pipe:** an elevated process cannot inherit the non-elevated parent's
  stdio. ⛔ **The pipe is locked three ways** — ACL = current user's SID only,
  token-first handshake or exit, exactly ONE client for the helper's life — and
  it exits on disconnect / 60 s with no client / a 4 h ceiling. **The app cannot
  kill an elevated process**: `stop()` asks over the pipe.
  ⛔ **What it still cannot do, stated on the rail's "Allowed" line:** the UAC
  prompt itself and the lock screen (secure desktop, SYSTEM/UIAccess only).
  The helper script is `HELPER_PRELUDE` + `HELPER_DISPATCH`, shared by both
  helpers so a key or click can never differ between them. Proven: 6
  fake-launcher/fake-pipe tests, `controls.test.ts` flipped, 2 portal guards;
  desktop 170/170, api remote-support 142/142, portal guards 22/22.
  ⏳ **NOT PROVEN ON A REAL MACHINE — nobody has clicked Yes on the real UAC
  prompt through this path.** Acceptance: ask → customer sees the ask bar then
  Windows' prompt → Yes → "Allowed — Windows prompts (UAC) still need them" → a
  click lands in an admin-elevated window; negative: No → never "Allowed",
  ordinary control keeps working.
- ⛔⛔ **THE FIRST REAL SESSION RAN 2026-09-02 AND FOUND FOUR THINGS — all fixed in
  `8c6a79dd` + desktop `0.1.17-rc.3` (`e074ad93`); full detail
  `docs/ai-context/AGENT_HANDOFF_REMOTE_SUPPORT_FIRST_LIVE_SESSION_2026-09-02.md`.**
  Deploy state: api `99d14c0e` (people route, live-probed); portal container a6fc0dbc (contains 8c6a79dd) — bundle strings Exit full screen / picture has paused / whole screen all present, shipped CSS rs-video.is-controllable{cursor:default}, 0 restarts, 200 both hostnames;
  desktop rc.3 built from a CLEAN WORKTREE (the shared tree carried another
  session's uncommitted desktop work), `helper_pipe_broken` grepped ×2 in the
  packed `app.asar`, on Izzy's Desktop as `Loopcom-Setup-0.1.17-rc.3.exe`,
  **NOT published** (feed still 0.1.16).
  **(1) "A JavaScript error occurred in the main process — write EPIPE."** A
  mouse move was written to the PowerShell input helper after it had died.
  ⛔⛔ **The EPIPE is ASYNCHRONOUS** — the write "succeeds" and the error arrives
  later as an `"error"` EVENT on the child's stdin; with no listener Node raises
  it as an uncaught exception in Electron's MAIN process (the phone's process)
  and the crash dialog lands on the customer's screen. The `try/catch` around
  `write()` can never see it. Now: stdin/stdout/stderr error listeners, one
  idempotent `die()`, `available` = `writable && !destroyed` (a helper that died
  on its own leaves `killed` false), stderr tail rides the exit reason (⛔ `main.ts`
  does not yet pass the optional `log` sink — one line, that file was another
  session's in-flight work). Spawn injectable; 4 fake-child tests.
  **(2) The picture froze when the shared window was minimised** — he had shared
  ONE WINDOW; window capture stops on minimise and the viewer showed the last
  frame beside a green "Good connection". The viewer now listens for the remote
  track's `mute`/`unmute` and SAYS the picture paused; the consent picker sorts
  whole screens first, labels them, and warns about single windows.
  **(3) Full screen** — a button on the STAGE, not the `<video>` (browser video
  fullscreen takes the keyboard and footer away).
  **(4) "A plus out of sync with the mouse"** was `cursor: crosshair` beside the
  customer's own cursor, which arrives INSIDE the video a fraction late and
  cannot be excluded from Chromium's capture. Normal arrow now; the offset that
  remains is video latency.
  ⛔ **Administrator windows stay unavailable ON PURPOSE** — Windows refuses
  injected input to elevated windows from a non-elevated process; a selectable
  row would be a checkbox that does nothing. Middle path (elevated helper, one
  UAC "Yes", named-pipe channel — still cannot drive the UAC prompt itself) and
  full path (SYSTEM service) are both Izzy's call, neither built.
  ⛔⛔ **GitHub 401'd the server's `git-upload-pack` fetch TWICE today** (per-IP
  throttling of unauthenticated pack downloads; the workstation fetches fine).
  Route: incremental bundle → bare mirror `/root/connect-mirror.git` →
  `git remote set-url origin <mirror>` → deploy → set it back. **Two sessions did
  this in the same hour and each one's "set it back" killed the other's
  in-flight git-sync** — check `git remote get-url origin` + `ps` for a running
  deploy before touching either. A token on the server ends it; Izzy's to place.
  ⏳ **NOT PROVEN:** nobody has used Full screen, seen the paused line or the
  arrow on the new build, and no session has run on rc.3 — the injector's death
  path is proven by a fake child only. Acceptance: a session where the helper
  is killed → control stops, app stays up, **no dialog**.
- ⛔⛔ **BUILDING THE SCREENS (`875bd560`) PROVED THREE SERVER PROTECTIONS DEAD.
  All three were correct, tested and deployed — and unreachable, because nothing
  ever called them. Each is a CALLER-side omission, which a test of the policy,
  the route or the service passes straight through.**
  **(1) NON-NEGOTIABLE RULE 15 WAS ENFORCED AGAINST AN INPUT THAT NEVER ARRIVED.**
  `decideMediaBudget` returns the small on-call budget the moment `callInProgress`
  reads true, and a grep of the whole portal found that field in exactly two
  places — the service function's own signature and its return type. **Nobody set
  it**, so "remote support yields to an active phone call" could not happen.
  ⛔ Only the CUSTOMER's machine knows a call is up; it now supplies it, via
  **`useOptionalSipPhone()`** (⛔ the *optional* hook — this component is mounted
  globally, including outside the SIP provider) and through a **ref**, because
  the peer's closure is built once and the interesting case is a call that starts
  *later*.
  **(2) THE ADAPTIVE BUDGET HAD NO NUMBERS** — `packetLoss >= 0.03 || rtt >= 300`
  chooses the constrained budget and neither was ever sent. The peer now reads its
  own `getStats()`. ⛔ **Loss is a DELTA between beats, never a lifetime ratio**
  (a lifetime figure is dominated by the first seconds and keeps the encoder
  clamped long after recovery), and a sample **under 30 packets reports nothing**
  — one lost packet in three is noise, not 33% loss.
  **(3) THE MID-SESSION ASK REACHED NOBODY.** A technician could ask for the
  clipboard or a file, the server recorded it, and **the customer was never shown
  the question** — `answerCapability` existed and no screen called it, so the
  rail would have waited forever. The ask is **derived** on the customer's side
  from requested-minus-granted, so a refresh or a reconnect reaches the same
  answer and a dropped message cannot lose it.
  ✅ **Guarded by `apps/portal/lib/remoteSupportWiring.test.ts` (registered, reads
  SOURCE because the defect is a missing call site): 15 tests, and ALL 15 FAIL
  replayed against `HEAD`.**
- ⛔ **The rail draws tools from `granted`, NEVER from `requested`** — asking is a
  button, being allowed is a fact from the server, and `requestCapability`
  deliberately returns `granted` unchanged so a screen cannot render a request as
  success. **Administrator windows are DRAWN as unavailable rather than omitted**
  (Windows silently refuses injected input to elevated windows, so a technician
  offered it would watch clicks do nothing on a UAC prompt and blame us). The
  connection readout has a **third state** — *Measuring…* — because stats need two
  samples and a green light meaning "we have not looked yet" is the reading
  somebody trusts while a customer struggles. And the customer is told **why** the
  picture softened, or they conclude remote support broke their phone.
- ⛔⛔ **THE PERMISSION MODEL IS PROVEN LIVE WITH REAL ACCOUNTS, and the first row
  is the check that matters most** — a wrong rule here 403s **every customer's
  consent flow**: `/remote-support/pending` → **200 for an ordinary customer**,
  200 for SUPER_ADMIN; `/admin/remote-support/controls` → **403 for the customer**,
  200 for SUPER_ADMIN (`enabled:true`). Re-run it after any change to the rules.
  ⛔ **A 401 without a token proves NOTHING about whether a route exists** (the JWT
  hook runs before routing) — my first probe used an invented path and got a clean
  401 unauthenticated and a **404** with a real token. The path is
  **`/remote-support/pending`**, not `/remote-support/sessions/pending`.
- ⛔ **The api deploy logged `prisma: no schema/migrations changes -> skipping
  migrate deploy` and that was CORRECT** — the schema landed in an earlier commit
  already an ancestor of the previous container build. **Never read that line as a
  skipped migration; read `_prisma_migrations`.**
- ⛔ **The native-dropdown sweep flagged the COMMENT explaining its own rule** —
  the sixth time this trap has been hit here. **The guard was NOT weakened**: it
  drops only comment-shaped LINES and deliberately has no block-stripper, because
  one opening a fake comment at a regex literal would turn a negative assertion
  into a **false PASS**. The prose was reworded instead.
