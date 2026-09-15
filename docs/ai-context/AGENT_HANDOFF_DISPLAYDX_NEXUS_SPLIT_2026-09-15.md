# AGENT HANDOFF — Display Decks split into NEXUS REALTY (Michael, existing tenant renamed) + DISPLAYDX (Ellie, new billing-only tenant); Ellie's 3 missed cycles invoiced, NOT charged; ⛔ PHONES NOT MOVED YET (2026-09-15)

Izzy, 2026-09-15: *"Display Decks is made out of two different companies, and I want to split
them up … The existing Display Decks account should be changed to Nexus Realty, and the owner
is going to become Michael. Ellie is Displaydex, Quicksat Rental, and the other one … Everything
else is going to become a new account called DisplayDX … Michael stays on that credit card,
Ellie on his credit card … check Sola. When was the last time Ellie was charged, and create
invoices from then till now? … don't move any phones yet."*

Related: `AGENT_HANDOFF_SECRO_FIXUP_SOLA_MISMAP_2026-09-09.md` (§5 predicted exactly this tenant's
blocked autopay), `AGENT_HANDOFF_YS_PLUMBING_BILLING_ONLY_TENANT_2026-08-31.md` (billing-only
tenant pattern). Memory: [[displaydx-nexus-realty-split]], [[autopay-blocked-by-a-mis-mapped-sola-link]].

## 1. What was true before (all proven live 2026-09-15)

- Tenant `cmnlgryom001fp9paw7le6582` "Displaydex" (PBX tenant 6) held BOTH companies:
  exts 101 Eli Lovi / 102 Michael Fromowitz / 103 Micheal Cell / 104 Yehuda Tyberg; numbers
  (212) 888-0885, (845) 200-3535 (texting DID, assigned ext 101), (845) 364-7474, (845) 414-3736.
