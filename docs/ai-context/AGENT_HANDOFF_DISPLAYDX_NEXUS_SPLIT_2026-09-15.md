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

## 4b. ⛔⛔ THE PHONE/IVR MOVE WAS STOPPED BEFORE ANY LIVE WRITE (2026-09-15 evening)

Izzy asked to move Eli's app + voicemails/calls/texts to DisplayDX with zero downtime and to
migrate his IVRs from the original Displaydex. **Nothing was moved** — tracing proved the only
design that keeps Eli on PBX tenant 6 (a second `TenantPbxLink` from DisplayDX → T6) breaks
live call paths. Every item below was verified in code or on the live PBX (read-only).

**Who owns what on the PBX — proven from the RENDERED dialplan
(`/etc/asterisk/vitalpbx/extensions__50-6-dialplan.conf:718-751`), not table decoding:**

| DID | PBX route label | Rendered Goto | Rings |
|---|---|---|---|
| 845-200-3535 | Displaydex | `T6_app-ivr,IVR-16` ("Displaydex": 1→rg 802 DD Sales, 2→801 DD Customer Support, 3→800 DD Accounting; invalid/timeout → VM 101) | ext 101 |
| 212-888-0885 | Quick Sat Rental | `T6_app-ivr,IVR-17` ("Quick sat main": 1→807 Bookings, 2→806 Customer service, 3→805 Tech support, 4→804 Billing, 0→803 Other; invalid/timeout → VM 101) | ext 101 |
| 845-364-7474 | Nexus | `T6_app-time-condition,TC-3` ("Nexus Realty", Mon–Sat 9–5; open → IVR-18, closed → pre-announcement 6) | Nexus |
| **845-414-3736** | **Nexus 2** | `T6_app-ivr,IVR-18` ("Nexus Main": 1→808 nexus sales, 2→809 NXR Inquiries, 0→900 NXR Receptionist, 102→ext 102, **104→ext 104**; invalid/timeout → ext 103) | Michael/Yehuda |

Ring groups 800–807 ring only ext 101 (pbx extension_id 33); 808/809/900 ring only ext 102
(id 34). Recordings: 32 "Displaydex main", 33 "Quick sat main", 34 "Mexus Main", 35 "nexus after
hours". No queues. Dial-by-extension (`freedial`) is ON for IVR 16 only.
⛔ **So 845-414-3736 and ext 104 (Yehuda) are MICHAEL'S side, contradicting §4.2's earlier
presumption.** Ellie's side = ext 101 + 845-200-3535 + 212-888-0885 + IVRs 16/17 + rg 800–807.
Izzy said Ellie has three companies — only two exist on the PBX; the third is unconfirmed.

**Connect rows that are Ellie's (read-only census):** all 1,289 contacts (created by eli@);
all 8 SMS threads (+18452003535, inbox owner Eli); voicemails ext 101 = 15; CDRs 62 Eli /
39 Nexus / 37 no owner marker (0 touch both sides); MobileDevice ×2 (iOS + Android, ext 101);
VoicemailEmailRecipient for 101; 1 UserCustomRole + 1 CrmUserAccess (both tenant-scoped).

**⛔⛔ WHY TWO CONNECT TENANTS ON ONE PBX TENANT IS UNSAFE — the platform assumes one Connect
tenant per VitalPBX tenant, resolved by last-wins maps or unordered `findFirst`:**
- **Ringing:** `resolvePbxEventTarget` (`server.ts:~4320`) does
  `tenantPbxLink.findFirst({ pbxTenantId })` then looks up the extension inside THAT tenant —
  if it picks Nexus after 101 moved, it returns null → **no CallInvite, no INCOMING_CALL push,
  Eli's app does not ring.** Same `findFirst` in the invite lookup (`~4481`) and
  `/internal/pbx/wake-extension` (`~36739`). VERIFIED.
- **Call history:** `pbxTenantResolve.ts` returns on the `T6_` marker via last-wins
  `connectByVital` before any DID lookup → every T6 call files under one tenant. VERIFIED.
- **IVR import:** `POST /voice/ivr/migration/import` picks its target with an unordered
  `tenantPbxLink.findFirst({ pbxTenantId })` (`server.ts:~27045`) — cannot target DisplayDX,
  and upserts a DidRouteMapping for EVERY DID reaching the menu. VERIFIED.
- Also (agent trace, not individually re-verified): telephony live-call tagging, extension
  sync (only one tenant per PBX tenant synced per run), `PbxTenantInboundDid.connectTenantId`
  sync rewrites all T6 DIDs to one tenant, IVR publish top-level AstDB keys
  `connect/t_<slug>/*` shared (the two reconcilers would ping-pong + alert), prompt/MOH catalog
  sync, `connect/t_<slug>/interrupted` shared, worker active-call/CDR polls run T6 twice.

**Mobile app facts (traced for zero-downtime):** the login token bakes `tenantId`, never
expires, and the app has NO refresh path. SIP creds are cached on device (registration
survives). Incoming-call pushes (`INCOMING_CALL`) are NOT tenant-filtered in the app
(`NotificationsContext.tsx:~150` returns before the guard); voicemail / missed-call / SMS
alert banners ARE (`isNotificationForCurrentUser`, positive tenant mismatch → dropped).
The telephony WebSocket trusts the token's tenant directly (`TelephonySocketServer.ts:~189`).
`MobileDevice.tenantId` must move with the user or pushes find no device.

**A session-tenant shim was written, tested (20/20) and then REMOVED unshipped:** a preHandler
that rewrote `req.user.tenantId` from the user row (cached 60s, fail-open, SUPER_ADMIN exempt)
plus a sync guard skipping extensions claimed by another tenant. They only serve the unsafe
two-links design; under a real PBX split Eli's SIP identity changes anyway (T6_101 → new
tenant), so a one-time re-sign-in is unavoidable and the shim would add per-request DB reads
for nothing. Recreate from this description if a future move needs it — it also needs the
same lookup in telephony (WS connect + `getTenantId`) to be complete.

**Options put to Izzy:**
- **A (recommended): real PBX split** — a new VitalPBX tenant for DisplayDX built through
  Connect's sanctioned PBX-tenant build path (PBX write → needs Izzy's approval), replicate
  ext 101, rg 800–807, IVRs 16/17 + recordings 32/33, repoint the two DIDs' inbound routes;
  then link DisplayDX to it, move Connect rows (user, devices, voicemails, CDRs, SMS threads,
  contacts, custom role, CRM access), import IVRs from the NEW tenant, publish. Eli signs in
  once (~1 min); numbers flip at night (~35–40 s each).
- **B:** make the platform support per-extension/per-DID ownership inside one PBX tenant —
  ~25 code sites on the live call path, multi-day, high regression risk.
- **C:** leave phones where they are; the billing split (the money) is already done.

## 5. Rules this earned / reaffirmed

- ⛔ A tenant rename is a one-column Connect write; the PBX tenant name, doorway routing and
  Sola customers key on IDs and were untouched.
- ⛔ The blocking-link fix for a two-companies-one-tenant case can be THE RENAME ITSELF —
  once the tenant IS the company on the link, the "mis-map" is healed with zero Sola writes.
- ⛔ Splitting tenants: cards move by `tenantId` + `isDefault`, and the OLD tenant's
  `defaultPaymentMethodId` must be re-pointed in the same step or it references a card the
  tenant no longer owns.
