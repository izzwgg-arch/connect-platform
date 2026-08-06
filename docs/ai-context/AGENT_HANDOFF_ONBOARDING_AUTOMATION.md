# AGENT HANDOFF — Onboarding automation engagement (2026-07-26 → 2026-07-28)

> Handoff from the Cursor chat that built, stress-tested, and hardened the fully
> automated customer onboarding flow: public wizard → VoIP.ms number + subaccount
> → VitalPBX tenant build (panel replay) → Connect user/SIP sync → invitation
> emails. Read this before touching anything under `apps/api/src/onboarding/`,
> the portal wizard (`apps/portal/app/onboarding/`), or before wiping test
> tenants. Everything below was verified live in production during this chat.

Deploy branch at handoff: **`feat/ai-agent`** (NOT `main` — pushes to `main` get
rejected; the server deploys this branch). Last onboarding commits:
`db4453f8` (used_username self-heal), `b3081f67` (spare-DID cache fix),
`8784b624` (cell-device verification via getDevice).

---

## 1. What the automation does (end-to-end flow)

1. **Wizard** (`apps/portal/app/onboarding/[token]/page.tsx`): company info →
   extensions (each can route "also"/"only" to a cell number — never say
   "virtual" to users) → number choice (new / port / in-stock spare) →
   add-ons (SMS) → review → submit. Billing email is optional (defaults to
   main email). Autosave on every step.
2. **Leaving the number step** fires `POST /onboarding/:token/apply-number`
   → background `applyOnboardingNumber()`: creates the VoIP.ms subaccount,
   orders or routes the DID (temporary DID for ports), enables SMS.
   `numberStatus`: `provisioning → ready | ready_dryrun | failed`.
3. **Submit** fires the orchestrator (`setupOrchestrator.ts`
   `runOnboardingSetup`): waits for the number stage (poll, 5 min cap) →
   `buildPbxTenant()` (panel replay: trunk → outbound route → route selection
   → tenant → CSV extension import + devices → inbound route) → syncs
   extensions into Connect (`verifyAndRepairTenantExtensions`, hard bar:
   users + WebRTC + SIP password present) → sends invitation emails →
   marks submission ACTIVE. `pbxSetupStatus`: `building → syncing → inviting
   → done | dry_run_done | failed`.
4. **Race/resume machinery** (all live-proven): `waitForNumberStage` polling;
   `resumeSetupIfSubmitted` re-kick after apply-number completes; in-process
   `setupsInFlight` re-entrancy lock; stale-in-flight detection via
   `updatedAt` (10 min number stage / 15 min setup). Every step is idempotent
   — re-running reuses existing subaccounts, panel objects, tenants.

Feature gates (default ON in `docker-compose.app.yml`, robot creds from
`/etc/connect-robot/credentials.env` mounted via `env_file`):
`VOIPMS_AUTO_PROVISION=on`, `ONBOARDING_PBX_AUTO_SETUP=on`. Anything else =
dry-run (statuses `ready_dryrun` / `dry_run_done`, which do NOT block a later
live re-run).

Key modules (all in `apps/api/src/onboarding/`): `publicRoutes.ts`,
`voipMsProvisioning.ts`, `panelClient.ts`, `pbxTenantBuild.ts`,
`setupOrchestrator.ts`, `validation.ts` + their `.test.ts` files (FakePanel
simulates the VitalPBX panel; `pnpm --filter @connect/api test`).

## 2. Reusable stress-test link

Template row with `answers.reusableTestLink = true`, token
**`stress-WBcv2eWu8GzxdIIP2glmd6O2`**. Visiting
`/onboarding/test/<token>` (portal) calls `POST /onboarding/test/:token/spawn`
and redirects into a brand-new submission. The template row itself is
spawn-only — `isSubmissionWriteBlocked` returns true for it; never let it
become writable.

**Invitation emails**: platform enforces ONE account per email globally. A
stress run only produces invites if every extension has a UNIQUE email never
used in any tenant (plus-addressing works). "Sent 0 invitation email(s)" with
no emails typed in is correct behavior, not a bug.

## 3. VoIP.ms — verified facts and traps

- Master creds: `globalVoipMsConfig` row id `default` (encrypted). All calls
  via `vms()` in `voipMsProvisioning.ts` — GET REST, throws on
  `status !== "success"`.
