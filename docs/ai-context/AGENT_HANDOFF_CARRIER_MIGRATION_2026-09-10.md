# AGENT HANDOFF — the carrier migration board: moving all 52 numbers from VoIP.ms to SignalWire (2026-09-10)

> Izzy, 2026-09-10: *"within the next few days, we are going to start porting out all
> numbers from voip.ms, not all at once, and start it very slowly with the first two
> numbers to see what the process is and how it works. I want to set up a system where
> the swaps are going to be with zero downtime for customers on voice and SMS.
> Obviously, I will ask customers for 10 DLC before we switch them"* → *"we're going to
> pour them into SignalWire"* → *"make a new page in admin and show me mockups before you
> build"* → mockups approved → *"Build it. Commit, push, deploy it, and we're going to run
> a test."*

Commit **`ed316ed1`** on `feat/ivr-migration-takeover`.
**api + portal DEPLOYED and container-verified; migration applied. 0 rows in the new
table, so nothing changed for any customer.** No PBX write, no carrier write, no env
change, no tenant row touched.

Mockups: <https://claude.ai/code/artifact/3b688663-3fb6-4c27-9afd-34a5ba6317bb>

Read this before touching `apps/api/src/carrierMigration/`, the arrival watcher, or
before porting any number out of VoIP.ms.

---

## 1. The one idea the whole thing rests on

⛔⛔ **A number is not one switch. It is THREE, on three different clocks. Collapsing
them is how a customer loses texting.**

