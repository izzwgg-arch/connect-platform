# ⛔⛔ AGENT HANDOFF — TELNYX: the account is SET UP AS FAR AS TRIAL ALLOWS, the SIP pair Loopcom-Primary-SIP + Loopcom-Primary-Outbound EXISTS on the Telnyx side, the A-attestation rules are RESEARCHED WITH CITATIONS, and the /apps/telnyx BENCH is BUILT (2026-09-15) — READ FIRST before touching apps/api/src/telnyx/, the Telnyx account, or before answering "can Telnyx give us attestation A?"

Izzy, 2026-09-15: *"setting up my Telnyx account for my company, Loopcom … configure
Telnyx so that calls using eligible Telnyx-hosted telephone numbers receive the
highest legitimate STIR/SHAKEN attestation available, preferably A"* and *"create a
new page inside Loopcom called Telnyx and wire the whole API in, so if we want to, I
can switch between SignalWire, [VoIP.ms], and Telnyx"* — then, mid-task: *"Loopcom is
NOT simply an end-user business … make sure the TELNYX ACCOUNT and TELNYX
CONFIGURATION correctly reflect that Loopcom is a VOICE SERVICE PROVIDER."*

Why Telnyx is on the bench at all: **SignalWire signs outbound at attestation C until
vetted** (proven live 2026-08-18, "carriers are filtering it" — see
AGENT_HANDOFF_SIGNALWIRE_PIVOT_2026-08-18.md §the-fourth-fact). Telnyx's documented
rule is **attestation A automatically for any number on the account**.

## 1. THE ACCOUNT — which one, and its exact state

- ⛔ **There are TWO Telnyx accounts in Izzy's orbit. The REAL one is
  `izzy@loopcom.net`.** The other, `izzywgg@gmail.com`, is a bare freemium/Pretrial
  account (profile empty, nothing configured) that I signed into first by mistake —
  Izzy: *"You're using the wrong browser and the wrong account."* A THIRD address,
  `support@connectcomunications.com`, got a "marked Dormant" notice 2026-08-18 for a
  dormant account that can only be revived through identity verification at login —
  nobody has pursued it.
  ⚠️ On the WRONG (izzywgg@gmail.com) account I created a credential SIP connection
  named `Loopcom-Primary-SIP` before the interruption. It is inert, costs nothing,
  and can be deleted whenever someone is next in that account.
- **izzy@loopcom.net account level: TRIAL** (ladder: Pretrial → Trial → Paid →
  Verified, page `#/account/account-levels`). ✓ email verified, ✓ initial account
  verification checks, ✓ 2FA (login texts a code to the phone on file,
  +1 562 209 6644). ✗ verified phone number, ✗ service address, ✗ credit-card
  payment (those three are the whole Paid upgrade, page
  `#/account/account-levels/upgrade`; the address form says it is "used for taxation
  purposes"). Balance **$5.00** trial credit. **0 numbers, 0 messaging profiles.**
- ⛔ **Trial blocks the things that matter**: cannot buy numbers, cannot place real
  calls, outbound concurrency default 2. Everything below is configuration that
  Trial DOES allow — the account is staged so that the moment Izzy completes the
  upgrade (address + card + phone verify, ~5 minutes), a number can be bought and a
  call placed.
- **Profile**: First/Last "Izzy Wein" were pre-filled; I set Company Name
  **"Loopcom LLC"** and Role **"I'm a Business Owner"** in the form — ⚠️ the page
  may not persist them until the Required address fields are also filled (no toast
  either way); re-check after the address goes in. The Role dropdown is personal
  (Business Owner / Team Leader / …), NOT a business classification — Telnyx has no
  self-serve "I am a service provider" field anywhere in the portal; that
  classification happens through Level-2 review, "reinforced KYC" (>200 non-Telnyx
  numbers), and the Managed-Accounts approval (see §5).

## 2. WHAT EXISTS ON THE TELNYX SIDE NOW (all created 2026-09-15, all free)

- **SIP connection `Loopcom-Primary-SIP`** — Connection ID `3049417907428656858`,
  type **Credentials**, ACTIVE. Auto-generated username `userizzy67753`; the
  password lives ONLY in Telnyx (connection → Authentication tab) — never copied
  out, per the no-secrets rule. Chosen credentials-over-IP to match the proven
  VitalPBX registration pattern (SignalWire trunk 132, VoIP.ms subaccounts) — no
  firewall/ACL change needed on the PBX. Settings: AnchorSite Latency; DTMF
  **RFC 2833**; codecs reordered to **G711U first**, then G722, G711A, G729,
  **OPUS enabled**; **"Receive SHAKEN/STIR Identity SIP header" ENABLED**
  (inbound verstat visibility; needs TCP/TLS transport to actually arrive —
  UDP fragments the big Identity header); destination format E.164;
  encrypted media off; no webhooks.
- **Outbound voice profile `Loopcom-Primary-Outbound`** — Profile ID
  `3049418915823224570`, ENABLED, **assigned to Loopcom-Primary-SIP** (portal toast
  "Connection assigned"; Telnyx's built-in "Forward Only" connection deliberately
  NOT assigned). Allowed destinations: **US +1 and Canada +1 ONLY**. Fraud rails:
  **daily spend limit ON at $10/day**, **max destination rate $0.30/min** (kills
  premium routes), no recording, Repeat Call Guard off.
  ⛔ The wizard's step-6 "Assign numbers" table LOOKS like an assignment but is
  only a listing — the real association is the profile's "Connections and
  applications" tab (the wizard's closing dialog even said "0 connections added"
  while the table showed two rows). It is assigned now; verify there, not in the
  wizard.
