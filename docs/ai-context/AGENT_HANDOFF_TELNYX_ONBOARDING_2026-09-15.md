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