- **Subaccount**: named `<accountNumber>_<CompanyName?>1` (account number
  `344022`, NOT the API login email — always suffix-match `_<subName>` when
  looking up). Settings per Izzy: `protocol 1`, `auth_type 1`,
  **`device_type 1` = "Asterisk, IP PBX, Gateway or VoIP Switch"** (`2` is
  ATA/IP-phone — a live bug once), no CallerID (own device), server
  `newyork1.voip.ms`.
- **`setSubAccount` is a FULL update** — sending only `{id, password}` fails.
  `reuseSubaccount()` resends the account's own settings with the new
  password. Never "rotate" with a partial payload.
- **`used_username` self-heal** (commit `db4453f8`): if `createSubAccount`
  returns `used_username`, re-look-up and reuse. Live failure 2026-07-27
  ("Ezra Store 1"): an interrupted run had created the subaccount during a
  VoIP.ms outage; retries then died 3× on used_username.
- **Spare DIDs** (`listSpareDids`): DIDs routed `account:344022` (no `_`) are
  in-stock; the wizard number search lists them FIRST with `inStock: true`
  ("Ready now" badge) — use up stock before buying. The search endpoint
  caches ONLY the slow purchasable search (10 min); the spare list is fetched
  fresh every request (commit `b3081f67` — caching spares made freed numbers
  invisible and claimed numbers still visible).
- **SMS enable** on a freshly ordered DID can return `sms_wait_message` —
  retry with backoff (already implemented).
- **Outages**: VoIP.ms periodically returns Cloudflare 521/522 HTML pages
  instead of JSON (observed ~10 min on 2026-07-27). Any script hitting the
  API must detect leading `<` and retry with generous backoff; wipe scripts
  pace calls with sleeps.
- ⛔ **`addLNPPort` returns the order number as `port`** — a bare integer:
  `{"status":"success","port":217760}`. Not `portid`, not `port_id`. We shipped
  both of those guessed names and read `""` off the first real filing (fixed
  2026-08-05, commit `e98dad78`). **The lesson is the same one the parameter
  names taught: VoIP.ms field names are only ever proven by a live call.** A
  response field cannot be inferred from the request's field names, from the
  WSDL's input types, or from what a sister method returns — and a wrong guess
  is silent, because `vms()` only checks `status`. See §9.

## 4. VitalPBX panel — verified facts and traps

Panel automation = browser replay over HTTP (`panelClient.ts`, port of
`tools/connect-robot/connect-lib.js`). REST API v2 is used read-only via
`VitalPbxClient` (+ `tenants.delete`, the ONLY v2 delete that exists — trunks
/ outbound_routes / route_selections have `read.php` only, verified on the
PBX filesystem).

- **Panel responses lie**: errors come inside `state:"success"` envelopes as
  dialogs. Always run `dialogErrors()` / check `module-error-list` before
  trusting a response.
- **Scoped option lookups**: forms contain several company-named `<select>`s;
  always use `findOptionInSelect` with the right select (`trklist[]` for
  trunks in the trunk_group form, `members[N][outbound_route_id]` in the ars
  form, `outbound_profiles[]` in the tenants form). Unscoped scans caused a
  live mis-wiring (tenant got the trunk id as its outbound profile).
- **Build order**: trunk → outbound route → route selection (ARS) → tenant
  (last, referencing the ARS) → extensions → inbound route. Same as the
  recorded connect-robot flow.
- **Idempotent pre-checks are case-insensitive by description** — that's how
  interrupted builds resume, and also how a new build will silently ADOPT a
  leftover same-named object from an unwiped earlier test. Wipe fully between
  rounds.
- **Cell ("virtual") devices**: the extension edit form NEVER shows the cell
  number in HTML — verify via `getDevice` per device id (`hasCellDevice`).
  Ring rules: `cellMode "only"` → PJSIP/WebRTC `ring_device: no`, cell device
  rings; `"also"` → everything rings.
- **Tenant path discovery**: HTML scrape of the tenants page fails in
  production — resolve the path via REST `listTenants` (TenantPathResolver),
  scrape only as fallback.
- **Extension destination lookup** returns a JSON `options` array in
  production (not HTML) — parse JSON first.