- **Support Issue #666221** (portal chat, Pylon "Powered by AI") — filed the
  provider question Izzy pre-approved verbatim (Loopcom = US VoIP provider, 499 +
  RMD registered, will Telnyx sign A automatically for purchased/ported DIDs or is
  provider vetting needed) + a second message asking for the carrier-sales /
  Managed-Accounts contact path without commitment. **The AI answered** (§4); a
  pushback asking for HUMAN confirmation on the ported-DID contradiction was sent
  and was UNANSWERED when the session ended — ⏳ check the chat/email for the reply.

## 3. THE ATTESTATION RULES — researched from live 2026 docs, each claim cited

- **A = the caller-ID number is on YOUR Telnyx account.** "All calls originating on
  the Telnyx network will receive an attestation … no action, no charge"; purchased
  portal numbers → A (support.telnyx.com/en/articles/5402969). The developers
  attestation table: A = "call from owned phone number", B = "call from non-owned
  or verified number" (developers.telnyx.com/docs/voice/stir-shaken/attestation-behavior).
  Ported-in numbers count as portal numbers → A, and Telnyx explicitly recommends
  porting in to reach A (5402969 + the sign-your-calls resource; see §4 caveat).
- **Verified external caller ID (their "Verified Numbers", OTP $0.03/success) → B,
  not A.** An unowned, unverified caller ID is REFUSED outright: `403 Unverified
  Caller Origination Number D51` (articles 6988813 + 3546251) — so C effectively
  never arises on Telnyx origination; C is gateway/transit traffic.
- **No account level / vetting is documented as an attestation prerequisite** — and
  the support AI confirmed "no additional provider-level vetting or configuration
  required" (§4). HVSD (high-volume short-duration) traffic drops to B even on
  owned numbers.
- **Which number gets attested = Telnyx's caller-ID selection order:
  P-Preferred-Identity > P-Asserted-Identity > Remote-Party-ID > From**
  (article 3546251). ⛔ So if VitalPBX emits PAI/RPID (sendrpid/trust_id_outbound),
  THAT value overrides From and is what gets signed — the PBX must either put the
  on-account DID in PAI too or not send PAI/RPID at all.
- **Attestation is visible per call**: the `stir_shaken` field on voice detail
  records / CDR reports, US +1→+1 only (telnyx.com/release-notes/shaken-stir-attestation-in-cdr)
  — the /apps/telnyx bench's "Call records" panel reads exactly this. Inbound,
  verification rides PAI `;verstat=TN-Validation-Passed-A` etc. (article 7421223).
- **Loopcom's own certificate is NOT required for A** on Telnyx-hosted numbers.
  It becomes REQUIRED (FCC Eighth Report & Order, effective 2025-09-18 — article
  10806916) only when Loopcom sends OTHER carriers' numbers across Telnyx beyond "a
  limited number of Verified Numbers", or Telnyx numbers out via another carrier.
  Then: own SPC token (prereqs: 499-A ✓ already filed, an **OCN — Loopcom does NOT
  have one**, RMD plan ✓ already filed) → cert from an approved STI-CA → either
  self-host or **Telnyx hosted-cert product, $100/cert/month** (`POST
  /v2/stir_shaken_certs`, then PATCH the outbound voice profile —
  developers.telnyx.com/docs/voice/stir-shaken/hosted-cert; the portal tab for it
  sits ON the outbound-voice-profile page). **Telnyx passes through a customer's
  own Identity header** ("sign your own calls and Telnyx will simply pass your
  certificate onto our terminating provider"; use TCP/TLS). Delegated
  certificates: not offered/documented at Telnyx.

## 4. THE SUPPORT AI'S ANSWER ON #666221 — and the one contradiction

The AI's table "What This Means for Loopcom": purchased DIDs → **A (Full), None —
automatic**; **ported DIDs → B (Partial)**; external DIDs → C; "Telnyx will sign
your calls automatically with no additional provider-level vetting or configuration
required"; verify via the CDR CSVs in Reporting; for own-cert signing it listed
499A + OCN + RMD plan + approved-CA certs + own SHAKEN implementation, and said
Telnyx passes the customer token through. On commercial: **Pricing Plans page →
self-serve Starter/Growth commit, Enterprise = "Contact sales" — "the right entry
point for a provider of your scale (~50+ US numbers and growing)"**; Managed
Accounts = limited-release, needs approval.
⛔ **The ported-DID = B claim CONTRADICTS Telnyx's own docs** (5402969: purchased
OR ported → A; their porting pitch is literally "port in to get A"). Its own
prose even said B applies "when Telnyx … may not have full visibility into the
number's ownership" and "expect B-level unless you complete a full port into
Telnyx" — i.e. a COMPLETED port should be A. The pushback asking a human to settle
it is the open item. ⛔ Do not repeat "ported = B" as fact, and do not plan the
migration on it — but also do not promise A on ported numbers to a customer until
the human answer or the first real ported call's CDR proves it.

