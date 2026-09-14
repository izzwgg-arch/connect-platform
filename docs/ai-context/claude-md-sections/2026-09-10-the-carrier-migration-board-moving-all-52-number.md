# ⛔⛔ AGENT HANDOFF — the CARRIER MIGRATION BOARD: moving all 52 numbers off VoIP.ms to SignalWire, a few at a time, with no downtime (2026-09-10) — READ FIRST before porting ANY number out of VoIP.ms, before touching `apps/api/src/carrierMigration/`, before flipping a customer's texting to SignalWire, or for "a number landed and nothing happened"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CARRIER_MIGRATION_2026-09-10.md`**
(`ed316ed1` on `feat/ivr-migration-takeover`, pushed. ✅ **api + portal DEPLOYED and
container-verified; migration `20260910190000_carrier_migration` applied. The
`CarrierMigration` table holds 0 rows, so NOTHING has changed for any customer.** No
PBX write, no carrier write, no env change, no tenant row touched.)
Mockups Izzy approved: <https://claude.ai/code/artifact/3b688663-3fb6-4c27-9afd-34a5ba6317bb>
Izzy: *"start porting out all numbers from voip.ms, not all at once, start very slowly
with the first two … zero downtime for customers on voice and SMS"* → *"we're going to
pour them into SignalWire"* → *"Build it. Commit, push, deploy it."*

- ⛔⛔ **A NUMBER IS NOT ONE SWITCH. IT IS THREE, ON THREE DIFFERENT CLOCKS — collapsing
  them is how a customer loses texting.** **Calls coming in move BY THEMSELVES**: Main's
  `default-trunk` routes on the DIALLED NUMBER and both carriers' inbound contexts
  converge there (SignalWire's `[trk-132-in](+) exten => s` lifts the DID out of the
  `To:` header and `Goto`s the same place VoIP.ms does), so **nothing has to be switched
  at the moment of the port** — the only gap is between the number landing on the
  SignalWire account and its handlers being pointed at our trunk. **Texts: inbound moves
  by itself too** (`ingestInboundSmsToChat` matches on `phoneE164` with **no provider
  filter**, so both carriers can be armed at once and the thread continues), **but
  OUTBOUND does not** — SignalWire refuses to send from a local number that is not on an
  approved 10DLC campaign, so the campaign must be active BEFORE the number moves or the
  customer can receive texts and not answer them. **Calls going out are PER CUSTOMER**:
  one outbound route, one caller ID, on the PBX — so a customer's numbers move as a
  BLOCK, and SignalWire signs at **attestation C** until the account is vetted.
- ⛔ **Connect does not mirror the PBX's outbound trunk**, so the board reports outbound
  **readiness** and never claims to know what the PBX is doing. Do not "improve" that
  into stored state you cannot verify.
- **State at build time (read from production):** **52 active numbers, 27 customers, 15
  carrying texting, 0 on SignalWire.** `TenantSmsRegistration` holds **ZERO rows** — no
  brand, no campaign — and that is the long pole (3–5 business days) blocking every
  number that texts. Attestation is not granted. SignalWire credentials ARE stored and
  **trunk 132 is proven live** (a real call reached a ringing extension, 2026-08-18).
- ⛔⛔ **THE WATCHER FAILS CLOSED AND POINTS ONLY WHAT A PERSON FILED.**
  `arrivalWatcher.ts` sweeps every 30 s (45 s boot kick — a bare `setInterval` is starved
  on a busy deploy day) and claims a number ONLY when its row is `filed`/`landing`, not
  held, not already pointed, and the number is really on the SignalWire account. A number
  that turns up unfiled — a test number, one bought by hand — is **ignored**, because we
  do not own the intent behind it. ⛔ **It never moves texting** (source-guarded):
  flipping `TenantSmsNumber.provider` on a timer takes a customer's outbound texting away
  with no way back. ⛔ **A carrier call is made only when something could land today** — a
  row whose confirmed date is in the future costs nothing and the sweep exits
  `quiet: true`. ⛔ **No endpoint means the number is not touched at all** — a number
  pointed at the wrong SIP endpoint is a customer whose calls go somewhere else.
  ⛔ **The proof it ran is the `carrier_migration.sweep` audit row**, written on EVERY
  completed pass including quiet ones — never the boot line. Kill switch
  `CARRIER_MIGRATION_WATCH_DISABLED=1`.
- ⛔ **`/filed` is RECORD-ONLY — SignalWire has NO porting API**, so the filing is a
  person in their dashboard and a source guard pins that the route never contacts a
  carrier. `/claim` asks the SAME question the sweep asks (`decideClaim`), so a button
  can never do what the timer would refuse. `/sms-switch` is gated by `decideSmsSwitch`.
- ⛔ **Two number shapes, one converter.** `PbxTenantInboundDid.e164` is **bare 10
  digits**; `TenantSmsNumber.phoneE164` and SignalWire are **`+1…`**.
  `carrierMigrationE164()` is the one place they convert — a join written against the
  wrong one silently matches nothing.
- ⛔ **`PROTECTED_DIDS` carries the platform's own senders WITH THE REASON:**
  **(845) 723-1213** sends every pay link, receipt and sign-in code (its texting breaking
  breaks billing) and **(845) 557-7768** carries the escalation texts. Both are flagged
  on the board and must not be in the first waves — nor should McNamara Lion (mid
  overdue-cutoff countdown), Gesheft (busiest inbound texting) or Trust Bookkeepings
  (10 numbers, one caller ID, must move as a block).
