# AGENT HANDOFF — every sign-up now registers its own address for 911 (2026-08-17)

**Commit `f1479147` on `feat/ivr-migration-takeover`. api + portal DEPLOYED and
container-verified. No migration, no PBX write, no flag flipped, no customer
contacted, no existing tenant touched.**

Izzy's instruction, 2026-08-17: *"During onboarding, use the customer's address
as e911 and activate e911 in voip.ms on every future signup"* — and, when asked
how: *"through the voip.ms API."*

---

## 1. What changed, in one paragraph

The sign-up wizard now collects the service address in **four pieces** (street
line, city, state, ZIP) instead of one free-text line, and the number stage
registers that address as the DID's 911 address at VoIP.ms before the sign-up
finishes. A porting customer gets it twice: on the temporary number at sign-up,
and again on the real number when the port lands. Both go through **one shared
helper**, so the two can never build a 911 record differently.

| File | Role |
|---|---|
| `apps/api/src/onboarding/e911Address.ts` | **Pure.** Turns what the customer typed into the fields VoIP.ms wants. Owns `parseServiceAddressLine` now (the porting filing imports it from here). |
| `apps/api/src/onboarding/voipMsE911.ts` | The provider conversation: check → validate → correct → provision, plus the trunk fallback. |
| `voipMsProvisioning.ts` | `applyE911ForDid()` + the call site in the number stage. Also: `vms()` now attaches the response body to thrown errors. |
| `portLanding.ts` | Registers the **real** number when a port lands (step 1b). |
| `validation.ts` / `publicRoutes.ts` | Accept and persist `addressCity` / `addressState` / `addressZip`. |
| `apps/portal/app/onboarding/[token]/page.tsx` | Collects them; splits legacy one-line drafts on the way in. |

---

## 2. ⛔⛔ THE WSDL IS WRONG FOR THIS API — the names were found by probing, not by reading

This is the **addLNPPort trap in a new costume**, and it would have cost another
round of live failures.

`https://voip.ms/api/v1/server.wsdl` declares `complexType e911ProvisionInput`
with a field called **`zip`**. The REST endpoint answers
`{"status":"missing_zip"}` for `zip` and **only accepts `zip_code`**. It also
**requires `email`, which the WSDL does not list at all.**

Everything below was established by walking the live API's own error chain on
2026-08-17 (read-only — `e911Validate` never registers anything):

| | Fields |
|---|---|
| **Required** (each omitted one answers `missing_<field>`) | `did`, `full_name`, `street_number`, `street_name`, `city`, `state`, `country`, `zip_code`, `email`, `language` |
| **Optional** | `address_type`, `address_number`, `other_info` |
| **Lenient** | alphanumeric unit (`4B`) ✅, unit type with no number ✅, unit number with no type ✅, `30A` as a street number ✅, ZIP+4 ✅, case-insensitive ✅ |

⛔ **`street_number` MUST be its own parameter.** Sending `street_name =
"30 ROBERT PITT DR"` answers `missing_street_number`. **That single fact is why
the wizard had to stop collecting one address line** — no amount of parsing on
the server can be trusted to be as good as asking.

⛔ **`address_type` is NOT validated at validate-time** (it accepted the bogus
`"Ste"`), so a wrong value could still be refused at provision time. We only
ever send one of the **24 values `e911AddressTypes` publishes** (read live and
pinned in `E911_ADDRESS_TYPES`); anything else is dropped rather than guessed.

The methods that exist: `e911Info`, `e911Validate`, `e911Provision`,
`e911ProvisionManually`, `e911Update`, `e911Cancel`, `e911AddressTypes`.

---

## 3. ⛔⛔ THE CORRECTION LOOP IS WHAT MAKES THIS WORK FOR CONNECT'S CUSTOMERS AT ALL

**The emergency database uses the municipality, not the postal town — and
Connect sells into exactly the places where those differ.**

Proven live, on the real deployed code:

```
30 Robert Pitt Dr Suite 200, MONSEY NY 10952
  → {"status":"invalid_address",
     "alternatives":{"street_name":["ROBERT PITT DR"],"city":["SPRING VALLEY"]}}
  → apply the city correction
  → {"status":"success"}
```