## 5. PROVIDER ARCHITECTURE (for the many-tenant future) — researched, decided nothing

- **Managed Accounts** is Telnyx's real reseller machinery: sub-account per
  customer, rollup billing, hidden inherited pricing, per-sub-account API keys,
  1,000 default cap — but it is **limited-release, needs Telnyx approval, and is
  gated on a committed-use plan** (portal page says "available with our Starter,
  Growth, or Enterprise plans"; support article 4951492 puts those at
  $1k/$2k/$5k+ per month, quarterly — treat exact tiers as sales-confirmed only).
  ⛔ A commitment is Izzy's decision; nothing was signed. **"Organizations" is NOT
  this** — it is multi-login/one-balance, and its doc explicitly says it prevents
  reseller scenarios.
- **Until/unless Managed Accounts: one flat account scales fine** — numbers carry
  `customer_reference`, `tags`, and `billing_group_id` per downstream customer;
  inbound routing is per-number → connection; one shared connection for the whole
  PBX is supported (channel caps: account outbound default 2 → 10 at Level 2 →
  email support beyond).
- **10DLC**: one Telnyx account CAN hold many brands — the documented ISV pattern
  is **one brand + one campaign per downstream business** ($4.50 brand, LVM
  $1.50/mo, sole-prop path exists; Level 2 + messaging required;
  developers.telnyx.com/docs/messaging/10dlc/isv-reseller-onboarding). Never
  register customers' traffic under a Loopcom brand.
- **CNAM**: outbound listing is **FREE per number**, ≤15 chars, settable via
  `PATCH /v2/phone_numbers/{id}/voice` `cnam_listing` — so ABC PLUMBING / XYZ
  MEDICAL per customer number, never LOOPCOM on everyone (the bench has a per-number
  CNAM editor). Not on toll-free; 12–72h propagation. Reputation: Telnyx "Number
  Reputation" (their Voice-Integrity equivalent) has free cached lookups but
  remediation rides a $100/mo Enterprise base — Izzy's call. Branded Calling =
  $50 + $50/mo per brand + $0.075/display, T-Mobile+Verizon only.
- **E911**: per-number emergency address (each customer's REAL address per DID —
  the fee shows only in-portal at enablement), plus a dynamic-E911 API
  (`/v2/dynamic_emergency_addresses|_endpoints`, PIDF-LO) for nomadic. 933 reads
  the address back. Never a blanket corporate address.
