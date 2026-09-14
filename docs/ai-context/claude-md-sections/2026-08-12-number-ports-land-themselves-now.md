# ⛔ AGENT HANDOFF — number ports land themselves now (2026-08-12) — READ FIRST for ANY port-in work, "the port completed and nothing happened", the port watchdog, or before touching portLanding/portWatchdog

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PORT_AUTOMATION_2026-08-12.md`**
(commits `c5dc0f7a` → `76a0bfbf` → `5330620d` on `feat/ivr-migration-takeover`,
api **DEPLOYED + container-verified**; live-proven the same day on inii mini's
own port — the first sweep landed it end-to-end, temp number retired, no human).

- **The whole port lifecycle is automatic now.** Build: a porting sign-up
  prepares BOTH numbers (tenant number list, dual inbound routes
  "Main"/"Main ported", the REAL number as outbound caller ID). A 15-min api
  watchdog polls `getLNPStatus` + `getDIDsInfo` (⛔ VoIP.ms has NO port
  webhook; ✅ **`getLNPList` enumerates all orders** — how Matamim's real
  order was found). On arrival: route to subaccount (verified by re-read),
  move texting (claim + copy assignment + tenant default), mirror the
  mapping + book the menu switch via DidSwitchSchedule — or, temp-not-on-
  Connect, **copy the temp route's DECODED PBX destination** (⛔ never the
  raw `ombu_destinations` row id — shared rows cascade away when the temp
  route is deleted; `5330620d`) — then **re-publish through the real
  `/voice/ivr/publish`** as a service principal. ⛔ Retirement gates on the
  ORDER reading completed, never FOC arrival: temp DID → master spare pool,
  SMS row un-claimed, mapping DELETED (unique e164 must free for reuse).
- ⛔ **Completion AND rejection emails ride ADMIN_ALERT → currently
  `ALERTS_MUTED`.** They queue and are skipped; the sign-up timeline is the
  record. A rejected port needs a human and nobody is emailed while the mute
  stands.
- ✅ **MATAMIM LANDED ITSELF — the automation is PROVEN end to end (2026-08-17).**
  Submission `cmsey1yel0002o4xoogh8gmrh`, PBX tenant 104, port **217946 →
  929-359-8299**. **No human touched anything** after the 2026-08-12 backfill.
  One sweep walked **arrival → texting → mapping → destination copy → publish in
  31 seconds** (2026-08-13 00:06); the order read `completed` at 18:24:30Z on
  Aug 17 and the temp number was retired **11 seconds later**. Verified at the
  carrier, not from our own flags: ported **9293598299 → `344022_Matamih8gmrh`,
  sms_enabled 1**; temp **7244198226 → `account:344022`** (spare pool). Verified
  on the PBX: `exten => _9293598299` renders `Goto(T104_cos-all,101,1)`. Two real
  inbound calls answered on it — ⛔ both **0–1 s** (robocall shape), so it proves
  the number rings, **not** that anyone has held a call on it. Full evidence in
  **§4b** of the handoff.
  ⛔ **THE NUMBER ARRIVED FOUR DAYS BEFORE THE ORDER SAID COMPLETED** — this is
  exactly why retirement gates on the ORDER, never on arrival. Gating on arrival
  would have cut the customer over on Aug 13.
  ⛔ **The watchdog going silent afterwards is CORRECT, not a stall** — the sweep
  filter drops any row with `portLanding.completedAt`, and the log line only
  fires when a sweep *acts*.
  ⛔ **`DidRouteMapping.e164` is `+<10 digits>` with NO country code, on all 29
  rows platform-wide** — `+9293598299` is house convention, not a bug (chased as
  one this session). `TenantSmsNumber.phoneE164` **is** full E.164. The two
  tables genuinely differ; don't "fix" either.
  ✅ **THE TEMP NUMBER NOW LEAVES THE PHONE SYSTEM TOO — and this was a CUSTOMER
  OVERCHARGE, not a tidiness nit** (`ed3c561f`, api DEPLOYED; Matamim's cleaned
  up live 2026-08-17). Routing the DID back to the master VoIP.ms account was
  only half of retirement: the tenant kept its inbound route,
  `pbxTenantInboundDidSync` reads **`ombu_inbound_routes`** to fill
  `PbxTenantInboundDid`, and `invoiceEngine.ts:447` counts that table
  (`active: true`) for the **`per_phone_number` E911 fee** — so **every ported
  customer went on paying $3/month for a number they no longer owned.**
  Matamim's active DIDs went **2 → 1**, so their E911 goes **$6 → $3**.
  ⛔⛔ **THE GUARD IS THE POINT, NOT THE DELETE — VitalPBX CASCADES THE
  DESTINATION ROW.** Ports built before `5330620d` gave the temp route and the
  real route the SAME `ombu_destinations` row: **inii mini's 239 and 240 both
  point at row 907**, so deleting their leftover would silently kill
  **646-984-6023, their live number**. `retireTempPbxRoute.ts`'s
  `decideTempRouteDeletion` is a PURE function that refuses any route sharing
  its destination row (checked **across all tenants** — nothing scopes a
  destination row to one), refuses a route with no destination row, and refuses
  to touch the ported number. 9 tests, built from both real shapes.
  ⛔ **Apply Changes is NEVER fired here** — it wipes the Connect doorway off
  every route of every tenant with pending changes, which is a platform-wide
  outage risk for a $3 cleanup. **The stale dialplan exten left behind is inert**
  (the number is on the master account, so no call can reach it) and clears at
  the next legitimate regen. Matamim's still shows one such line — expected.
  ⛔ The cleanup **cannot throw, is attempted ONCE, and a refusal is written on
  the sign-up timeline in plain words** — retrying would never make a shared row
  unshared; it needs a person.
  ⏳ **STILL OPEN: inii mini's shared row** (Izzy deferred it 2026-08-17 — it is
  live-number surgery). Their live route 240 needs its own destination row
  before their leftover 239 can go; until then they keep paying the extra $3 and
  the guard correctly refuses. ⏳ Also still open: the temp DID remains listed in
  **`ombu_tenant_dids`** for tenant 104 (a different table from the routes —
  **it does NOT drive billing**, the routes do), and texting on the ported number
  is a **shared inbox**, so flip it to Joel personally if that's wanted.
  ✅ **THE CUSTOMER IS NOW TOLD — built and DEPLOYED 2026-08-17 (`32dfccfb`,
  container-verified).** Until today the only completion mail was the owner's
  **`ADMIN_ALERT`, which the send door drops** — so the person whose number moved
  found out by trying it. `portCompleteEmail.ts` adds a short customer email on
  the new type **`PORT_COMPLETE`**, addressed to `mainEmail` (falling back to
  `billingEmail`) and billed to **their own tenant**, queued at the completion
  stage beside the owner alert.
  ⛔⛔ **THE TYPE IS THE ENTIRE POINT — never put a customer email on
  ADMIN_ALERT.** It would build clean, log clean and never arrive; a test
  asserts `PORT_COMPLETE_EMAIL_TYPE !== "ADMIN_ALERT"`. **The owner's alert is
  unchanged and still muted** — muting his must never mute theirs.
  ⛔ The temp-number paragraph **drops out when there was no temp number**, a
  missing contact email and a failed insert are both **recorded on the timeline**
  (silence is indistinguishable from a delivered email), and neither can block
  the landing. Wording is Izzy's pick (option C of the three mockups,
  <https://claude.ai/code/artifact/6cc32750-47dc-401c-a466-b3bb1f15f6b5>).
  ⛔ **The billing shell is now REUSABLE, not copied** —
  `billing/emailTemplates.ts`'s `emailShell` is exported with `eyebrow` /
  `footerNote` / `includeSupportBlock`, **all defaulting to the billing
  behaviour**; all **eight** billing emails were proven **byte-identical**
  against the pre-change file. Do not make a third copy, and do not "simplify"
  those defaults — nine live billing emails ride them.
  ✅ **Recipient chain (`20fb2416`): `mainEmail → billingEmail → the tenant's
  OLDEST TENANT_ADMIN`** — proven against the live database. ⛔ Never an ordinary
  `USER`, never another tenant's admin, and a DB failure returns nobody rather
  than throwing into a port. When the admin fallback is used the timeline says so.
  ⛔⛔ **"EVERY PORT GETS IT" IS TRUE ONLY FOR PORTS THE WATCHDOG CAN SEE, AND
  TWO SHAPES ARE INVISIBLE** (audited 2026-08-17 — do not claim blanket
  coverage): **(1) a port filed BY HAND at VoIP.ms** — the sweep needs
  `provisioning.portFiled` + `portId` on a paid submission, and **Matamim's was
  exactly this shape**, entering the pipeline only because a session backfilled
  those fields; **(2) a port for an EXISTING customer** — the only filing path is
  inside onboarding and the only caller of `runPortLanding` is the sweep over
  `OnboardingSubmission`, so an established tenant porting later has no
  submission and nothing tracks it. Both are structural; closing them means
  giving ports a home outside onboarding, which is **not started**.
  ⏳ **NOT PROVEN: no customer has received it.** Proven as 11 new builder tests
  + 5 caller tests (the landing actually queues it — a builder-only test passes
  straight through a wiring bug), the full onboarding suite 174/174, and the
  deployed container rendering the real email. **The next real port is the
  acceptance test**; Matamim's already completed, so it will not re-fire.
  ⏳ **Still unproven: the build-side dual-number path** (`pbxTenantBuild`'s
  "prepare BOTH numbers"). Matamim was hand-backfilled, so only a future
  SYSTEM-filed port exercises it.
- **Per-retirement leftover:** the temp number's old PBX inbound route stays
  (panel deletes have no captured contract) and counts **$3/mo E911** until
  deleted in the panel. First one: inii mini's "Main" 8452605692 on tenant 105.
- ⛔ Traps paid for: tenant EDIT form has NO `name` input and legacy tenants
  carry the PLAIN company description — identify a parsed tenant form by
  `tenant_id` + `inbound_numbers[0][did]`; a killed panel run (exit 137) can
  have LANDED its post — read the PBX DB before re-running (scripts are
  resume-guarded); blue/green api deploys run TWO Prisma pools and can
  transiently exhaust Postgres (max 100) — wait, don't "fix".
