# AGENT HANDOFF — the SignalWire onboarding, built end to end (2026-08-30)

Izzy, 2026-08-30: *"pretty much everything is changing to SignalWire. The whole
onboarding should be SignalWire. Everything that's voip.ms right now should be
SignalWire"* → mockups
(<https://claude.ai/code/artifact/1fd2575f-a7f5-424b-b5f6-2fd80f990ad2>) →
*"approved, start building exactly, exactly like the mock-ups dark and light."*

Commits, all on `feat/ivr-migration-takeover`:

| commit | chunk |
|---|---|
| `cd44c848` | 1 — number search + provisioning + PBX build (shared trunk) |
| `e9a0f39d` | 2 — 10DLC chain (brand → campaign → number order), schema + migration |
| `22b96a96` | 3 — SignalWire SMS ↔ chat (shared inbound ingest, provider-dispatched outbound, real voice notes) |
| `d90a84c0` | 4 — the wizard (desktop upgrades + the full mobile micro-step wizard) |
| `332e57d1` | 5 — the admin Port queue + LOA PDF + 10DLC board |

**Deploy state 2026-08-30:** api container-verified at `332e57d1` (migration
`20260830190000_signalwire_onboarding` applied — `TenantSmsRegistration` table
+ `SIGNALWIRE` enum value read back from the live DB; `SIGNALWIRE_TENDLC_SWEEP_ARMED`
boot line; shared ingest grepped in the container; health 200 both hostnames,
0 restarts). Worker + portal deploy state recorded at the end of the session
that shipped this (verify `app-worker-1` by grepping `signalWireChatSend` and
the portal by the `ob-tx-card` string in the shipped CSS).

## §0 — The switches (everything is INERT until these flip)

- `ONBOARDING_NUMBER_PROVIDER` — default `voipms`. `signalwire` makes NEW
  sign-ups search and stamp SignalWire. The per-submission
  `answers.phone.provider` stamp pins the carrier at selection time, so a
  resumed draft keeps its carrier and existing customers never move.
- `SIGNALWIRE_AUTO_PROVISION` — default dry-run. `on` lets provisioning spend
  money (purchase, E911, 10DLC filings).
- `SIGNALWIRE_PBX_SIP_ENDPOINT_ID` — optional pin for the PBX SIP endpoint;
  without it the resolver discovers it from the anchor number's own
  `relay_sip_endpoint` config (the live-proven +12053513327 →
  `d00d5c66-8c51-40fb-a61a-90fb02391828`).
- `SIGNALWIRE_TENDLC_SWEEP_DISABLED` / `_SWEEP_MS` / `_BOOT_DELAY_MS` — the
  registration sweep (boot kick beside the interval — the
  starved-setInterval rule).
- ⛔ Env-only flips have NO deploy path of their own — ride a real api commit
  (the `skip=unrelated_paths` trap).

## §1 — Search + provisioning (chunk 1)

`apps/api/src/onboarding/signalWireNumbers.ts`:
- Modes `areacode | starts | contains | ends`. ⛔ SignalWire's three pattern
  params are MUTUALLY EXCLUSIVE and take 3–7 DIGITS; a <3-digit pattern search
  refuses with `pattern_too_short` (the wizard renders its own plain-words
  empty state). A bare ≤3-digit query with no mode is treated as an area code.
- ⛔ Their API refuses LETTERS — `t9ToDigits()` translates server-side, and the
  wizard promises it ("type LOOP and we search 5667").
- `region` (2-letter state) + `city` (requires region) ride local searches only.
- The numbers route answers `provider: "signalwire"` so the wizard knows which
  search surface to draw. Errors keep the house contract: a provider failure is
  NEVER collapsed into an empty list.

`apps/api/src/onboarding/signalWireProvisioning.ts`
(dispatched from `voipMsProvisioning.applyOnboardingNumber` on the provider
stamp — the VoIP.ms path is untouched):
- **Purchase after payment only, never retried** — a timeout reconciles by
  re-listing owned numbers (`ensureNumberOnAccount` adopts an already-owned
  DID), because a duplicate purchase is real money.
- **Routing**: `updateNumberHandlers` → `call_handler: relay_sip_endpoint` +
  the PBX endpoint id + `message_handler: laml_webhooks` + the inbound-SMS
  webhook URL. One shared trunk (**132 "SignalWire loopcom-pbx"**, verified
  live in `ombu_trunks`) serves every SignalWire tenant — ⛔ no per-tenant
  trunk or subaccount; that is a VoIP.ms concept. `pbxTenantBuild` takes
  `numberProvider` and wires the tenant's outbound route to
  `[swTrunk, 0001-backup]`.
- **E911**: `createE911Address` with `autoCorrect: true` (their API corrects
  to the emergency-database town — the Monsey → Spring Valley class), then
  `assignE911Address`; the AS-REGISTERED address (from the response's
  snake_case raw) is recorded into `answers.provisioning.e911` in the same
  shape the VoIP.ms path writes, so the E911 email and timeline read it
  unchanged.
- **Ports**: a temp DID in the same area code + `answers.provisioning.portFiling
  { provider: "signalwire", status: "awaiting_manual_filing", portedDid,
  requestedAt }` — see §5.

## §2 — 10DLC (chunk 2)

`apps/api/src/signalwire/signalWireTenDlc.ts` + the registry section appended
to `signalWireClient.ts` (`/api/relay/rest/registry/beta/…`).

- **The chain**: `fileBrandForRegistration` (called by the wizard's
  texting-registration POST — the ONE call the EIN passes through) →
  `advanceSmsRegistration` walks brand approved → campaign filed → campaign
  approved → `createCampaignNumberOrder` → ACTIVE. Sweep-driven; the registry
  webhook (`/webhooks/signalwire/registry`, on the JWT bypass) is an untrusted
  TRIGGER that only looks rows up and kicks the sweep (30s throttle).
- **Classification** (the two-tier fork, Izzy's addition): `conversational`
  (LOW_VOLUME_MIXED, templated compliance answers) and `marketing` (the
  registry's own required fields — message flow + two ≥20-char samples —
  which is why the wizard's own-system branch collects them). `sole_prop` =
  the no-EIN path → `manual_class` refusal → a person files it (limited
  ~1,000/day class).
- **Activation enforces the cap**: `Tenant.dailySmsCap` set from the class
  (2000/2000/1000) — sending past a registered class is silent carrier
  filtering, so the platform refuses first. Activation also **upserts the
  `TenantSmsNumber` row** (provider SIGNALWIRE, tenant default, mmsCapable) —
  ⛔ that row is what routes inbound webhooks to a thread and flips outbound
  to SignalWire; there is no inventory sync to create it, activation is the
  creator. The upsert runs BEFORE the status flips to active so a failed write
  retries. The activation email is type `SMS_REGISTRATION_ACTIVE` — never
  ADMIN_ALERT (muted).
- ⛔⛔ **THE EIN HAS NO COLUMN AND MUST NEVER GROW ONE.** `TenantSmsRegistration`
  stores classification/identity/brand+campaign ids and states — a
  schema-reading guard test fails if an EIN-shaped column appears. The wizard
  half of the promise is §4.

## §3 — Chat wiring (chunk 3, `22b96a96`)

- **Inbound**: the whole VoIP.ms webhook ingest tail (canonicalise →
  TenantSmsNumber lookup → thread dedupe → participants → message → MMS mirror
  → routing log → pushes → CRM hook) was EXTRACTED into ONE
  `ingestInboundSmsToChat` inside `registerConnectChatRoutes`, registered via
  `apps/api/src/smsInboundIngest.ts`; the VoIP.ms webhook DELEGATES to it and
  the SignalWire inbound webhook calls it AFTER its signature gate. ⛔ The
  caller authenticates; the ingest does not. New: providerMessageId dedupe
  (fully prefixed `voipms:` / `signalwire:`) because carriers RETRY on
  non-2xx — and the SignalWire handler never 5xxes on an ingest throw for the
  same reason. The status webhook stamps `delivered`/`failed` (final states
  only) onto the outbound message by `signalwire:<sid>`.
- **Outbound**: `connectChatSmsJob` looks the number row up FIRST and
  dispatches on `provider === "SIGNALWIRE"` before any VoIP.ms concern (a
  SignalWire number must never fail `VOIPMS_NOT_CONFIGURED`, and its MMS
  capability is not the VoIP.ms `mmsCapable` sync flag).
  `apps/worker/src/signalWireChatSend.ts` loads the shared AgentSecret
  credentials (`signalwire_credentials`, column `valueEnc`) and sends through
  `SignalWireSmsProvider` (`packages/integrations/src/signalwireSms.ts` —
  Compatibility API, Basic auth, `MediaUrl` repeats up to 10, 1600-char body
  chunks, honors `SMS_PROVIDER_TEST_MODE`, ⛔ never retried). MMS failure falls
  back to signed links as SMS, mirroring the VoIP.ms direction.
- ⛔⛔ **Voice notes ship as their REAL audio file.** The VoIP.ms path must
  transcode audio to MP4 (their carrier surface refuses audio types);
  SignalWire accepts audio MIME directly, so the SignalWire path deliberately
  has NO `convertAudioAttachmentsForMms` — a source guard pins its absence.
  Removing the conversion IS the feature Izzy asked for.
- The VoIP.ms inbound POLL now filters `provider: "VOIPMS"` (a SignalWire
  number polled against getSMS can only ever answer no_sms).

## §4 — The wizard (chunk 4, `d90a84c0`)

Desktop (`apps/portal/app/onboarding/[token]/page.tsx` +
`textingStep.tsx`; CSS appended to `onboarding.css`, all on the wizard's own
token set + theme toggle):
- Number step: mode chips (Area code / Starts with / Contains / Ends with),
  letters accepted with the T9 hint, state+city filters and VOICE/SMS/MMS/FAX
  capability chips when `provider === "signalwire"`, "Ready now" retired there
  (spares are a VoIP.ms master-account concept).
- Port step: bill upload first; the **typed LOA signature** (`ob-sig`, dashed
  script box) is REQUIRED — `porting` is `z.unknown()` passthrough server-side
  so `loaSignature` persists in `answers.phone.details`. Timeline: temp number
  today → ~7 business days (toll-free up to two weeks) → switches by itself.
- Texting step: the toggle opens `TextingRegistrationCard` — identity fields,
  the EIN lock promise in writing, the two-tier fork, the hosted-vs-own fork
  (own-system opens the carriers' own questions + the collapsible "Why do we
  ask for this?" naming silent filtering), sole-prop path, pricing
  ($10/mo + $15 once + carrier fee included — pricing is a placeholder,
  Izzy's call), consent. Filing happens at Continue via
  `POST /onboarding/:token/texting-registration`.
- ⛔⛔ **The EIN lives in its own `useState`, OUTSIDE FormData** — and the
  autosave payload names its keys (company/contact/phone/extensions/addons),
  so neither the draft nor answers can ever carry it. `autoComplete="off"`.
  Guard tests in `apps/portal/lib/onboardingSignalWireWizard.test.ts` read the
  SOURCE and pin all of it.
- **Mobile** (`mobileWizard.tsx`): the same link measures the screen
  (`matchMedia("(max-width: 640px)")`, lazy initializer — never user agent);
  9 ring-numbered micro-screens (company → you → address → number choice →
  pick/port → people → texting fork → registration → review → pay), progress
  ring, 200ms glide behind prefers-reduced-motion, thumb-pinned CTA, 16px
  inputs (no iOS zoom-jump). ⛔ NO second state machine: it renders WITHIN the
  page's `step` state and drives the SAME side-effect closures
  (`fireApplyNumber` / `fileTextingRegistration` / `advance` / `handleSubmit`)
  — the quote/portability/auto-search/checkout effects are keyed on `step`
  and fire identically. A phone draft resumes on a computer and vice versa.

## §5 — The admin Port queue (chunk 5, `332e57d1`)

SignalWire has NO porting API; filing is a dashboard task with a signed LOA
dated ≤30 days. `/admin/onboarding/ports` (SUPER_ADMIN):
- `GET /admin/onboarding/port-queue` — every submission with a
  `answers.provisioning.portFiling` block (JSON filtered in JS over the recent
  300 — Prisma JSON-path filtering is the awkward half), awaiting first.
- `GET .../submissions/:id/loa.pdf` — the generated Letter of Authorization
  (pdfkit, `apps/api/src/onboarding/portQueue.ts`), proven by pdf-parse
  reading the rendered text back.
- `POST .../submissions/:id/port-filed` — record-only stamp (`status:
  "filed"`, filedAt, optional SignalWire order ref, filedBy). ⛔ A source
  guard pins that the route never touches a carrier.
- `GET /admin/onboarding/sms-registrations` — the 10DLC board; sole-prop rows
  flagged as the manual queue.
- ⛔ Download links carry `?token=` — a bare `<a>` sends no Authorization (the
  invoice-PDF pattern).
- ⛔ VoIP.ms-era ports (`portFiled`/`portId`, no portFiling block) deliberately
  do NOT appear here.

## §6 — Proven / not proven

Proven: 62 SignalWire api tests (search, provisioning incl. E911 + dispatch,
10DLC chain incl. EIN-nowhere sweeps, chat-wiring guards, port queue incl. a
parsed LOA) + 7 worker + 8 portal wizard guards; every replayed source guard
fails against HEAD; typechecks clean in every touched file (api total carries
other sessions' in-flight errors — 0 in mine); portal suite 402/404 (the two
documented pre-existing).

⏳ NOT PROVEN: no human has run a SignalWire sign-up; no real 10DLC filing has
happened; no SignalWire number has texted through chat; no port package has
been filed. Acceptance: one dry-run signup on the demo tenant end to end, then
one real one — and the negatives: a VoIP.ms tenant's texting byte-identical,
and the EIN in NO row, NO log, NO answers blob afterwards.

## §7 — Known gaps, honestly

1. **The SignalWire port-LANDING watchdog is NOT built.** A filed port
   completes at SignalWire and nothing lands it automatically — the VoIP.ms
   `runPortLanding` (routing, texting move, temp retirement) has no SignalWire
   arrival detector ("watch the number appear on the account", which IS
   detectable via listNumbers). First ports are manual cutovers; build the
   detector before porting at volume.
2. **Registration pricing is a placeholder** ($15 one-time shown; the real
   costs are a small registry fee per brand + a monthly per-campaign carrier
   fee billed 3 months up front by SignalWire) — Izzy's call, and the billing
   engine has no line item for it yet.
3. **Attestation**: outbound on SignalWire signs C until the vetting grant —
   hold the first real signup for it.
4. The stress-suite items from the artifact not yet built as tests: duplicate
   submit races on the texting step (the server upserts by submissionId, so a
   double-submit updates), hostile 50k-char registration input (zod caps at
   200/2000), and a full fake-carrier end-to-end signup drive.

## §9 — Scoped invite links: "just submit a port" / "just add extensions" (2026-08-31, `4dc33be5`)

Izzy: *"in the onboarding page, I should have an option to send somebody a link
just to submit a port or just to add an extension."* Built as a LINK PURPOSE,
not a second wizard.

**The mechanism.** `answers.linkKind` (`"full" | "port" | "extension"`, absent =
full) is stamped when the link is created — both creation paths carry it:
`POST /admin/onboarding/invitations` (`kind` in `createInvitationSchema`, the
invite email gets per-kind subject/title/CTA/blurb) and the public-links route
(`createPublicLinkSchema.kind`). The wizard reads it off `/validate`, which also
returns `submitted` so a returning visitor on an already-submitted scoped link
lands on the thank-you screen instead of a 409.

- ⛔⛔ **A scoped link can NEVER reach money.** `refuseWrongLinkKind(reply, row,
  "full")` gates **checkout, the full /submit, and /apply-number** — 409
  `wrong_link_kind` before `prepareOnboardingCheckout` / `applyOnboardingNumber`
  ever run. The test file's side-effect stubs THROW if those modules are
  reached, so the refusal tests double as no-side-effect proofs.
- ⛔⛔ **The autosave REPLACES `answers` wholesale, so the save route re-stamps
  `linkKind`** — without that, the first autosave on a scoped link silently
  turned it back into a full sign-up link. Behavior-tested.
- **`POST /onboarding/:token/submit-port`** validates the same fields the wizard
  does (cell ⇒ transfer PIN; typed LOA signature ≥3 chars), writes
  `answers.phone {choice:"port", details, provider}` **plus the SAME
  `answers.provisioning.portFiling {provider:"signalwire",
  status:"awaiting_manual_filing", portedDid, scopedLink:true}` block the full
  wizard writes** — which is why it appears in the admin **Port queue** with
  zero new queue code (`buildPortQueueRow` matches on the portFiling block).
  Status → SUBMITTED + `submittedAt`; a second submit hits the write-block.
- **`POST /onboarding/:token/submit-extensions`** (1–50 people) writes
  `OnboardingRequestedExtension` rows (deleteMany+createMany in a $transaction)
  + `answers.extensions` + SUBMITTED. Blank email stores as **null**. Appears in
  the ordinary submissions list.
- ⛔⛔ **THE PORT FIELDS ARE ONE IMPLEMENTATION NOW —
  `apps/portal/app/onboarding/[token]/scopedFlows.tsx`.** `PortDetailsSection`
  (the carrier/account/address/isMobile/uploads/typed-signature block) and
  `validatePortDetails` moved OUT of page.tsx; the full wizard's step-2 port
  branch renders/validates through them, and so does `PortOnlyFlow`. **Never
  reintroduce an inline copy in page.tsx** — the source guard
  (`lib/scopedOnboardingLinks.test.ts`) fails on `ob-porting-details` appearing
  there or the validation strings coming back.
- **`ExtensionOnlyFlow`** renders its own compact person cards (ob-mperson) — ⛔
  deliberately NOT the wizard's step-3 table, because the scoped flow has **no
  owner concept** (these people join an EXISTING account; the owner-email rule
  must NOT apply — pinned by a unit test).
- ⛔ **The scoped render branch sits BEFORE the `isPhone` branch** in page.tsx
  (source-guarded): a phone visitor on a scoped link gets the scoped card, never
  the full mobile micro-step wizard.
- **Admin card:** three-way chooser (Full sign-up / Transfer a number only /
  Add extensions only) in the invite card, `kind` passed to the POST and reset
  after; the "address already has a login" warning is suppressed on scoped kinds
  (an existing customer HAVING a login is the expected case).
- ✅ Proven: 10 api behavior tests (`scopedLinks.test.ts` — real Fastify +
  mock.module fake db; **all 10 fail replayed against HEAD's publicRoutes**) +
  10 portal tests (**all 5 source guards fail against HEAD's pages**); api
  typecheck 0 errors in touched files; portal typecheck 0; portal suite 421/423
  (the two documented pre-existing); onboarding suite's other failures are the
  pre-existing setupOrchestrator `resolvePbxRouteHelperConfig` class +
  `pbxTenantBuild` "job validation" (fails at full HEAD too — not this work).
- ⏳ **NOT PROVEN: no scoped link has been created or submitted by a human.**
  Acceptance: admin page → "Transfer a number only" → open the link (a short
  port card, no steps, no payment) → submit → the package appears in
  /admin/onboarding/ports; negative: hitting the checkout URL on that token
  answers 409 `wrong_link_kind`.