- **Porting**: full API lifecycle — `POST /v2/portability_checks` →
  `POST /v2/porting_orders` (auto-splits by SPID/FastPort) → PATCH end-user info +
  docs + FOC + `phone_number_configuration` (connection/messaging/E911 applied AT
  activation) → `/submit` → `porting_order.status_changed` webhooks → LOA template
  endpoint. **The LOA is signed by the END CUSTOMER** (name matching the losing
  carrier's records) — collect LOA + a recent bill copy from customers. US/CA
  port-ins free; FastPort gives a chosen activation moment. ⛔ This is the piece
  VoIP.ms-era tooling never had (SignalWire has NO porting API) — the carrier
  migration board's manual-filing gap CLOSES if Telnyx is chosen.

## 6. THE LOOPCOM BENCH — /apps/telnyx (BUILT, tested; deploy state in TESTS_RUN)

Mirrors the SignalWire bench contract exactly (SUPER_ADMIN force line, own key
`can_view_apps_telnyx`, in `OWNER_ONLY_FIXED_NAV_ITEMS`, audit rows `telnyx.*`, no
touching VoIP.ms/onboarding/worker/PBX, purchases never retried, no public
webhooks yet):

- `apps/api/src/telnyx/telnyxCredentials.ts` — AgentSecret key `telnyx_credentials`
  ({apiKey `KEY…`, optional Ed25519 publicKey}), encrypted, write-only, env
  fallback TELNYX_API_KEY. NOT a Prisma model (the evaluation-must-not-cost-a-
  migration rule, kept from SignalWire).
- `apps/api/src/telnyx/telnyxClient.ts` — plain fetch on api.telnyx.com/v2 (⛔ no
  SDK — the undici boot-kill lesson), injectable fetch for tests: balance probe,
  number search/order/list/update/CNAM/release, connections + outbound profiles
  (read-only — their secrets stay in Telnyx), portability check, SMS send, **voice
  detail records incl. the `stir_shaken` field** (the attestation proof panel).
- `apps/api/src/telnyx/telnyxRoutes.ts` — `/admin/apps/telnyx/*`, every route
  requireOwner-gated; registered in server.ts beside SignalWire with the
  `can_manage_global_settings` prefix rule.
- `apps/api/src/telnyx/telnyx.test.ts` — **14 tests**: credential shape, URL/error
  classing, fake-fetch client (Bearer header, limit clamped to Telnyx's 50,
  ⛔ order sends ONE request, timeout ≠ retry), source guards (server.ts wiring,
  requireOwner on every route, no-VoIP.ms promise, nav force line + Locked list,
  shared catalog row, **and the package.json glob registration itself** — the
  carrierMigration trap). ⛔ Registered as `src/telnyx/*.test.ts` in
  apps/api/package.json. **All 5 wiring guards replayed against HEAD read 0 —
  non-vacuous.**
- Portal: `apps/portal/app/(platform)/apps/telnyx/page.tsx` (credentials card,
  balance pill, search/buy with auto-attach to Loopcom-Primary-SIP, owned-number
  table with per-number connection attach + CNAM editor + release, SIP objects
  read-only, portability checker, SMS test, **Call records with the STIR/SHAKEN
  column**, event log); nav item apps.telnyx in navConfig + @connect/shared
  SIDEBAR_ITEMS + force line + OWNER_ONLY_FIXED_NAV_ITEMS.
- **Carrier switching**: this bench + /apps/signalwire + /apps/voip-ms are the
  three consoles; actual cut-over levers stay what they were
  (`ONBOARDING_NUMBER_PROVIDER`, `TenantSmsNumber.provider`, PBX trunks) — nothing
  new flips traffic.
- **Two drive-by fixes that belong to this commit's story**: (1)
  apps/portal/package.json's test script had
  `wizardDeviceIdentity.test.tslib/nativeSelectSweep.test.ts` — a missing space
  silently unregistering TWO test files (the documented trap, live again); fixed.
  (2) Re-enabling nativeSelectSweep exposed a native `<select>` that crept into
  `OrdersDesk.tsx` (rows-per-page) while the sweep was dark — converted to
  ConnectSelect. Both suites pass now.

## 7. WHAT THE PBX WILL EVENTUALLY NEED (Phase-11 recipe — ⛔ NOT applied, no PBX write happened)

- Registrar `sip.telnyx.com` (credential auth; SRV-backed), username
  `userizzy67753`, password from the connection's Authentication tab. **Transport
  TCP (or TLS)** — required for Identity-header delivery both ways.
- From/PAI: the on-account DID in E.164; ⛔ align or suppress PAI/RPID (§3 —
  selection order means a stray PAI overrides From and gets signed instead).
- Codecs ulaw first (+opus optional), DTMF RFC2833, inbound arrives with the DID
  in E.164 — the trunk context needs the same 10-digit `Goto(default-trunk,…)`
  normalisation every carrier gets; credential connections must REGISTER to
  receive inbound.
- Same VitalPBX build path as trunk 132 (panel replay + doorway re-bake).

## 8. THE BLOCKERS (all Izzy-gated), in unlock order

1. **Paid upgrade on izzy@loopcom.net**: service address (which address is
   Loopcom's for taxation? ⛔ not guessed) → card → SMS phone-verify. ~5 min in
   `#/account/account-levels/upgrade`.
2. **Buy ONE test number** (~$1/mo + $5 sitting there) → attach to
   Loopcom-Primary-SIP (the bench does this in one click).
3. Build the PBX trunk per §7 (⛔ PBX write — Izzy's standing gate), dial out,
   read the CDR's `stir_shaken` field on the bench. **"A" in that field on a real
   call is the acceptance criterion for this whole engagement.**
4. The ported-DID attestation answer on #666221 (or prove it empirically with the
   first ported number).
5. Commercial: Enterprise "Contact sales" when Izzy wants provider pricing /
   Managed Accounts — no commitment made.

## 9. ⏳ NOT PROVEN

No Telnyx credential has been saved into the bench (no API key was created — do it
in the portal → API Keys once wanted), no number exists, no call has been placed,
no attestation observed first-hand, the support pushback is unanswered, and the
profile Company-Name save needs re-checking once the address is in. The bench
deploy state is recorded in TESTS_RUN.md (this session: built + tested; see the
entry for whether the deploy happened and its container verification).

## 10. THE TRUNK IS LIVE AND THE ATTESTATION IS PROVEN — SHAKEN_STIR=A on a real answered call (2026-09-15, afternoon)

Izzy: *"Build the trunk on the PBX and make the test call. Wire the outbound route
and inbound route to Ezra test extension 102."* ⛔ "Ezra ext 102" did not exist —
no Ezra tenant has a 102; Izzy chose **Loopcom Demo (T102) ext 102 "Maya
Feldman"** from the real options. All PBX writes under that explicit instruction.

- **Account first**: izzy@loopcom.net upgraded to **VERIFIED** (all criteria green
  incl. KYC + AI-eval; ⛔ his card was declined TWICE by the billing-address form
  and passed on the LAST attempt before account review — never brute-force it).
  Number **(845) 306-6825** bought ($1 + $1/mo, Izzy-approved), attached to
  Loopcom-Primary-SIP in the cart itself.
- **Telnyx side** (via API from inside app-api-1, key from AgentSecret): the
  credential connection's password ROTATED to a fresh secret (generated in the
  container, travelled to Telnyx + the panel form only, `/tmp/tx-secret` deleted
  after; retrievable forever in the Telnyx portal → connection → Authentication)
  and **`inbound.dnis_number_format = "national"`** — that one setting makes
  Telnyx deliver the DID as a 10-digit request-URI, i.e. the VoIP.ms shape, so
  **NO custom `exten => s` dialplan block was needed** (unlike SignalWire's §10.3
  trap). The generated `trk-183-in` pattern handles it as-is.
- **PBX build** (scripts run in app-api-1 with the SAME proven builders —
  createTrunk / createInboundRoute / editOutboundRoute; backups
  `/root/ombu_outbound_routes-backup-telnyx-20260915T115327Z.sql` +
  `ombu_tenant_dids-…` + queued-changes snapshot on the PBX):
  **trunk 183 "Telnyx Loopcom-Primary"** (registration to `sip.telnyx.com`, user
  `userizzy67753`, UDP, ulaw-first) → **`Registered (exp 3459s)`, contact Avail
  38ms, identify 192.76.120.10/32**; DID row `(102,'8453066825','Telnyx test')` +
  module-99 queue + Main apply → `default-trunk _8453066825 → Loopcom Demo`;
  inbound route in T102 → ext 102 (dest id 396); **outbound route 123 trklist →
  183** (was 132/SignalWire) and ⛔ **route CID had to change 3479780090 →
  8453066825** — an unowned CID is a Telnyx 403 D51, there is no send_as
  net like SignalWire's. Tenants 2/9/25's pending panel rows verified INTACT
  after every apply.
- **THE PROOF** (Telnyx's own CDRs, record_type `sip-trunking`, field
  `shaken_stir` — ⛔ "voice" answers 400/10011; the bench client now pins the
  working strings): hairpin `Local/8453066825@T102_cos-all` ran the full loop
  out-and-back and RANG ext 102 + its wake-dial leg; then
  `Local/5622096644@T102_cos-all` called Izzy's cell — **ANSWERED, 18s billsec,
  caller ID (845) 306-6825, two-way audio** — and all three CDR rows read
  **`SHAKEN_STIR=A`**. The engagement's success criterion is met per-call, not
  by inference.
- ⏳ Still open: ext 102 has no registered device (inbound rings → VM after 30s);
  E911 not registered on 845-306-6825 (⛔ dial 933 never 911 from this trunk);
  no 10DLC so its texting won't deliver; SignalWire trunk 132 + route CID
  3479780090 history preserved in the backups if T102 must revert; the
  ported-DID-attestation human answer on Issue #666221 still pending — though
  A on purchased is now first-hand fact.

## 11. THE WIZARD RUNS ON TELNYX (2026-09-16) — what was built

Izzy: *"switch the onboarding wizard to Telnyx. It's going to be Telnyx for now, and then stress test
the fuck out of it because I want to have people use it today. Make sure that it works end to end. I'm
even giving you permission to buy one phone number for the test, and then same with porting."*

Switch state: **effective carrier = telnyx** (AgentSecret `onboarding_number_provider_override`,
stored 2026-09-16 with a `carrier.wizard_provider_set` audit row). Revert = the /apps/telnyx
"Wizard carrier" card, or store `voipms`. Stamped drafts keep whatever carrier they were stamped with.

Modules (all under apps/api/src):
- `telnyx/telnyxOnboardingClient.ts` — the onboarding half of the Telnyx client (the bench client keeps
  its "not wired into onboarding" promise). Search (10031 = empty, not outage), `placeNumberOrder`
  (once), `getNumberOrder`, `findOwnedNumber`, `configureOwnedNumber` (⛔ messaging profile via
  `/phone_numbers/{id}/messaging`), CNAM (≤15 A-Z0-9), `createAddress` (validate_address) +
  `enableEmergency`, porting (create/get/list/patch/requirements/confirm), `uploadDocument` (base64
  JSON), 10DLC brand/campaign/assign, messaging profile create.
- `onboarding/telnyxNumbers.ts` — wizard search. Concurrency 4, 429 retry ×3 jittered, 60 s cache,
  `LOCALITY_ALIASES` (`NY:MONSEY → SPRING VALLEY`), town fallback only when an area code/pattern still
  narrows the search, "RATE CENTER:SUB" → town.
- `onboarding/telnyxProvisioning.ts` — number stage (gate `TELNYX_AUTO_PROVISION`, "on" in both api
  compose blocks). Connection by NAME `Loopcom-Primary-SIP` (or env `TELNYX_PBX_CONNECTION_ID`),
  messaging profile by NAME `Loopcom Sign-ups` (created with the `/webhooks/telnyx/sms` URL if absent;
  env pin `TELNYX_MESSAGING_PROFILE_ID`). `answers.provisioning.telnyxOrders[e164]` = order id
  persisted BEFORE polling. `customer_reference = loopcom:<tenantSlug>`. E911 → `provisioned` only on
  emergency_status `active`, else `pending_activation` (sweep finishes it). Port = temp number first
  (ported area code, then 845), filing LAST.
- `onboarding/telnyxPortFiling.ts` — `portFiling {provider:"telnyx", status filing|submitted|
  needs_attention|ported, orderIds, loaDocumentId, invoiceDocumentId, telnyxStatus, focDate}`. LOA =
  the Port queue's generated PDF from the typed signature; bill = first `PORTING_BILL` upload.
  `mapPortRequirements` maps the live requirement names ("Letter of Authorization (LOA) for Porting",
  "Latest Invoice from Current Carrier (Within 90 Days)") to doc ids; unknown ones are never guessed.
- `onboarding/telnyxPortWatchdog.ts` — `startTelnyxSignupSweep` (armed in server.ts, boot kick 90 s,
  every 10 min, kill `TELNYX_SIGNUP_SWEEP_DISABLED=1`). Re-files `needs_attention` ONLY when
  `numberStatus === "ready"` (a concurrent re-file during the stage could open a second port order).
  Landing steps each recorded under `portLanding.*`: configure number → 911 on the ported number at the
  same address → copy the temp route's PBX destination (portLanding's helper) + publish → **caller-ID
  switch** (`editOutboundRoute` + `applyAndRebake` on the stored `pbxOutboundRouteId`) → TenantSmsNumber
  TELNYX → email WITHOUT the "temp is switched off" paragraph (⛔ the temp number is KEPT: it is the 911
  callback CID; releasing it makes emergency calls present an unowned CID that Telnyx refuses).
