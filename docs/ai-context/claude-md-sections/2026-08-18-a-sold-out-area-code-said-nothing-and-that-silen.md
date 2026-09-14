# ⛔⛔ AGENT HANDOFF — a sold-out area code said NOTHING, and that silence put one person's address on another company's 911 (2026-08-18) — READ FIRST before touching the sign-up number search, before making a wizard field required, before removing the `ep3wlb` tag from a PBX name, or for "a customer's details are wrong and nobody typed them"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_NUMBER_SEARCH_REQUIRED_DETAILS_2026-08-18.md`**
(`7ab03778` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**
inside `0b28b348`; **portal DEPLOYED**. No migration, no PBX write, no env change,
no tenant row edited, no E911 record changed.)

- ⛔⛔ **THE BUG IZZY REPORTED, AND IT COST A REAL CUSTOMER FIVE MINUTES:** the
  results grid is gated on `numbers.length > 0` and **nothing covered the empty
  case**, so a search that found nothing rendered a blank space. Submission
  `cmsyuwds40w8sqo132jep3wlb` records **thirteen searches across 415, 718, 646,
  917 and 347 — every one "0 results", every one blank** — with the only feedback
  on screen being Continue's *"Please pick a number from the list."* They gave up
  and took a **929** number they never asked for. ✅ It now says **"Area code 718
  is not available right now. Try a different area code."**
- ⛔⛔ **`unavailable_info` IS "NO STOCK", NOT AN OUTAGE — proven live, read-only,
  2026-08-18.** `searchDIDsUSA` answers it for **305, 212, 786, 555, 999 and 311**
  while **845 returns 5,000 rows in the same minute**. `runSearch` was **throwing**
  on it and `publicRoutes.ts` swallowed the throw into `[]`, so **every sold-out
  area code reached the browser looking like a provider failure** — and the browser
  had no branch for either. ⛔ **Do NOT re-check the key or add a retry on this
  symptom**; 845 working is the proof the account and the wire are fine.
- ⛔ **"FOUND NOTHING" AND "THE SEARCH BROKE" MUST STAY APART ALL THE WAY TO THE
  BROWSER.** The endpoint answers **200 either way**, so the **body** is the only
  thing that separates them: the api now returns `error: "number_search_failed"`
  when the provider really failed **and** there is nothing to show, and the wizard
  reads it. Saying "not available" during a VoIP.ms outage denies a number that is
  buyable. ⛔ The error is raised **only when the list is empty** — if spares
  filled it, the failure cost the customer nothing.