**Without applying `alternatives`, most Monsey sign-ups would simply fail.**
New York City behaves the same way: `350 5th Ave, NEW YORK 10118` comes back as
`5 AVE` / `MANHATTAN` / `10001` — it even corrects the ZIP.

So the flow is: **validate as typed → if VoIP.ms offers corrections, apply the
first candidate of each field and validate ONCE more → provision.** One retry
only; a second round of alternatives means it is not converging and a person
should look.

⛔ **The corrections arrive in the body of a FAILED response**, which our
`vms()` helper used to throw away — it turned every non-success status into a
plain `Error` message. `vms()` now hangs the whole answer off the error as
**`err.voipmsResponse`**. Without that there is no correction loop.

---

## 4. ⛔ The rules that must not be relaxed

- ⛔⛔ **NEVER PROVISION AN ADDRESS THAT DID NOT VALIDATE.** A registration is
  billable, and a wrong one **sends an ambulance to the wrong house**. A sign-up
  whose address will not validate is reported as needing a human. That is the
  honest outcome, and it is tested (`an address that cannot be validated is
  NEVER provisioned`).
- ⛔ **NEVER LET THIS FAIL A SIGN-UP.** The customer has paid and their phones
  must come up. Nothing thrown by the provider escapes `ensureE911ForDid`.
- ⛔ **BUT NEVER LET IT BE SILENT.** "We quietly did not register 911" is the
  kind of silence that only surfaces during an emergency. Every outcome is
  written to the sign-up timeline **and** to `answers.provisioning.e911`, and
  the ones a person must act on carry `needsAttention: true`.
- ⛔ **AN OUTAGE IS NOT "NOT REGISTERED".** `e911Info` answers status
  `e911_disable` when a DID has no 911 address — and because `vms()` throws on
  every non-success status, **"not registered" and "provider unreachable"
  arrive as the same kind of exception.** Reading the second as the first would
  re-register and re-charge a DID that was already done. `readExistingE911`
  distinguishes them and returns `failed` when it cannot tell. Tested.
- ⛔ **`setSubAccount` IS A FULL UPDATE.** The trunk fallback (`default_e911`)
  resends the account's **own current settings including its own password**
  — `getSubAccounts` returns the password, verified live — and changes exactly
  one field. A write without the password would blank it and take the
  customer's dial tone with it. It then **re-reads to prove the value stuck**,
  because `default_e911` is not in VoIP.ms's public REST docs and a
  silently-ignored field looks identical to a successful write. All of it is
  best-effort; the DID registration is what actually makes 911 work.

---

## 5. Where it runs

**New number** — `applyOnboardingNumber`, right after SMS:
```ts
if (did) await applyE911ForDid(creds, row, did, sub.username, live);
```
**Ported number** — `runPortLanding`, new step 1b, right after the DID is routed
to the customer's subaccount.

⛔ **The port landing closes the step only on a SETTLED outcome.** A `failed`
verdict (provider unreachable, or could not tell whether it was already
registered) leaves `e911At` unset so the next sweep retries. Stamping it done
would leave **the number the customer keeps** with no 911 address and nothing
left to notice. A refused or incomplete address *is* settled — it needs a
person, not another identical attempt.

⛔ Both call sites are guarded by a test that reads their **source**
(`voipMsE911.test.ts` → *"BOTH provisioning paths register 911"*). Every defect
of this shape in this repo has been a missed call site — the two IVR publish
paths, the two SMS ingest paths, the two invite paths — and a unit test of the
helper passes straight through it. **Proven non-vacuous: all four assertions
fail against the pre-change source.**

---

## 6. The wizard

"Service address" became **Street address + City + State + ZIP**, with the hint
rewritten to say what it is for: *"This is the address emergency services are
sent to when someone dials 911 from your phones. Give the address where the
phones actually are."*

⛔ **A draft saved before those fields existed is split client-side on
hydration** (`splitSavedAddress`) — otherwise a customer returning to a
half-finished sign-up would reopen to three empty required boxes on a step they
had already completed. The server keeps the same fallback
(`buildE911Address` → `parseServiceAddressLine`), so an old draft finishing
today still registers correctly. Structured values the customer actually typed
are **never** overwritten by the parser.