- `onboarding/serverOwnedAnswers.ts` — see §12 bug 1.
- PBX build (`pbxTenantBuild.ts`): `TELNYX_SHARED_TRUNK_NAME = "Telnyx Loopcom-Primary"` (trunk 183,
  Main), route trunks [183, 0001]; ⛔ a Telnyx PORT build presents the TEMP number as caller ID (403 D51
  on an unowned CID) — the landing switches it.
- 10DLC (`signalwire/signalWireTenDlc.ts`): ONE state machine, `registryFor(reg.provider)` picks the
  SignalWire or Telnyx registry; the TenantSmsNumber provider follows. Telnyx campaign usecase
  LOW_VOLUME_MIXED → `LOW_VOLUME`; the brand needs the structured address (publicRoutes passes it).
- `syncOnboardingSms` is VoIP.ms-only now (it used to call VoIP.ms `setSMS` for SignalWire numbers).
- Portal: `page.tsx` maps `provider: "telnyx"` onto the modern search surface. Customers never see a
  carrier name.

## 12. THE LIVE BUGS — found only by running it (read before touching this path)

1. **Autosave wiped `answers.phone.provider`.** The wizard autosave replaces `answers` wholesale; the
   first live run reached the pay page with NO stamp → payment would have provisioned on VoIP.ms.
   Fix: `carryServerOwnedAnswers` (phone.provider + provisioning) in the save route; /submit pins the
   carrier. ⛔ `texting` is wizard-owned (form state) — carrying it would freeze customer edits.
   Pre-existing: every SignalWire sign-up had it.