- **DELETING panel objects — the two-step protocol** (discovered 2026-07-27,
  reference implementation `scripts/onboarding/_wipe-round2.mts`):
  1. `POST {class, method:"delete", mode:"delete", data:<id>}`.
  2. The response is EITHER a refusal dialog (`module-error-list` `<li>`s,
     e.g. "record is being used by OUTBOUND ROUTES module") OR a
     `confirmation-modal` containing hidden inputs
     (`<cls>_id`, `class`, `method:"delete"`, `mode:"deleteConfirmed"`).
  3. Re-POST exactly those hidden inputs to actually delete.
  4. VERIFY by re-listing the select — a delete without the confirm step is a
     silent no-op that still "succeeds" (this bit us: two earlier wipes left
     every trunk/route/ARS behind).
  Delete in dependency order: ars → trunk_group → trunks, tenants first
  (REST). Panel deletes happen in the MAIN tenant
  (`setTenant(cfg.mainTenant)`); finish with `applyChanges`.
- **REST `deleteTenant` can exceed 20 s** (tears down extensions) — use a
  120 s timeout and, on timeout, poll `listTenants` for absence instead of
  assuming failure.
- The panel PHP is ionCube-encoded; the frontend JS
  (`/usr/share/vitalpbx/www/resources/js/01-pbx.min.js` on the PBX box,
  read-only) is the source of truth for request shapes
  (`sendModuleRequest` posts `{class, method, mode, data}`).

## 5. Wiping test rounds (recurring task)

Reference: **`scripts/onboarding/_wipe-round2.mts`** (committed). Pattern:
- Hardcode the round's targets (submission ids, tenant ids/paths, panel trio
  ids by NAME, subaccounts, DIDs) — derive panel ids from each submission's
  own event log (`trunk ok (id N)` etc.).
- VERIFY-ONLY mode by default; identity-check EVERYTHING (tenant path+name,
  panel description match — panel HTML-escapes entities (`&#039;`), decode
  before comparing —, DID routing points at the run's subaccount, Connect
  tenant name); any mismatch aborts all. `DO_DELETE=1` to execute.
- Order: PBX tenants (REST) → panel trios (two-step + verify) → applyChanges
  → VoIP.ms (re-route DID to `account:344022` — pre-owned test numbers are
  STOCK, never cancel them — then `delSubAccount`) → Connect tenants
  (cascade users/extensions) → onboarding submissions.
- Run scripts on the server: `scp` to `/tmp` → `docker cp` into `app-api-1`
  → `docker exec app-api-1 sh -c 'cd /app/apps/api && ./node_modules/.bin/tsx <file>'`.
  Quick DB one-liners: pipe JS into
  `docker exec -i -w /app/packages/db app-api-1 node -`.
  (PowerShell quoting of inline JSON/JS in ssh commands breaks constantly —
  prefer piping a `$js` string via stdin, or scp a script file.)

Stress history: round 1 (9 tenants, 2026-07-27 afternoon) all passed; round 2
(10 tenants, evening) 9 passed + "Ezra Store 1" failed (root causes fixed,
see §3). Both rounds fully wiped, all 4 systems verified clean.

## 6. Environment facts for THIS Cursor setup