- ✅ **Recommended order: (845) 305-0012 Loopcom Demo 2 first** — ours, one number, no
  texting, and the board already reads **"Ready to file"** — then (347) 978-0090 (ours,
  texts, proves the 10DLC half, **blocked until the registration is approved**), then one
  boring single-number customer.
- ✅ **Proven:** 37 tests (⛔ `src/carrierMigration/*.test.ts` had to be ADDED to
  `apps/api/package.json` — the documented unregistered-test trap, and the guard that
  checks the registration is itself in that file); **all 10 source guards fail replayed
  against HEAD**; api typecheck **84 = the exact baseline**, 0 in new code; portal 0.
  **Driven live against production** with a 120-second self-signed SUPER_ADMIN token
  inside `app-api-1`: no token → 401, board → 200,
  `summary {total:52, onVoipms:52, onSignalwire:0, textingNumbers:15, customers:27}`,
  gates `tendlc=blocked | attestation=pending | voice=ok` (**the voice gate resolving OK
  proves SignalWire is genuinely reachable and the PBX endpoint discoverable**), the
  protected DIDs flagged, an unknown number → 404 in plain English. **The sweep is
  genuinely running** — `carrier_migration.sweep` rows 30 s apart, `quiet: true`,
  `considered: 0`, i.e. alive and correctly making **no carrier call** while nothing is
  filed. Containers: both `.build-commit = ed316ed1`, **0 restarts**,
  `/admin/carrier-migration` 200 on both hostnames (⛔ verify the portal by STRING —
  `cm-drawer-back` in the CSS, `admin/carrier-migration/board` in the chunk — never a
  function name; minification renames them).
- ⏳ **NOT PROVEN: nobody has opened the page, no port has been filed, and the watcher
  has never claimed a real number.** Acceptance is §7 of the handoff, and the negatives
  matter most: **an unfiled number appearing on the SignalWire account must be IGNORED**,
  a held number must never be claimed, and a texting number must refuse the SMS switch
  while the registration is unapproved.
- ⏳ **Four decisions are Izzy's and two gate real work:** start the 10DLC brand +
  campaign now (nothing that texts can move until it is approved); has the attestation
  vetting ticket been opened (until it is, every customer's outbound calls stay on
  VoIP.ms — correct, since SignalWire signs C and carriers label those spam, proven live
  2026-08-18); confirm the first two are our own numbers; and what the customer is told.
  ⛔ There is also **no LOA generator for a port-OUT** — `onboarding/portQueue.ts` makes
  one from an `OnboardingSubmission`, and an existing customer's number has none, so
  filing today means assembling the pack by hand.
- ✅ **FIXED 2026-09-10 — the escalation dispatcher was being crashed BY ITS OWN LOGGING.**
  `agentEscalationDispatch.ts:138` did `(done ? log?.info : log?.warn)?.(…)`. That reads
  the method off pino and calls it **detached**, so `this` is lost and pino throws
  `TypeError: Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')`
  from inside the log call. The throw is in the **per-row loop**, so the call site's
  `.catch` logged **"agent escalation dispatch failed"** — the logger's own crash wearing
  delivery's name — and the rest of the batch never went out. **Escalations are how the
  platform texts Izzy when something breaks.** Now `if (done) log?.info?.(…)` /
  `else log?.warn?.(…)`, which keeps the binding. From commit `242d1a40`; seen live on
  production 2026-09-10.
  ⛔ **Never write `(cond ? log.info : log.warn)(…)`, `const l = log.info`, or pass a pino
  method as a callback** — a pino method only works called ON its logger.
  **Proven, not assumed — INSIDE THE RUNNING PRODUCTION CONTAINER.** `app-api-1` runs
  **pino 10.3.1** (the workstation has 9.14.0 — check, do not assume); on 10.3.1 the old
  shape throws that exact TypeError and the fixed shape logs fine. A 5-row loop demo goes
  from **1 of 5 rows dispatched to 5 of 5**. Typecheck is differential (before vs after produce
  an identical error set). ⛔ The api test suite was **NOT** run — this worktree has no
  `node_modules` and nothing imports this file under test.
  **The repo-wide sweep found NO other instance.** apps/, packages/, scripts/, services/,
  worker/ were scanned for every detaching shape — ternary, assigned to a variable,
  destructured off the logger, passed as a callback — and the scanner was **self-tested
  against the original line first**, so "clean" means checked, not merely quiet.
  ✅ **DEPLOYED + CONTAINER-VERIFIED 2026-09-10** (api at `5f9d9642`, blue/green, health
  check passed). In `app-api-1`: the fixed lines are present, the old shape is gone from
  `/app/apps/api/src`, and `pino.msgPrefix` + `"agent escalation dispatch failed"` are both
  at **0**. Before the deploy the same container showed **3 `pino.msgPrefix` crashes and
  exactly 3 "dispatch failed" lines — 1:1**, which is the proof the "failures" were the
  logger, not delivery.
  ⏳ **NOT YET seen on a REAL escalation**, because the queue is empty — the last 6 rows are
  all `SENT` with `attempts=1`. ⛔ **Nothing was ever lost to this bug**: the row's DB
  update runs BEFORE the log line, so each escalation had already delivered (SMS + email)
  and been recorded when the logger crashed. The real damage was a **false alarm** — the
  one channel that reports trouble crying "dispatch failed" — plus a latent risk that only
  bites under load: escalations arrived one at a time today, so the abandoned remainder of
  each batch was empty. Had 2+ ever queued together (an incident storm, exactly when it
  matters), rows 2..5 would have been pushed to later 30 s sweeps, burning `attempts`.
  To prove the success path end to end, a synthetic row must be inserted — ⛔ that TEXTS
  IZZY on both phones and emails the alert inbox, so ask first.