2. **422/10027** "messaging_profile_id is not reachable here" on `PATCH /phone_numbers/{id}`.
3. **No Main DID dispatch for shared-trunk builds.** Tenant-context applies never render Main.
   ⛔⛔ A bare `applyAndRebake(Main)` STILL left it missing — the mirror tenant-create writes rows and
   queues nothing for Main's `tenants` module (99). What works (proven on tenant 143): panel
   `saveTenant(Main, tenantId, {inboundNumbers: same list})` → VitalPBX queues (1, 99) → then
   `applyAndRebake(Main)` → `_8457774807 → Forwarding call to Loopcom Telnyx Test` and
   `incoming-calls → Goto(T143_default-trunk)`. Doorways re-baked 4/4, 0 failed. Verify with
   `asterisk -rx "dialplan show <did>@default-trunk"` — if only the catch-all `_[+*#0-9A-Za-z].`
   answers, the dispatch is NOT there.
4. **An interrupted build never resumed** — `resolveTenantPath` trusted the stale REST list; the mirror
   refused "already exists"; the panel fallback failed; every watchdog retry failed. Now DB first.
5. **`pbx_tenant_not_in_directory`** — same stale list in `findPbxDirectoryEntry`. DB fallback feeds
   the FULL `ombu_tenants` table (⛔ the sync deletes unlisted rows), only if the new slug is present
   and rows ≥ half the known directory. Live check before shipping: 31 = 31, would-delete none.