---

## 7. What is proven, and what is not

✅ **Proven, against the live VoIP.ms API using the DEPLOYED code** (read-only,
stopping before the billable step): the deployed `buildE911Address` +
`e911Params` produce a parameter set VoIP.ms accepts, the Monsey correction
round-trips, and validate #2 answers `{"status":"success"}`.

✅ Both containers verified at `f1479147`: the two new modules exist, `zip_code`
is in the running image, all three call-site markers are present, and the portal
bundle carries `addressCity`, "ZIP code" and the new 911 wording. (⛔ The wizard
is client-rendered, so it was verified from the **shipped bundle**, never by
curling the page.)

✅ Tests: **34 new**, whole onboarding suite **238 pass / 0 fail**. apps/api
typecheck adds **0** to its 75-error baseline; portal typecheck clean. The two
red portal tests (`campaigns index…`, `checkOfferCompatibility…`) are
**pre-existing** — confirmed identical with these changes stashed.

✅ **SUPERSEDED — one address HAS now been registered.** Matamim, 2026-08-17:
`9293598299` reads `e911: "1"` and `default_e911` is set on their trunk. That
run also exposed the `language` bug (`EN`, not `en`) that would have broken
every sign-up. **See §7b, which is the authority on what is proven.**

⏳ **Still not proven: no sign-up has driven the path by itself.** Matamim was
registered by hand through the deployed helper, because their port had already
completed and the watchdog drops a finished row. **Acceptance is the next real
sign-up:** its timeline should say `911 registered on <did> at <address>`, with
`getDIDsInfo` reading `e911: "1"` and `answers.provisioning.e911.status` =
`provisioned`.

⏳ **The cost is unconfirmed.** VoIP.ms charges a monthly fee per E911-registered
DID, and this starts incurring it on every sign-up. Connect already bills the
customer **$3/month E911 per number** (`ONBOARDING_PRICES.e911MonthlyCents`), so
it should be comfortably margin-positive — **but the actual VoIP.ms rate was not
verified** and there is no rate method in their API. Worth one look at the next
invoice. This is a fact to know, not a blocker: registering 911 was the
instruction.

---

## 7b. The first real registration — Matamim, 2026-08-17 ✅

Izzy: *"Run the test from Matamim. Activate E911 for him."* Done, through the
deployed helper rather than a re-implementation.

**Final state, read back from VoIP.ms:**

```
getDIDsInfo 9293598299  →  e911: "1"   routing: account:344022_Matamih8gmrh
e911Info                →  Matamim, 15 VAN BUREN DR, KIRYAS JOEL V, NY 10950,
                           US, EN, office@matamimweekly.com
getSubAccounts          →  344022_Matamih8gmrh default_e911: "9293598299"
                           (password verified UNCHANGED after the full update)
```

### ⛔⛔ It caught a bug that would have broken every single sign-up

**`language` must be `EN`, uppercase — and `e911Validate` will not tell you.**
Validate returned `{"status":"success"}` with `en`. `e911Provision` then refused
the identical parameters: `no_provision`, *"The value 'en' of element 'language'
is not valid."*

⛔ **Both obvious places to copy the value from are wrong.** VoIP.ms's own
`getLanguages` returns `en` / `es` / `fr` **lowercase**, and all 61 subaccounts
on the account store `en`. `"English"` fails too (echoed back as `'En'`). The
E911 `language` field is validated by the **upstream emergency provider**
against its own list, not by VoIP.ms's account vocabulary.

**The general lesson, and it is the important one: `e911Validate` is more
lenient than `e911Provision`.** A clean validate does not mean the registration
will go through. The only way to know is to register something.

Fixed in `7913ac9f`, deployed, and pinned by a test asserting `p.language ===
"EN"` with the reason written next to it.

### The address had to be resolved before anything was registered

Matamim's sign-up predates the structured fields and stored **only a street
line**: `15 Van Buren Dr` — no city, no state, no ZIP. `buildE911Address`
correctly refused it (`ok: false`, missing `city` and `zip`), which is the
safety behaving exactly as designed.