| Lane | Moves how | The catch |
|---|---|---|
| **Calls coming in** | **By itself** | Main's `default-trunk` routes on the DIALLED NUMBER, and both carriers' inbound contexts converge there (`[trk-132-in](+) exten => s` lifts the DID out of SignalWire's `To:` header and Gotos the same place VoIP.ms does). So **nothing has to be switched at the moment of the port.** The ONLY gap is between the number landing on the SignalWire account and its handlers being pointed at our trunk. |
| **Texts** | **Inbound by itself; outbound does NOT** | `ingestInboundSmsToChat` (`connectChatRoutes.ts:2331`) looks a number up by `phoneE164` with **NO provider filter**, so both carriers can be live at once and the thread continues seamlessly. But SignalWire **refuses to send from a local number that is not on an approved 10DLC campaign** — so the campaign must be active BEFORE the number moves, or the customer can receive texts and not answer them. |
| **Calls going out** | **Per CUSTOMER, not per number** | One outbound route with one caller ID per tenant, on the PBX. So a customer's numbers move as a BLOCK — split them and the outbound caller ID belongs to a carrier that no longer holds it. And SignalWire signs at **attestation C** until the account is vetted. |

⛔ **Connect does not mirror the PBX's outbound trunk**, so the board reports outbound
**readiness** and never claims to know what the PBX is actually doing. Do not "improve"
this into a stored state you cannot verify.

## 2. Live state at build time (read from production 2026-09-10)

- **52 active numbers, 27 customers, 15 carrying texting.** 0 on SignalWire.
- **10DLC: `TenantSmsRegistration` holds ZERO rows.** No brand, no campaign. This is the
  long pole — 3–5 business days — and it blocks every number that texts.
- **Attestation: not granted** (no way to read it programmatically; see §5).
- SignalWire credentials ARE stored; **trunk 132 is proven live** (a real call reached a
  ringing extension, §10 of `AGENT_HANDOFF_SIGNALWIRE_PIVOT_2026-08-18.md`).
- `ONBOARDING_NUMBER_PROVIDER`, `SIGNALWIRE_AUTO_PROVISION`, `SIGNALWIRE_PBX_SIP_ENDPOINT_ID`
  are all **unset** — irrelevant to a port-out (which does not go through onboarding), but
  the endpoint resolver self-discovers from the anchor number either way.

## 3. What was built

**`apps/api/src/carrierMigration/board.ts`** — the pure rules, so they can be driven
without a database or a carrier.
- ⛔ **`carrierMigrationE164()` is the ONE place the two number shapes convert.**
  `PbxTenantInboundDid.e164` stores **bare 10 digits** (`8453050012`);
  `TenantSmsNumber.phoneE164` and SignalWire store **`+18453050012`**. A join written
  against the wrong one silently matches nothing.
- `buildGates()` — the three account-level gates.
- `buildBoard()` — inventory × migration rows × sms rows → per-number lanes, blockers,
  per-customer grouping and outbound readiness.
- `decideClaim()` / `decideSmsSwitch()` — the two decisions that touch a carrier or a
  customer's texting, plus `explain*()` so a screen never shows a slug.
- `PROTECTED_DIDS` — the platform's own senders, **with the reason**, not a bare list.

**`apps/api/src/carrierMigration/arrivalWatcher.ts`** — the piece that makes zero
downtime real. 30-second sweep + **45-second boot kick** (a bare `setInterval` is starved
to nothing on a busy deploy day).
- ⛔⛔ **FAILS CLOSED. It points ONLY a number a person filed that is still waiting.** A
  number that turns up on the SignalWire account unfiled — a test number, one bought by
  hand — is **ignored**, because we do not own the intent behind it.
- ⛔ **It never moves texting** (source-guarded). Flipping `TenantSmsNumber.provider` on a
  timer would take a customer's outbound texting away with no way back.
- ⛔ **A carrier call is only made when something could actually land today.** A row whose
  confirmed date is in the future costs nothing; the sweep exits `quiet: true`.
- ⛔ The endpoint is resolved lazily and once per sweep; **no endpoint means the number is
  not touched at all** — a number pointed at the wrong endpoint is a customer whose calls
  go somewhere else.
- ⛔ **The proof it ran is the `carrier_migration.sweep` audit row**, written on EVERY
  completed pass including quiet ones — never the boot line.
- Kill switch `CARRIER_MIGRATION_WATCH_DISABLED=1`; `CARRIER_MIGRATION_WATCH_MS` /
  `_BOOT_MS` tune it.

**`apps/api/src/carrierMigration/routes.ts`** — `requireOwner` (SUPER_ADMIN) on every
handler, plus a `PORTAL_API_PERMISSION_RULES` entry so the prefix is not silently outside
the global gate (the `/admin/wake-health` class).
- ⛔ **`/filed` is RECORD-ONLY** — SignalWire has no porting API, the filing is a person in
  their dashboard. A source guard pins that it never calls a carrier.
- ⛔ **`/claim` asks the SAME question the sweep asks** (`decideClaim`), so a button can
  never do something the timer would refuse.
- `/sms-switch` is gated by `decideSmsSwitch` before the write.

**`apps/portal/app/(platform)/admin/carrier-migration/`** — the board, built to the
approved mockups: the three gates first (nothing below them is safe), the progress strip,
the estate grouped by customer with the three lanes as three columns, a per-number drawer,
and the event feed. Owner-only in **both** nav gates (`isNavItemVisibleForUser` force line
+ `OWNER_ONLY_FIXED_NAV_ITEMS`), key `can_view_admin_carrier_migration` in the shared
catalog.

**Schema**: `CarrierMigration`, migration `20260910190000_carrier_migration` —
**one new table, nothing altered**, generated by `prisma migrate diff`.

## 4. Proven

- **37 tests**, registered in `apps/api/package.json` (⛔ `src/carrierMigration/*.test.ts`
  had to be added — the documented unregistered-test trap; the guard that checks the
  registration is itself in the file).
- ⛔ **All 10 source guards fail replayed against `HEAD`** (`CM_GUARD_ROOT=<archive of HEAD>`).
- Typechecks: api **84 = the exact baseline**, 0 in new code; portal **0**; shared **0**.
  Neighbours green: portal nav/permission suites 26/26, shared permission suites 70/70.
- **Driven live against production** with a 120-second self-signed SUPER_ADMIN token
  against `127.0.0.1:3001` inside `app-api-1`:
  - no token → **401**; board → **200**
  - `summary: {total: 52, onVoipms: 52, moving: 0, onSignalwire: 0, textingNumbers: 15, customers: 27}`
  - `gates: tendlc=blocked(Not started) | attestation=pending(Needs you) | voice=ok(Ready)`
    — **the voice gate resolving OK proves SignalWire is genuinely reachable and the PBX
    endpoint is discoverable**, not merely that credentials exist
  - Loopcom Demo 2 (845) 305-0012 → **"Ready to file", no blockers**
  - Relax Tires (845) 776-1765 → **"Blocked — texting is not registered"**
  - Connect Communications (845) 723-1213 → **protected: YES**, both blockers
  - unknown number → **404** with a plain sentence
- **The sweep is genuinely running**: `carrier_migration.sweep` audit rows 30 s apart,
  `quiet: true, considered: 0` — i.e. it is alive and correctly making **no carrier call**
  while nothing is filed.
- Containers: api + portal both `.build-commit = ed316ed1`, **0 restarts each**;
  `/admin/carrier-migration` **200 on both hostnames**; shipped CSS carries
  `cm-drawer-back` and the client chunk carries `admin/carrier-migration/board`
  (⛔ verify by STRING, never a function name — minification renames them).

## 5. What is NOT built / needs Izzy

1. ⛔ **The 10DLC brand + campaign has not been filed.** Nothing that texts can move.
   The filing chain exists (`signalWireTenDlc.ts`) and is gated on
   `SIGNALWIRE_AUTO_PROVISION`.
2. ⛔ **Attestation is an owner-confirmed env flag, `SIGNALWIRE_ATTESTATION_GRANTED=1`** —
   there is no API to read it. Until it is granted, the board holds every customer's
   outbound calls on VoIP.ms, which is correct: SignalWire signs C and carriers label
   those calls spam (proven live 2026-08-18 — two calls to Izzy's cell read ANSWERED in
   the CDR and were his carrier's spam intercept).
3. **The outbound switch itself is a PBX change** — the board reports readiness only.
4. **No LOA generator for port-OUT.** `onboarding/portQueue.ts` generates one for
   port-INs from an `OnboardingSubmission`; an existing customer's number has no
   submission. Filing today means assembling the pack by hand.
5. ⛔ **A port is not reversible in minutes** — reversing means porting back, days.
   That is why the first two should be our own numbers.

## 6. The recommended order

- **First: (845) 305-0012, Loopcom Demo 2.** Ours, one number, no texting. Exercises the
  entire mechanism with nothing at stake. The board already reads **"Ready to file"**.
- **Second: (347) 978-0090, Loopcom Demo.** Ours, carries texting, and its outbound
  already runs through SignalWire — so it proves the 10DLC half. **Blocked until the
  registration is approved.**
- **Then one boring real customer**: NY Garden Sprinkler, Yossis Wood Works or Solidify
  Concrete — single number, no texting.
- ⛔ **Held back:** Connect Communications (845) 723-1213 (every pay link, receipt and
  sign-in code — flagged in `PROTECTED_DIDS`), Landau Home (845) 557-7768 (escalation
  texts — also flagged), McNamara Lion (mid overdue-cutoff countdown), Gesheft (busiest
  inbound texting), Trust Bookkeepings (10 numbers, one caller ID, must move as a block).

## 7. Acceptance — what the first real test looks like

1. Open `/admin/carrier-migration`. Confirm 52 numbers, the three gates, and that
   Loopcom Demo 2 reads **Ready to file**.
2. File (845) 305-0012 at SignalWire by hand; record the reference + confirmed date in
   the drawer. The row goes `filed`.
3. On the day: the sweep promotes it to `landing` and starts checking every 30 s.
4. When it lands: `carrier_migration.claimed` in the audit with a **gapSeconds** figure,
   the board shows **Live on SignalWire** and "pointed at us in Ns".
5. ⛔ **The negatives that matter most:** a number nobody filed that appears on the
   SignalWire account must be **ignored**; a held number must never be claimed; and a
   texting number must refuse the SMS switch while the registration is unapproved.

## 8. Traps paid for building this

- ⛔ **`git stash` in this shared worktree** — used once for a typecheck baseline, and
  another session committed in the window. Nothing was lost (their work went into
  `38c618b1`/`69ae1b37`), but the standing rule is right: never stash here. Use
  `git archive HEAD <paths>` into a temp dir instead — which is also how the source
  guards were replayed.
- ⛔ **`prisma migrate diff --from-migrations` needs a shadow database.** With none
  available, `--from-schema-datamodel <old> --to-schema-datamodel <new>` needs no DB at
  all: `git show HEAD:packages/db/prisma/schema.prisma > /tmp/old.prisma`.
- ⛔ **`apps/api/package.json`'s test script has JSON-ESCAPED quotes** (`\"src/…\"`), so a
  replace searching for `"src/…"` matches nothing and silently does not register the test.
  The registration guard caught it.
- ⛔ **`@prisma/client` does not resolve from `/app/apps/api`** — a probe script there
  dies `MODULE_NOT_FOUND`. Get ids from psql and keep the probe dependency-free, or run
  from `/app/packages/db`.
- ⛔ **A React `key` belongs on the mapped element** — with a fragment wrapping grouped
  rows, that is the fragment, not the first `<tr>` inside it.
- ⛔ The api's lib includes DOM, so `setTimeout` returns a `number` and `.unref()` does
  not typecheck — cast.

## 9. Noticed in passing, NOT mine, filed separately

⛔ **`agentEscalationDispatch.ts:138` crashes its own logger.**
`(done ? log?.info : log?.warn)?.(…)` extracts the pino method and calls it detached, so
`this` is lost and pino throws
`TypeError: Cannot read properties of undefined (reading 'Symbol(pino.msgPrefix)')`. The
outer catch then logs **"agent escalation dispatch failed"** — which is the logger's
crash, not a real dispatch failure — and because the throw is inside the per-row loop it
may abort the rest of the batch. **Escalations are how the platform texts Izzy when
something breaks.** From commit `242d1a40`; my commit touched 0 lines of that file. Seen
live on production 2026-09-10.