6. Smaller: 429 past ~17 concurrent searches; Monsey is not a rate center (Niagara Falls fallback);
   `COMPTON:COMPTON DA` localities; a resumed emergency-location step said "911 broken"; a bash heredoc
   put BACKSPACE bytes into a regex — check new files with `grep -P "[\x00-\x08\x0e-\x1f]"`.
7. ⛔ My own api deploy restarted the container mid-build (a tsx script inside the container dies
   with it). Never deploy api while a sign-up build is running in that container.

## 13. WHAT IS PROVEN LIVE (2026-09-16)

- Search: 45 parallel live searches (found #6); switch on; Telnyx stock survey by area code.
- Wizard in Chrome (keystrokes stopped reaching the tab mid-run; drove it with native-setter input
  events), all 7 steps → Sola pay page, quote $35 (1 ext + 1 number). Stamp `telnyx` verified in the
  DB after every autosave.
- ⛔ The card was NOT charged: test invoice CC-202609-00012 was marked PAID in the DB by Claude
  (`metadata.testPaymentMarkedBy`), and the timeline says so. Pay-page code unchanged by this work.
- Number stage: ONE order `e9f5eb60-…` for **+18457774807**; the first run failed on bug 2; the
  automatic retry ADOPTED the number (no second purchase); routed to Loopcom-Primary-SIP + profile
  `4001a0ab-3699-450e-83b9-77ac48c3f0dc`; CNAM requested.
- E911: Telnyx 85009 "must be manually validated" for `33 NY-17M Suite C, Harriman` (also
  "33 Route 17M"); `30 Robert Pitt Dr, Monsey` validates. The build recorded `failed / needs a person`
  and withheld the E911 email — correct behaviour.
- PBX: tenant 143 `loopcom_telnyx_test_bqy1lb` path `1e7750f5d990d22b`, outbound route 180
  (CID 8457774807, trunks [183, 72]), ARS 308, ext 101 (id 672), inbound route, Main dispatch.
  Trunk 183 `Registered` on the PBX (Telnyx's own `registration_status` field reads "Not Registered" —
  stale, ignore it).
- Connect: billing moved to live tenant `cmu4e9l1i01wgqk129z4f2eyn`, billing defaults stamped, ext 101
  synced + SIP, owner `izzy+telnyx-e2e@loopcom.net` TENANT_ADMIN, 1 invite SENT, submission ACTIVE.
- Webhook public key: `GET /v2/public_key` returns it (no portal login needed) — saved into the
  credentials; `publicKeySet: true`. Telnyx inbound SMS is no longer blocked on it.
- Porting on live DRAFTS for +15622096644 (never confirmed; DELETE 204 ×3): create → LOA upload →
  invoice upload → PATCH with end_user/location/BTN/PIN/phone_number_configuration/documents/
  requirements all accepted and read back. `requirements_met` stays false on a draft.

## 14. OPEN / NEXT (⏳)

- **A human call**: dial (845) 777-4807 → should ring ext 101 (no device → voicemail); sign in as the
  invited owner to answer on the app; outbound from ext 101 should show 845-777-4807 and the Telnyx CDR
  `shaken_stir` should read A.
- **A real port**: Izzy picks the number + provides the carrier account #, PIN, name/address on the bill
  and a recent bill PDF. Only a real CONFIRM shows whether Telnyx accepts the requirements as sent.
  The landing sweep then needs its first real run.
- Telnyx 10DLC filing with a real EIN; the E911 manual-validation path (Telnyx support) for addresses
  like 33 NY-17M; NYC-core area codes (212/718/347/646/917/332/201) have NO Telnyx stock.
- Scoped "transfer a number only" links on Telnyx still park the port in the Port queue (not auto-filed).
- Wipe the "Loopcom Telnyx Test" tenant (PBX T143 via the two-step panel protocol + Connect tenant)
  after the call test; release 845-777-4807 only if Izzy doesn't want it kept.

## 15. 911 IN POSTAL FORM + OWNER ALERT + RETRY, FASTPORT, AND THE 723-1213 PORT (2026-09-16, evening)

Izzy: *"yes, do it"* (alert + retry), *"the 33 should be 33 State Route 17M. I think there are two ways of
doing it. We had the same problem with Facebook"*, *"submit a real port through the wizard for 7231213"*,
*"make it a fastport"*.

- **The two ways, proven on Telnyx's validator:** the NY State record / Facebook form `33 NY 17M` (and
  `NY-17M`, `Route 17M`) → **85009 manual validation, no suggestion**; the postal/911 form
  **`33 State Route 17M` + `Ste C` → valid**; `Suite C` → 20209 invalid extended address.
  `e911Normalize.ts` rewrites NY route forms → `State Route N` (NY only) and unit words → USPS
  abbreviations; `chooseRegistrableAddress` validates → takes Telnyx's correction ONCE (same house number
  + state only) → validates → only then creates the address. **LIVE: the office address was written as
  `33 State Route 17M, Ste C, Harriman NY 10926` and CREATED at Telnyx.**