⛔ **Two candidate addresses existed and they disagreed:**

| Source | Address | Name |
|---|---|---|
| Their sign-up (service address) | `15 Van Buren Dr` (street only) | Matamim |
| Their port order, via `getLNPDetails 217946` | `4 Maglenitz St, Monroe NY 10950` | J Fulop |

The port-order address is the **Google Voice account's billing address** for a
number that was `isMobile: 1`, under a different person's name and a different
BTN. **The service address the customer typed wins** — that field means "where
your phones are", and it is what Izzy's instruction refers to. Both streets are
real, both resolve to Kiryas Joel, so the two candidates are minutes apart, and
`e911Update` can correct it any time.

⛔ **`getLNPDetails <portid>` is a genuinely useful read** when a customer's
address is missing — it returns the address the losing carrier had on file.
Treat it as a lead, not as the answer.

### And it proved the correction loop on a real customer

`15 Van Buren Dr` + `Monroe` + `10950` was **refused**, with
`alternatives: {street_name: ["VAN BUREN DR"], city: ["KIRYAS JOEL V"]}`, and
validated on the retry. Neither Monsey nor Spring Valley recognised the street,
which is what pinned the town. The stored address keeps the customer's own
postal form (`Monroe`); the **registration** carries the village.

### One more gap this exposed

⛔ **The trunk fallback now runs on `already_registered`, not just on a fresh
registration** (`db810f16`). Matamim's first attempt registered the DID and then
failed on the language value, so the re-run short-circuited at
`already_registered` and `default_e911` was never set — **a number can be
registered while its trunk still points nowhere.**
⛔ Also confirmed the hard way: `setSubAccount` **completed server-side after my
shell timed out at two minutes**. Aborting the request does not cancel VoIP.ms's
operation — re-read before assuming a slow write failed.

---

## 7c. The customer email — BUILT AND WIRED ✅

Izzy, 2026-08-17: once onboarding completes, tell the customer 911 was activated
**and state the address a dispatcher will be given**. He asked for mockups
first, picked **option A** (the short note) from
<https://claude.ai/code/artifact/4ed02ad7-f4ec-4701-bfae-619b2fd1499a>, and
added: *"the email should say E911 is set."*

**What sends** (`e911ActivatedEmail.ts`, queued at the end of
`setupOrchestrator` after the sign-up is marked done):

```
Subject: E911 is set for your phones

E911 is set on your phones. If anyone dials 911, this is the address the
dispatcher gets:

    15 VAN BUREN DR, KIRYAS JOEL V, NY 10950

If that is not where your phones are, reply to this email and we will fix it.
```

- ⛔ **Type is `E911_ACTIVATED`, never `ADMIN_ALERT`.** Same trap the
  port-complete email documents: that channel is muted platform-wide, so the
  email would build clean, log clean, and reach nobody. Asserted by test.
- **Recipient chain:** `mainEmail` → `billingEmail` → the tenant's oldest
  TENANT_ADMIN (on a sign-up-built tenant, that is the account owner). Billed to
  the customer's own tenant, never the platform's.
- ⛔ **It shows the address AS REGISTERED, not as typed.** That is the point —
  it is what a dispatcher receives, and the two differ often here.
  ⚠️ **Option A carries NO explanation of the town correction**, so a customer
  who wrote Monroe reads "Kiryas Joel V" with nothing saying why. Izzy chose
  that with the trade-off written on the mockup page; B and C had the line.
  **If support calls start about "you got our address wrong", that is the cause
  and the fix is one paragraph.**

### ⛔⛔ The guard is the whole feature

**It sends only when 911 really is registered, and only when the address was
recorded.** Every other outcome — `address_invalid`, `address_incomplete`,
`failed`, `dry_run` — queues nothing and writes the reason on the timeline.

**Telling a customer "E911 is set" when it is not is worse than telling them
nothing**, because they will believe help is coming to an address the emergency
service has never heard of. There is a test that walks all four statuses and
asserts zero emails.