- `ssh`/`scp` run DIRECTLY from PowerShell here with keys in
  `C:\Users\izzyw\.ssh\` (`connect2_ed25519` → loopcom 45.14.194.179,
  `connect2_server2_ed25519` → pbx 209.145.60.79). The CLAUDE.md sandbox
  method applies to Claude-Cowork sessions, not this Cursor environment.
- PBX box is READ-ONLY except owner-mandated operations. In this engagement
  Izzy explicitly mandated: onboarding panel builds (the automation itself)
  and the test-tenant wipes. Filesystem inspection of the VitalPBX GUI source
  for reverse-engineering is read-only and fine.
- Deploys: `bash scripts/deploy-direct.sh api --branch feat/ai-agent` (and
  `portal`) from `/opt/connectcomms/app` on loopcom; always verify the
  container commit + grep a unique new line afterwards. Watch for stale
  `run-heavy.sh` locks ("HEAVY JOB ALREADY RUNNING") and for the deploy
  syncing an older commit if pushed seconds earlier — re-run if the SHA
  doesn't match.
- Ezra's test IP `173.212.214.198` is permanently allowlisted in
  `/etc/nginx/connectcomms/allowlist.conf` (was auto-banned by the abuse
  detector mid-test; `unblock_ip.sh` is the official unban path).
- Another agent works on `apps/mobile` in the same working tree — never
  `git add -A`; stage only your own files.

## 7. Open items / next steps

- ~~**Port-in flow is implemented but never live-tested**~~ — **DONE
  2026-08-05: the first real filing SUCCEEDED**, port order **217760** (inii
  mini, 6469846023 from Verizon). See §9 below for what that one live exercise
  taught, including a response-field bug it exposed.
- **Ezra Store 1's failure mode is fixed but unproven live** — next stress
  round should include a mid-provisioning interruption / duplicate-name rerun
  to confirm the self-heal in production.
- `_wipe-*.mts` scripts are per-round (hardcoded IDs) — each new round needs
  its targets updated; consider generalizing into an admin "wipe submission"
  endpoint if rounds continue.
- Number-search `location` field for spare DIDs came back empty in the last
  probe (cosmetic — `getDIDsInfo` ratecenter/state missing on some rows).

---

## 8. Toll-free & vanity numbers (added 2026-08-04, commit `73f990a0`)

The wizard's "Get a new number" step sells three kinds of number. The kind is
stored as **`answers.phone.numberKind`** (`local | tollfree | vanity`) at
select/apply/submit and drives pricing, purchase, and reporting. Built on the
worktree branch `claude/heuristic-easley-d05ffe` atop feat/ai-agent tip
`7f3c7970`.

- **Wizard** (`apps/portal/app/onboarding/[token]/page.tsx`): Local /
  Toll-free tabs; the Local tab has an explicit Starts with / Contains /
  Ends with selector (threaded as `mode` — the integration used to guess from
  digit length); the Toll-free tab has a digit search plus a "Spell a word"
  vanity input (keypad letters → digits, conversion shown to the customer).
  Toll-free/vanity results carry a "$15/mo" chip. Each tab shows only its own
  spare stock — a toll-free spare under Local would price wrong.
- **Search API** (`GET /onboarding/:token/numbers`): new query params `mode`,
  `type=local|tollfree`, `vanity=<word>` (implies toll-free). Every result now
  carries `kind`. Cache key includes tab/mode/pattern.
- **Integration** (`packages/integrations/src/index.ts`):
  `NumberSearchInput.mode`; new `VoipMsNumberProvider.searchVanity()` —
  VoIP.ms `searchVanity` with `type: "8**"` and a 7-char `*`-padded pattern
  (`"PIZZA"` → `74992` → `**74992`).
- **Pricing** (`packages/shared/src/onboardingPricing.ts`):
  `tollFreeNumberMonthlyCents: 1500`; quote line key `tollfree_number`
  ("Toll-free number — $15.00/mo", invoice line type PHONE_NUMBER). The
  first-number-included rule applies to LOCAL numbers only; the toll-free
  number is never also charged the $10 extra-number price. E911 still applies.
  **1 ext + toll-free = exactly $50**, asserted literally in
  `onboardingPricing.test.ts`.
- **Month-2 recurring** (`onboardingBillingDefaults.ts`): the stamp adds the
  $15 in the `customFee` fee slot as **`flat_monthly` — deliberately NOT
  `per_toll_free_did`**: that basis counts Connect `phoneNumber` rows, which
  onboarding never writes, so it would quietly bill $0 and break the quote.
  `ensureOnboardingBillingDefaults` takes `{ tollFreeNumber }` — threaded from
  checkout AND the orchestrator adoption path via
  `quoteInputForSubmission().tollFreeNumber` (which also guards: a stale
  numberKind after switching to "port" never surcharges).
- **Purchase** (`voipMsProvisioning.ts`): branches on the stored kind —
  `orderTollFree` / `orderVanity` instead of `orderDID` (same param shape,
  NY pop). Spares route via `setDIDRouting` as before. A toll-free pick taken
  by another customer meanwhile is replaced with another TOLL-FREE number
  (spare first, then `searchTollFreeUSA` + orderTollFree), never a local one.
  `findSpareDid` (port temp numbers / local replacements) now SKIPS toll-free
  spares — handing one out would bill $15 to a local-price customer.
- **Review + owner report** (`adminSignupReport.ts`): both name the kind —
  "Toll-free number ($15 a month): (833) …".
- Tests: `onboardingPricing.test.ts` ($50 floor, no double $10),
  `quoteInput.test.ts` (kind derivation + port guard),
  `voipMsProvisioning.test.ts` (dry-run + live mocks for both order methods,
  same-kind replacement, temp-number toll-free skip),
  `onboardingBillingDefaults.test.ts` (month-2 preview = $50 through the real
  invoice engine).
- Open: vanity replacement can't re-pick the word automatically (a taken
  vanity number is replaced with a plain toll-free number, logged in the
  timeline); toll-free purchase not yet live-tested against real VoIP.ms.

---

## 9. Port-in went live (2026-08-05) — order 217760, and the field bug it found

The port-in path was written blind in July and sat unproven until a real
customer needed it. One live filing settled several things at once.

**The filing succeeded.** Submission `cmsey1ydz0000o4xoxu92gh2m` ("inii mini"),
number 6469846023, carrier Verizon → **port order 217760**, accepted
2026-08-05 ~19:55 ET. This came after `ce54e40d` rewrote `buildLnpPortParams()`
to the WSDL's real parameter names; every earlier automated port had been
rejected `invalid` because the code sent invented names (`did`, `carrier`,
`account_number`).

**⛔ The five integer codes are validated only for ONE combination.**
`portType=1, isPartial=0, locationType=1, isMobile=1, tfType=0` was accepted
for a **local + mobile full port**. Toll-free, partial, and landline
combinations are still guesses — treat the next filing of a different shape as
unproven, not as "the port code works".

**⛔ The response field was wrong, and nothing complained.** `submitPortIn()`
read `submit?.portid ?? submit?.port_id`; VoIP.ms actually answers
`{"status":"success","port":217760}`. Consequences, all silent:

- `answers.provisioning.portId` stored `""`.
- The customer timeline logged `id ?` instead of the order number.
- The `addLNPFile` loop would have attached the LOA and the phone bill to an
  **empty** `portid` — the documents VoIP.ms needs to work the port.

Nothing threw, because `vms()` validates only `status`. The filing reported
success and the order really did exist; only our record of it was blank.
Fixed 2026-08-05 in **`e98dad78`** (`?? submit?.port` added, on
`feat/ivr-migration-takeover`). `voipMsProvisioning.test.ts`'s fake VoIP.ms now
returns the **real** `{status, port}` shape, so the assertion on the stored id
fails if the extraction regresses — a fake that returns a made-up field shape
proves nothing, which is exactly how this bug survived 44 passing tests.

**inii mini's own loose ends** (this is a real customer's live port):

- **No bill was attached** — the upload was destroyed by an api deploy before
  the volume fix (`5b2214fe`, see the uploads handoff). The customer has to
  re-upload; the document cannot be recovered.
- **The PIN may bounce.** We sent `6023`, the number's last 4. Verizon Wireless
  ports need a generated **6-digit Number Transfer PIN**; if the port rejects,
  that is the first thing to ask the customer for.
- `portId` was corrected by hand to `217760` in `answers.provisioning` — the
  code fix does not backfill.

⛔ **Never probe this API by submitting `addLNPPort` calls.** A complete request
files a REAL port order against a REAL number at a REAL carrier. 217760 is not
a test record. Exercise parameter changes through the test suite's fake, and
accept that the response shape is only ever confirmed by a customer's filing.

---

## 10. The same customer's 90-minute stall — a retry that redid its own work

The port rejection above was only half of why inii mini waited 97 minutes
between paying and getting a working phone. The other half is a retry-design
bug worth understanding before writing any other resumable stage.

**VoIP.ms's write path degraded on its own.** From ~21:40 to ~22:37 UTC every
`setSubAccount` call timed out at 30 s, while `getServersInfo` answered in
**2.0 s** the whole time. Reads being healthy is NOT evidence that writes are.
Probe the specific method that is failing, not the API in general.

**Our retry then re-entered the one call that was down.** `ensureSubaccount()`
generates a fresh password every run, and the reuse path rotates it through
`setSubAccount`. The credentials were persisted only at the very END of the
number stage — so when a later step failed, a *successful* rotation was thrown
away, and the next attempt rotated again. Four watchdog attempts, four
rotations, four timeouts. The stage never got past its first call.

⛔ **A resumable stage must persist each irreversible success the moment it
happens, not at the end of the stage.** Anything saved only on the happy path
guarantees the retry repeats the most expensive (or most fragile) work.

**Fixed 2026-08-05 (`b20fad30`, tests `54cd7f59`, deployed inside merge
`ac585aa7`):**

- `applyOnboardingNumber()` calls `readSubaccount(row)` FIRST and reuses stored
  credentials when present — a retry never touches `setSubAccount` again.
  Safe because subaccount names are per-submission (§ provisioning identity):
  the row can only ever hold this submission's own account.
- A successful create/rotate is written to `voipmsSubaccountEncrypted`
  immediately, before the DID work.
- `vms()` took an optional `timeoutMs`; both subaccount writes now pass
  **120 s** instead of 30 s. The live rotation that finally worked took **48 s**
  — the old ceiling was aborting calls that VoIP.ms was still completing, and
  **aborting the HTTP request does not cancel their server-side operation.**
- Two regression tests: reuse survives with both subaccount writes returning
  errors, and a successful create is persisted even when a later step fails.

**How it actually ended:** attempt 5 of 5 (the watchdog gives up after 5) ran on
the new code, reused everything, and completed in 130 s — number stage, PBX
build, Connect sync, invitation email. One more failure and the sign-up would
have gone to a "watchdog gave up" alert instead.

**Operational note for a stalled paid sign-up:** the watchdog's 5 attempts are
~16 min apart, so a bad hour costs the customer over an hour. The retry
endpoint exists — `POST /admin/onboarding/submissions/:id/retry-setup`
(SUPER_ADMIN) — and is safe to call repeatedly; every stage is idempotent. Use
it rather than waiting out the timer.

### The wizard half of the port fix (`ce54e40d`, live)

The parameter rewrite is only useful if the wizard collects what the carrier
needs, so the sign-up's port step changed with it.

**The service address is now FOUR fields, all required.** `serviceAddress` is
the **street line only**, plus `serviceCity`, `serviceState` (2 letters,
upper-cased as typed) and `serviceZip` (5 digits). There is also a **"this is a
cell phone (wireless) number"** checkbox (`isMobile`), which makes the transfer
PIN required when ticked. ⛔ **Never collapse these back into one address box.**
`addLNPPort` takes `address1`, `city`, `state` and `zip` as separate
parameters, and the losing carrier matches each against the CSR — a single
free-text line cannot be split apart reliably, which is exactly why the old
one-line field could not be filed.

**⛔ Order 217760 does NOT prove the legacy-address fallback.** inii mini's
record was hand-corrected into the structured shape before that filing —
`answers.provisioning.portFiledManuallyBy` on the submission says so in as many
words ("corrected WSDL params, isMobile=1, structured address"), and its
`phone.details` today reads `serviceAddress: "16 Depalma Dr"`, `serviceCity:
"Highland Mills"`, `serviceState: "NY"`, `serviceZip: "10930"`, `isMobile:
true`. So what a real carrier accepted is the **structured** path with
`isMobile=1`. `parseServiceAddressLine()` — the fallback that splits a
pre-2026-08-06 one-line address (ZIP and 2-letter state off the end, last comma
part as the city) and passes the customer's **original line through in
`notes`** so a bad parse cannot silently lose information — is covered by unit
tests only and has never been near a carrier. Keep it, because drafts saved
before this change still hold one line and no ZIP, but do not report it as
proven.

**`addLNPFile` takes `{portid, file}` and nothing else.** The `filename`
parameter the old code sent is not in the WSDL; the test now asserts its
absence.

**The deploy timing is the evidence.** The api and portal carrying the rewrite
finished deploying at **19:18 ET on 2026-08-05**, and order **217760** was
accepted **~19:55 ET** — 37 minutes later, on the same submission that had been
rejected `invalid` all day. Both halves are live and were verified inside the
running api container (`LNP_CODES` present, and the port id read as
`?? submit?.port`), so a future reader does not have to take the commit list on
faith.
