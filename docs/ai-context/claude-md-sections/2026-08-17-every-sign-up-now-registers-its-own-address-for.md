# ⛔⛔ AGENT HANDOFF — every sign-up now registers its own address for 911 (2026-08-17) — READ FIRST before touching the onboarding address fields, before trusting the VoIP.ms WSDL for a parameter name, or before adding any e911 call

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_E911_2026-08-17.md`**
⛔⛔ **THIS IS ONLY HALF OF EMERGENCY CALLING.** The PBX half — making the 911
call actually leave the building, and survive the overdue-account cutoff that
deactivates every outbound route — is
**`docs/ai-context/AGENT_HANDOFF_EMERGENCY_CALLING_SERVICE_INTERRUPTION_2026-08-17.md`**.
This handoff decides **what address a dispatcher is handed**; that one decides
**whether the call gets out at all**. Read both.
⛔ **They hold the same address in two different forms ON PURPOSE** — the PBX
carries the postal address (`15 Van Buren Dr, Monroe`) for its notification
email, VoIP.ms carries the municipality form (`15 VAN BUREN DR, KIRYAS JOEL V`)
because the emergency database insists on it. **Do not "fix" either to match.**
(`f1479147` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified.** No migration, no PBX write, no flag flipped, no existing
tenant touched.) Izzy, 2026-08-17: *"use the customer's address as e911 and
activate e911 in voip.ms on every future signup"* — *"through the voip.ms API."*

- ⛔⛔ **THE WSDL IS WRONG FOR THIS API — the addLNPPort trap in a new costume.**
  `e911ProvisionInput` declares **`zip`**; the REST endpoint answers
  `missing_zip` for it and only accepts **`zip_code`**. It also **requires
  `email`, which the WSDL does not list at all.** Established by walking the
  live API's error chain (read-only) on 2026-08-17, not by reading docs.
  **Required:** `did`, `full_name`, `street_number`, `street_name`, `city`,
  `state`, `country`, `zip_code`, `email`, `language`. **Optional:**
  `address_type`, `address_number`, `other_info`.
- ⛔⛔ **`street_number` MUST BE ITS OWN PARAMETER** — sending
  `street_name: "30 ROBERT PITT DR"` answers `missing_street_number`. **That one
  fact is why the wizard stopped collecting a single address line** and now asks
  for street / city / state / ZIP separately. ⛔ A draft saved before those
  fields existed is split both client-side (`splitSavedAddress`) and server-side
  (`buildE911Address` → `parseServiceAddressLine`), so an old draft finishing
  today still registers — and a typed value is never overwritten by the parser.
- ⛔⛔ **THE CORRECTION LOOP IS WHAT MAKES THIS WORK HERE AT ALL — the
  emergency database uses the MUNICIPALITY, not the postal town, and Connect
  sells into exactly the places where those differ.** Proven live on the
  deployed code: `30 Robert Pitt Dr, MONSEY NY 10952` is **refused**, comes back
  `alternatives: {city: ["SPRING VALLEY"]}`, and validates on the retry.
  **Without applying `alternatives`, most Monsey sign-ups would fail.** (NYC too:
  `350 5th Ave, NEW YORK 10118` → `5 AVE` / `MANHATTAN` / `10001` — it even
  corrects the ZIP.) Flow is **validate → apply corrections → validate ONCE more
  → provision**; a second round of alternatives means a person should look.
  ⛔ The corrections live in the body of a **FAILED** response, which `vms()`
  used to throw away — it now hangs the whole answer off the error as
  **`err.voipmsResponse`**. Without that there is no loop.
- ⛔⛔ **NEVER PROVISION AN ADDRESS THAT DID NOT VALIDATE.** A registration is
  billable and a wrong one **sends an ambulance to the wrong house**. An address
  that will not validate is reported as needing a human — tested.
  ⛔ **And never let it fail a paid sign-up, but never let it be silent:**
  nothing escapes `ensureE911ForDid`, and every outcome lands on the sign-up
  timeline **and** in `answers.provisioning.e911`, with `needsAttention` on the
  ones a person must act on.
- ⛔ **AN OUTAGE IS NOT "NOT REGISTERED".** `e911Info` answers `e911_disable`
  when a DID has none — and since `vms()` throws on every non-success status,
  **"not registered" and "provider unreachable" arrive as the same exception.**
  Reading the second as the first re-registers and re-charges a DID already
  done. `readExistingE911` separates them and returns `failed` when it cannot
  tell. ⛔ The port landing therefore closes its 911 step only on a **settled**
  outcome — a `failed` verdict retries next sweep, because stamping it done
  would leave **the number the customer keeps** with no 911 address.
- ⛔ **`setSubAccount` IS A FULL UPDATE.** The trunk fallback (`default_e911`)
  resends the account's **own settings including its own password**
  (`getSubAccounts` returns it — verified live), changes one field, then
  **re-reads to prove it stuck**, because `default_e911` is absent from VoIP.ms's
  public REST docs and an ignored field looks exactly like a successful write.
  All best-effort — the DID registration is what actually makes 911 work.
- ⛔ **Only the 24 designators `e911AddressTypes` publishes are ever sent**
  (pinned in `E911_ADDRESS_TYPES`); anything else is dropped, never guessed —
  `address_type` is **not** validated at validate-time (it accepted a bogus
  `"Ste"`), so a wrong value could still be refused at provision time.
- ⛔ **Both call sites are guarded by a test that reads their SOURCE**
  (new number in `applyOnboardingNumber`, ported number in `runPortLanding`
  step 1b, one shared helper). Every defect of this shape here has been a missed
  call site. **Proven non-vacuous — all four assertions fail on the pre-change
  source.** Tests: 34 new, onboarding suite **238 pass / 0 fail**, api typecheck
  adds 0 to its 75-error baseline.
- ⛔ **Probing VoIP.ms read-only:** `docker cp` a `.ts` to **`/app/apps/api/`**
  (node resolves from the *script's* dir — `/tmp` fails `Cannot find module
  '@prisma/client'`) and run it with **`npx tsx`**, because `@connect/security`
  ships as TypeScript source and has no `dist/`. ⛔ **`e911Validate` is the safe
  probe; `e911Provision` registers and bills.**
- ✅ **FIRST REAL REGISTRATION DONE — Matamim, 2026-08-17.** `9293598299` now
  reads `e911: "1"`, `e911Info` returns **15 VAN BUREN DR, KIRYAS JOEL V, NY
  10950**, and the trunk `344022_Matamih8gmrh` has `default_e911` set to it
  (password verified unchanged after the full update).
  ⛔⛔ **AND IT CAUGHT A BUG THAT WOULD HAVE BROKEN EVERY SIGN-UP: the language
  must be `EN`, UPPERCASE, and `e911Validate` WILL NOT TELL YOU.** Validate
  returned `success` with `en`; `e911Provision` then refused the identical
  request — `no_provision`, *"The value 'en' of element 'language' is not
  valid."* ⛔ **Both obvious places to copy the value from are wrong**:
  VoIP.ms's own `getLanguages` lists `en`/`es`/`fr` lowercase, and all 61 of our
  subaccounts store `en`. `"English"` fails too (echoed back as `'En'`). The E911
  field is validated by the upstream emergency provider against its own list.
  **Lesson: validate is more lenient than provision — a clean validate does not
  mean the registration will go through.**
  ⛔ **Matamim also proves the correction loop on a real customer:** they typed
  no city at all, their street sits in **Monroe 10950**, and the emergency
  database refused it and returned **KIRYAS JOEL V**.
  ⛔ **Their sign-up address disagreed with their port order** — the wizard said
  `15 Van Buren Dr` (street only) while the Google Voice port order carried
  `4 Maglenitz St, Monroe` under a different name. **The service address the
  customer typed wins** — that field means "where the phones are". Both streets
  exist and both resolve to Kiryas Joel, so the two candidates are a few
  minutes apart; correctable any time with `e911Update`.
- ⛔ **The trunk fallback also runs on `already_registered`, not just a fresh
  registration.** Matamim's first attempt registered the DID and then failed, so
  the re-run short-circuited and `default_e911` was never set — **a number can
  be registered while its trunk still points nowhere.**
- ✅ **THE CUSTOMER IS TOLD THEIR E911 ADDRESS WHEN THE SIGN-UP FINISHES**
  (`e911ActivatedEmail.ts`, wired at the end of `setupOrchestrator`). Izzy chose
  the short wording (option A of
  <https://claude.ai/code/artifact/4ed02ad7-f4ec-4701-bfae-619b2fd1499a>) and
  asked that it **say E911 in so many words** — subject *"E911 is set for your
  phones"*, the registered address in a panel, one line inviting a reply.
  ⛔ Type is **`E911_ACTIVATED`**, never `ADMIN_ALERT` (muted — it would build
  clean, log clean and reach nobody). Recipient chain is main → billing → oldest
  TENANT_ADMIN, billed to the customer's own tenant.
  ⛔⛔ **IT SENDS ONLY WHEN 911 REALLY IS REGISTERED, AND ONLY WHEN THE ADDRESS
  WAS RECORDED.** `address_invalid`, `address_incomplete`, `failed` and
  `dry_run` all send nothing and say why on the timeline — **telling a customer
  E911 is set when it is not is worse than telling them nothing.** Sends once
  (`emailedAt`), and can never fail a finished sign-up.
  ⛔ **It shows the address AS REGISTERED, not as typed** — that is what a
  dispatcher is handed, and the two differ often here. Option A deliberately
  carries **no** explanation of the town correction, so a customer who wrote
  Monroe reads "Kiryas Joel V" with no note about why. Izzy chose that knowing;
  B and C had the explanatory line.
  ⛔ `applyE911ForDid` now records the registered address on
  `answers.provisioning.e911.address` — **without it the email has nothing to
  state** — and carries it across a re-run that returns `already_registered`.
- ⏳ **STILL NOT PROVEN: no sign-up has driven this by itself.** Matamim was
  registered by hand through the deployed helper, because their port had
  already completed and the watchdog drops a finished row. **Acceptance is the
  next real sign-up** — check its timeline says `911 registered on <did> at
  <address>` and that `getDIDsInfo` reads `e911: "1"`.
  ⏳ **The VoIP.ms E911 rate is still unverified** — this now costs money on
  every sign-up. Connect bills the customer **$3/month** per number, so it
  should be margin-positive, but check the next invoice.