- ⛔⛔ **NEW BLOCKER (Izzy's to clear): `enable_emergency` answers 10015 "You must accept the Emergency
  Terms of Service before you can enable emergency services for a phone number" (/user_id).** An
  account-level legal acceptance in the Telnyx portal — NOT accepted by the agent (terms acceptance is the
  owner's). Until then NO Telnyx number can get 911. After acceptance the sweep retries within the hour, or
  `POST /admin/onboarding/submissions/:id/retry-e911`.
- **Owner alert:** `e911Escalation.ts` — `AgentEscalation` row (SMS within 30 s), never ADMIN_ALERT,
  de-duped per number while open; raised at build end when 911 is failed/address_incomplete and by the sweep
  when an automatic retry still fails.
- **Retry:** sweep retries Telnyx `failed` 911 hourly ×6 then every 6 h (`e911RetryDue`; never
  `address_incomplete`); success → "E911 is set" email if the build is done. Shared implementation
  `retryTelnyxE911ForSubmission` also behind the SUPER_ADMIN route above. **LIVE: the sweep's boot run
  retried the test number by itself right after deploy.** VoIP.ms sign-ups get the alert but no retry.
- **FastPort (`42cccd3a`):** read live on a deleted draft for +18457231213: `fast_port_eligible: true`,
  `activation_type: scheduled`, `allowed_foc_windows` business days 11:00Z–01:00Z (7 AM–9 PM ET), earliest
  two business days out; requirements = LOA + "Latest Invoice from Current Carrier (Within 90 Days)" (must
  show name, number, carrier name/logo, issue date, account number). The filer requests the EARLIEST
  allowed window on eligible orders (`fastPort`, `focRequested` on portFiling). Current carrier per Telnyx:
  **BANDWIDTH.COM CLEC, LLC - NY** (VoIP.ms's underlying).
- **The 723-1213 port — Izzy chose "submit through the wizard anyway" after being shown the blast radius:**
  (1) the platform texting sender (`billingSmsSender.ts`) is hard-wired to VoIP.ms — at switch-over every pay
  link, receipt and sign-in code stops sending until platform texting moves to Telnyx with an approved
  registration; (2) the wizard lands the number in a NEW tenant, not T35 "Connect Communications";
  (3) it is on the migration board's PROTECTED list; escalation texts also go TO 723-1213.
  Link `CQ4nspf33rQgh4JGtlmIXBgHe9gkRfnC` (submission `cmu4gjgu30000r17t3dczbxxx`): company Loopcom LLC,
  contact Israel Weinstock / izzy@loopcom.net, address 33 State Route 17M Suite C Harriman NY 10926, port
  number (845) 723-1213, carrier VoIP.ms, account 344022 — prefilled by the agent. ⛔ **Left for Izzy: name on
  account (as on the bill), the TYPED SIGNATURE (a legal authorization — never typed by the agent), the
  VoIP.ms bill upload, extensions, and payment.** Nothing is filed until payment; then the number stage buys a
  temporary Telnyx number and files the FastPort.