- ⛔⛔ **HOW ONE PERSON'S ADDRESS REACHED ANOTHER COMPANY'S 911, and it is NOT
  pre-filling.** That same submission carried **"a plus center", `izzywgg@gmail.com`
  and `13 koznitz rd, monroe NY 10950`** while building an extension for a **real
  customer, golda@cannvestments.com**. Two browsers were open on the **same sign-up
  link** (hers, and Izzy's when he opened it to see why the search looked broken);
  the wizard autosaves into **one shared `answers` record per token, last write
  wins**, and the fields she left blank kept his values through her submit.
  ⛔ **A SECOND VISIT LEAVES NO TRACE** — `recordLinkOpened`
  (`journeyTracking.ts:52`) writes "opened" only when there is no prior one and
  logs a return only after **10 minutes**. **Never conclude "one person used this
  link" from a single opened event.**
- ✅ **COMPANY NAME AND THE 911 ADDRESS ARE MANDATORY SERVER-SIDE NOW.**
  `publicSubmitSchema` had `address`, `addressCity`, `addressState` and
  `addressZip` **every one `.optional()`** — the wizard checked them, the server did
  not. `requiredSignupDetails.ts` ⛔ **asks the SAME question `buildE911Address`
  will ask at provisioning time**, so a sign-up cannot pass validation and then
  fail to register 911. ⛔ **Legacy one-line drafts still pass** — refusing them
  would turn an old-but-finishable draft into a dead link.
- ⛔⛔ **A STREET SUFFIX WAS BEING REGISTERED AS THE STATE — a live 911 defect found
  in passing.** `parseServiceAddressLine("30 Robert Pitt Dr")` returns **state
  `"DR"`** and cuts the suffix off the street; `buildE911Address`'s legacy fallback
  fires on any truthy parsed state, so it returned **`ok=true`, state `"DR"`,
  street `"30 Robert Pitt"`** — an address it would really have sent to VoIP.ms.
  Same for St / Ln / Rd / Ct / Pl. Now checked against the real US state list
  (`isUsStateCode`); that case correctly refuses. **Explicit `addressState` values
  are unaffected.**
- ✅ **DUPLICATE COMPANY NAMES ARE NUMBERED** (Izzy, 2026-08-18). A second tenant
  named **"a plus center"** was created today beside the real one from April —
  duplicates silently **overwrite each other's agent-knowledge document**, make
  every name lookup ambiguous, and show two identical rows in the switcher. The
  newcomer becomes **"a plus center 2"**; ⛔ **the first holder is never renamed.**
  ⛔ **Both** tenant-creation paths use the one helper (`onboardingPayment.ts` and
  `setupOrchestrator.ts`) and a test reads both call sites — fixing one of two paths
  is the recurring defect shape here. Case-insensitive, and **removed tenants still
  hold their name.**
- ⛔⛔ **`ep3wlb` ON THE PBX NAMES IS DELIBERATE — DO NOT REMOVE IT.** Izzy asked
  about `a plus center ep3wlb` / `344022_apluscep3wlb`. That is `identitySuffix()`,
  the **collision guard** documented in `provisioningIdentity.ts`: without it a
  second sign-up with the same company name **adopts the first customer's VoIP.ms
  subaccount** (their password is rotated — customer A loses dial tone) **and builds
  its extensions inside customer A's PBX tenant.** Today's duplicate "a plus center"
  is exactly that case. It is load-bearing in `pbxLabel` too —
  `findPbxDirectoryEntry` matches on **slug OR displayName**. ✅ **No customer ever
  sees it**: the Connect tenant name is the clean company name; the tag appears only
  in the VitalPBX panel and the VoIP.ms subaccount list.
- **Tests:** 15 portal + 17 api, both registered; onboarding suite **280/280**;
  portal 171/173 (the two pre-existing); portal typecheck **0**; api typecheck adds
  **0 errors in any edited file**. ⛔ **Proven non-vacuous** — all five portal and
  all four api source guards fail against `HEAD`, and the old `buildE911Address` is
  shown returning `"DR"` where the new one refuses. ⛔ Run api tests with
  `node --experimental-test-module-mocks --import tsx --test` or every `mock.module`
  file dies and reads as a mass regression.
- ⏳ **NOT PROVEN: nobody has run a sign-up through the new screen.** Acceptance is
  5 minutes and needs no card — search **718** (must now explain itself), then **845**
  (numbers must still appear), then blank the company name at Review and submit (the
  server must refuse in plain English).
- ⛔⛔ **RESOLVED 2026-08-18 EXCEPT ONE THING, AND THAT ONE THING IS THAT (929) 852-4026 HAS NO 911.** Izzy's instruction: *"TYH Industries / turn off e911 for now."* Done and verified: the tenant is renamed **"TYH Industries"** (`cmsyv8mlb0yheqo13t7u7x1fe`), and **E911 was CANCELLED on the DID** — `e911Cancel` → success, confirmed twice (`e911Info` → `e911_disable`, `getDIDsInfo` → `e911: "0"`). ⛔ **So that line cannot reach emergency services at all.** It was the safer of two bad options, because the address registered until then was **Izzy's own** and dispatch would have been sent there — but it is a real gap and it is meant to be **temporary**. **The way back:** get TYH Industries' true service address, then `e911Validate` → apply VoIP.ms's `alternatives` → validate once more → `e911Provision` (⛔ `language` must be **`EN`**, uppercase, and validate is more lenient than provision). `answers.provisioning.e911` now reads `status: "cancelled"`, `needsAttention: true`, with the old address preserved under `previousAddress`, and the sign-up timeline says so in plain words.
- ⛔ **The PBX side still carries the old address and was deliberately NOT touched.** T106's emergency **location** row reads `13 koznitz rd, monroe` and notifies `izzywgg@gmail.com`, and its emergency **numbers** (911 + 8457831212 via trunk 131) are still rendered. That is harmless while the carrier registration is off — the call reaches VoIP.ms and is refused — and **removing the PBX emergency route would be worse**, because 911 would then fall through to ordinary outbound routing instead of failing cleanly. Fix it in the same pass as the re-registration.
- ✅ **Also done 2026-08-18:** the duplicate name is gone (the April customer keeps **"A plus center"**, the new one is **"TYH Industries"**) — ⛔ and the **provisioning identity was deliberately left alone** (`pbxLabel` "a plus center ep3wlb", `tenantSlug` "a_plus_center_ep3wlb", `voipmsSubName` "apluscep3wlb"), because those strings are matched against the LIVE PBX tenant T106 and VoIP.ms subaccount; renaming them orphans the objects. **The panel will keep showing the old label — that is correct, not a missed rename.** Golda Moldavsky was added to TestFlight group **"Loopcom Testers"** (`fe508ee6-4a3f-49dd-bf53-858839fa2f06`, build **52** attached) — Apple sends the invitation itself, so adding the tester IS the whole job.
- ⛔ **DECIDED 2026-08-18 — DO NOT RESEND HER INVITATION.** Her original welcome email named *"a plus center"*, but she has since gone **ACTIVE** (password set, signed in), and `POST /admin/users/:id/resend-invite` does **not** merely re-send: `server.ts:7790` writes `status: "INVITED", forcePasswordReset: true`, so it would **invalidate the password she just created** — and it cannot retract the email already in her inbox, only add a second one. Izzy's call, asked and answered: **leave it.** Her portal, invoices and every future email already read TYH Industries; one stale email she has already opened is not worth locking a customer out. ⛔ The same trap applies to ANY active user — `resend-invite` is an invite, not a notification. **$45 was really charged** against a sign-up that carried someone else's details.
- ⏳ **Gap NOT closed:** two browsers on one link still share one `answers` record.
  The gate stops a *blank* field inheriting someone else's value; two people who
  both type into a field still overwrite each other. Per-visitor drafts or an
  "already open elsewhere" warning is a product decision.