- **Two imported cards:** Visa ····0213 exp 10/28 = Sola customer `c112244410` "displaydex corp."
  (**Ellie's**, was tenant default) and Amex ····1005 exp 10/30 = Sola customer `c112585121`
  "Nexus Realty" (**Michael's**).
- **Ellie's last charge ever = 2026-05-28, $30** (invoice CC-202605-00035, PAID, Visa ····0213,
  the tenant's only invoice). Sola's own displaydex schedule `c112244410_s11674189` was disabled
  at cutover 05-28 (live probe: IsActive false, last ran Apr 28). **Jun 28 / Jul 28 / Aug 28
  cycles were all lost** to the mis-mapped Nexus link blocking autopay (294
  `billing.autopay_skipped_active_sola_schedule` events) — $90 uncollected, exactly as the
  Secro handoff §5 predicted.
- **Michael IS paying:** Sola schedule `c112585121_s11766473` "Nexus Realty" $65/mo is LIVE at
  Sola — ran 2026-08-26 Approved, next run **2026-09-26**, card Amex ····1005. Never cut over
  (TOKEN_LINKED).
- A dormant `TenantBillingProfile` "Nexus Realty" already described Michael's side:
  **2 extensions @ $30 + DID 8453647474 @ $0**, Amex, billingEmail Michael@nexusrealtyad.com —
  i.e. Michael = exts 102 + 103 + the ····7474 number, matching Izzy's instruction.
- No Quicksat Rental (or any other Ellie company) exists anywhere at Sola or in Connect —
  Ellie's whole billing footprint is the one $30 displaydex schedule.

## 2. What was DONE (script `displaydx-split.ts`, run live 2026-09-15 ~21:00Z inside app-api-1; Connect DB ONLY — no card charge, no Sola write, no PBX write, no email)

Backup of every touched row: `loopcom:/root/displaydx-split-backup-20260915.json` (600).
Script source kept at `loopcom:/root/displaydx-split.ts` (removed from the container after run).

| Step | Result |
|---|---|
| N1 | New tenant **DisplayDX `cmu31fp430000pfje5qh86dja`** (CUSTOMER, approved, billing-only — no PBX link, no extensions, no users yet; YS Plumbing pattern) |
| N2 | Ellie's Visa ····0213 moved to DisplayDX, default there |
| N3 | DisplayDX billing settings: **$30/mo (manual quantity 1 extension — byte-identical to the old pricing)**, day 28, terms 15, **autopay ON**, billingEmail `eli@displaydex.com`, taxEnabled false |
| N4 | The displaydex Sola link (CUTOVER_COMPLETE, inert) re-pointed to DisplayDX — books follow the card |
| N5 | Old tenant renamed **"Nexus Realty"** — which also HEALS the mis-map: the Nexus link's companyName now matches its tenant |
| N6 | Nexus Realty billing: default card → Michael's Amex ····1005, **autopay OFF** (Michael pays via his live Sola schedule; Connect must not double-bill, and the Sep 25/28 block-alarm will no longer fire) |
| N7 | Michael (`michael@nexusrealtyad.com`) → **TENANT_ADMIN** (account owner) |
| N8 | **3 OPEN invoices on DisplayDX, $30 each, $90 total, NOT charged, NOT emailed** (skipInvoiceEmail; EmailJob count for the tenant = 0): CC-202609-00007 (Jun 28→Jul 28, due Jul 13), CC-202609-00008 (Jul 28→Aug 28, due Aug 12), CC-202609-00009 (Aug 28→Sep 28, due Sep 12) — dueDate = period start + the tenant's 15-day terms, 23:59:59 NY |

All eight steps container-verified by direct SQL afterwards (tenants, cards, settings, link,
role, line items "Billable extensions 1 × $30", zero EmailJobs).

## 3. What happens next BY ITSELF

- **DisplayDX (autopay ON, Visa ····0213 default): the worker creates the Sep 28→Oct 28 invoice
  at T-3 (Sep 25) and charges Ellie's Visa on Sep 28.** Normal billing is restored from that
  cycle on. ⛔ Do not hand-create the Sep 28 invoice.
- The 3 back invoices stay OPEN — the worker never charges late by design
  (`autopay_charge_window_missed`); they are collected by hand or payment link only.
- **Nexus Realty: Sola charges Michael's Amex $65 on Sep 26** as it has every month. Connect
  autopay is off there, so nothing else fires.

## 3b. ✅ COLLECTED 2026-09-15 19:19Z (Izzy: "Charge his card for all those invoices. Send it out to him by email before you charge the card, then charge it.")

Script `loopcom:/root/displaydx-collect.ts` (guards → emails → wait for SENT → charge, oldest
first, STOP on first non-approval, never retries a charge). All three invoice emails were
**SENT to eli@displaydex.com BEFORE any charge**, then all three charges on Visa ····0213
**APPROVED**: CC-202609-00007 ref 11050937980, CC-202609-00008 ref 11050938015,
CC-202609-00009 ref 11050938046 — $90 total, all three invoices PAID balance 0, and all three
BILLING_RECEIPT emails SENT. Container-verified by SQL afterwards.

## 4. ⏳ NOT DONE — needs Izzy / a later task
2. **⛔ PHONES/EXTENSIONS/NUMBERS/USERS NOT MOVED — Izzy's explicit instruction.** The later
   move: DisplayDX gets ext 101 (Eli) + ext 104 (Yehuda) + (212) 888-0885 + (845) 200-3535 +
   (845) 414-3736; Nexus Realty keeps ext 102 + 103 + (845) 364-7474. ⚠️ Yehuda's login email
   is `yehuda@nexusrealtyad.com` — confirm with Izzy which side Yehuda really belongs to (the
   Nexus billing profile counts only 2 extensions, so he is presumed Ellie's).
3. **Eli's and Yehuda's logins still sit on the renamed tenant** — Eli will see "Nexus Realty"
   as his company name in the portal/app until his user moves with the phones. Moving his user
   row early would break his working softphone (ext 101 + webrtc config live on the old
   tenant), so it was deliberately left.
   ⛔⛔ **THE APP-SWITCH TRAP (traced 2026-09-15 for the planned move):** the login token
   bakes `tenantId` in at sign-in (`issueLoginSession`, `server.ts` ~6316), sessions never
   expire, the preHandler trusts the claim (`jwtVerify` only — no per-request user-row read),
   and the mobile app has NO token-refresh path — a QR scan while logged in only redeems SIP
   provisioning, it does NOT replace the session token (`QrProvisionScreen.tsx:73` logged-in
   branch). So moving Eli's User row alone leaves his live app operating on the OLD tenant's
   data indefinitely. Zero-downtime options: (a) a token tenant-migration shim in the
   preHandler (explicit sub→newTenant map, override `req.user.tenantId` after verify;
   MUST deploy BEFORE the row moves — every ownership guard compares resources to the
   effective tenant, so claim-override + moved rows stay consistent), or (b) accept a
   ~1-minute sign-out/sign-in (needs his password; SIP keeps ringing through the move since
   PBX tenant 6 registration is untouched by the Connect-side split).
4. **Nexus Realty's move onto Connect billing** (takeOverBillingFromSola of the $65 schedule,
   pricing per the dormant billing profile: 2 ext + DID) is a separate decision, same as the
   admin tenant's "coat one" link. Until then autopay stays OFF there.
5. When phones move, extension quantity overrides on BOTH tenants need Izzy's pricing call
   (today: DisplayDX bills a manual quantity of 1 @ $30; 4 real extensions exist on the old
   tenant and 3000-series manual counts were never per-extension-accurate).

## 5. Rules this earned / reaffirmed

- ⛔ A tenant rename is a one-column Connect write; the PBX tenant name, doorway routing and
  Sola customers key on IDs and were untouched.
- ⛔ The blocking-link fix for a two-companies-one-tenant case can be THE RENAME ITSELF —
  once the tenant IS the company on the link, the "mis-map" is healed with zero Sola writes.
- ⛔ Splitting tenants: cards move by `tenantId` + `isDefault`, and the OLD tenant's
  `defaultPaymentMethodId` must be re-pointed in the same step or it references a card the
  tenant no longer owns.