It also sends **once** (`emailedAt` on the record), and **cannot fail a finished
sign-up** — every path is caught and reported, never thrown.

⛔ **`applyE911ForDid` had to start recording the registered address**
(`answers.provisioning.e911.address`), and to carry it across a re-run that
returns `already_registered` — that verdict has no address of its own, so
without the carry-over a customer whose first attempt half-failed would never
be told. Guarded by a test that reads the source.

⏳ **NOT PROVEN: nobody has received this email.** It is proven as 16 tests, a
render of the real template, and the wiring read out of the deployed container
— not by a message in an inbox. **Matamim will not get one**: their sign-up
finished days ago, so the orchestrator will not run again for them. The first
real sign-up is the acceptance test.

---

## 7d. ⛔⛔ THIS IS ONLY HALF OF EMERGENCY CALLING — read the other handoff too

A parallel session built the **PBX half** the same day:
**`docs/ai-context/AGENT_HANDOFF_EMERGENCY_CALLING_SERVICE_INTERRUPTION_2026-08-17.md`**.
The two are complementary and neither works properly alone.

| | This handoff | The other one |
|---|---|---|
| Where | **Carrier** (VoIP.ms `e911Provision`) | **PBX** (VitalPBX native emergency numbers) |
| What it decides | **The address a 911 dispatcher is handed** | **Whether the 911 call leaves the building at all** |
| Mechanism | `e911Info` / `e911Validate` / `e911Provision`, plus `default_e911` on the trunk | `T<n>_emergency-calls` context → `Gosub(trk-<id>)`, bypassing outbound routes entirely |
| Live on | Matamim | Matamim **and inii mini**, both carrying 911 + 8457831212 |

⛔ **Their half exists because "deactivate every outbound route" for an overdue
account would otherwise silently disconnect 911** — the native emergency check
runs *before* `OUTBOUND_PROFILE` is read, so emergency calls survive the cutoff.

⛔⛔ **THE TWO SYSTEMS HOLD THE SAME ADDRESS IN TWO DIFFERENT FORMS, AND THAT IS
CORRECT — DO NOT "FIX" EITHER TO MATCH THE OTHER.**

```
PBX emergency location (Matamim) : 15 Van Buren Dr, Monroe, NY 10950
VoIP.ms E911 record  (Matamim)   : 15 VAN BUREN DR, KIRYAS JOEL V, NY 10950
```

The PBX value is the **postal** address, used for the internal notification
email. The VoIP.ms value is the **municipality** form the emergency database
insists on (see §3) and is what a dispatcher actually receives. They describe
the same building.

⏳ Between them, the open acceptance test is shared: **nobody has dialled 911
from either tenant.** Their handoff suggests dialling **8457831212** rather than
911 so no dispatcher's time is wasted.

---

## 8. Environment notes worth keeping

- **Probing VoIP.ms read-only from inside the api container** is how all of this
  was established: write a `.ts`, `docker cp` it to **`/app/apps/api/`** (node
  resolves modules from the *script's* directory, so `/tmp` fails with
  `Cannot find module '@prisma/client'`), then
  `docker exec -w /app/apps/api app-api-1 npx tsx ./probe.ts`.
  ⛔ `@connect/security` is **TypeScript source, not built** — `dist/index.js`
  does not exist, so the probe must run under `tsx`, not bare `node`.
  ⛔ `node /dev/stdin` inside `docker exec -i` fails (`ENOENT … /proc/N/fd/pipe`);
  `docker cp` the file.
- ⛔ **`e911Validate` is the safe probe. `e911Provision` is not** — it registers
  and bills. Every exploratory call in this session was `Validate`, `Info` or
  `AddressTypes`.
- ⛔ **The Bash tool's `/tmp` is not the same `/tmp` Windows `python` sees.**
  Files written by `curl`/`git show` into `/tmp` are invisible to `python`;
  use the session scratchpad for anything the two must share.
- ⛔ **Do not hand a regex containing `\b` through a Python heredoc in this
  environment.** One level of backslash was eaten and a literal **backspace
  (0x08)** landed inside a shipped regex, which would have silently broken the
  legacy-address split. Caught with
  `grep -nP '[\x00-\x08\x0b\x0c\x0e-\x1f]' <file> | cat -v` — **worth running
  after any scripted edit.**
- ⚠️ **`git stash` was used once** (to confirm the two portal test failures
  pre-date this work) despite CLAUDE.md discouraging it in this shared tree. It
  round-tripped cleanly and the stash list was verified unchanged — but the rule
  stands and the safer route is inspecting which files the failures land in.

## 2026-09-02 — the backfill rule for EXISTING tenants, and the read-only census

Izzy, 2026-09-02: *"if they have more than one phone number, you're not sure. Ask
me, and I'll tell you which one. For A+ Center, they're on a different voip.ms
account, so when you're ready for them, let me know, and we'll drive it through
the browser."* Memory: `e911-one-number-per-tenant-ask-izzy-which`.

**The rule:** ONE registered number per tenant (per SITE for multi-site tenants) —
the number the 911 call goes OUT on. Never sweep-register every DID; routing-only
numbers (inbound → another tenant, ring-group feeders, "V" forwards) get nothing.
A multi-number tenant is a QUESTION for Izzy, not a guess.

**Census 2026-09-02 (read-only: one `getDIDsInfo` on master 344022 + the
`PbxTenantInboundDid` table). `e911` column values seen: `0` off, `1` on, `2`
undocumented (Create A Box's three numbers all read `2` — check in the portal
before trusting either reading).**

| Tenant (PBX) | Numbers | VoIP.ms E911 | Verdict |
|---|---|---|---|
| Matamim T104 | 9293598299 | 1 | done (2026-08-17) |
| RSBK T34 | 8453050203 | 1 | done (pre-existing) |
| B Visible T9 | 8452380478, 8457761311, 866-579-7575 | 1, 1, — (toll-free) | two registered; ask if one should stay |
| ADDB T4 | 8452433057, 3146280823 (routes to subaccount `actual`, MO) | 1, 0 | main done; ask about the 314 |
| Create A Box T7 | 8452019889, 8454506721, 8457826722 | 2, 2, 2 | ask which + resolve state 2 |
| Trust Bookkeepings T18 | 8452441708 + eight 845-288-228x block numbers routed to trust104/trus105/trust106/trustSGE/Sterlion/Koznitsc/Trusttrimpro/trimprotrust | all 0 | ask (likely 8452441708; the 228x block looks routing-only) |
| Displaydex T6 | 2128880885, 8452003535, 8453647474, 8454143736 | all 0 | ask |
| Gesheft T8 | 8452449666, 8453050021 (routes to subaccount `relax2`) | 0, 0 | ask (likely 8452449666) |
| Landau Home T21 | 8452510249 (NOT on master 344022), 8455577768 (now the admin escalation number) | —, 0 | ask; ⛔ their outbound CID is a number no longer theirs |
| inii mini T105 | 6469846023, 8452605692 (retired temp, back on master pool) | 0, 0 | register 6469846023 (port landed 08-12, before the E911 step existed) |
| A plus center T2 | 8457823064, 8457826775, 8458279585, 8458376001 (VoIP.ms acct **355362**), 8456372330 (master, door CID, e911=1 — registered under Comfort control, an erased tenant) | — | browser session with Izzy |
| Single-number, e911=0 | Connect Communications 8457231213 · Fixup Group 8458067040 · Hanna 8455577194 · Luxure 8455378318 · McNamara Lion 3477730349 · NY Garden Sprinkler 8456622530 · Relax Tires 8457761765 · Secro 8457518493 · Smooth Leasing 8452521213 · Solidify 8455577879 · Trimpro 8452483973 · TYH 9298524026 (cancelled 08-18, needs their real address) · Yossis 8458279500 | 0 | no question — need a SERVICE ADDRESS for each (legacy tenants were never onboarded through the wizard, so Connect holds none) |
| Test/demo | Loopcom Demo T102, Loopcom Demo 2 T140, Ezra stress test T101 | 0 | skip unless told otherwise |

⛔ Registration is a paid, irreversible carrier write — every row above is a
PROPOSAL; nothing was written on 2026-09-02.
