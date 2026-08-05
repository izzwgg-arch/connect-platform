# AGENT HANDOFF — Onboarding end-to-end payment proof, owner/journey/report features, auto-ban fix (2026-08-04 → 08-05)

Session: the all-day onboarding-readiness engagement (audit → real-card proof →
feature build-out → A-to-Z hardening). Written for the next agent touching the
sign-up wizard, the public pay page, journey tracking, the sign-up report
emails, the nginx auto-ban, or ElevenLabs "Make One".

Related handoffs (do not duplicate): the IVR Studio 2026-08-04 handoff (wizard
checkout design, ElevenLabs key/slug facts), "one tenant per paid sign-up",
"stranded paid sign-up watchdog", "onboarding round 2 deploy". This doc covers
what those don't.

## 1. The wizard's payment hole — found, fixed, PROVEN with a real card

- **Found by walking the wizard as a customer**: "Continue to payment" on the
  review step submitted and jumped straight to /success — payment step 6 was
  unreachable, AND `POST /submit` kicked provisioning with no paidAt gate.
  A real unpaid test run created a real VoIP.ms subaccount and filed a real
  `addLNPPort`. Fixes: `eb728430` (submit → setStep(6); paidAt gate on the
  submit kick; /checkout admits SUBMITTED — the general write-block would 409
  the exact moment payment is due).
- **Dead code bites in layers.** Because checkout had never run, three more
  crashes hid behind it, each found only when the previous one was fixed:
  invoice `issuedAt/dueAt` → the schema's `issueDate/dueDate` (`731517c2`);
  line items REQUIRE `tenantId` + a `BillingLineItemType` enum value
  (`3f12f09b` — quote keys map extensions→EXTENSION, e911→E911_FEE,
  sms→SMS_PACKAGE, additional_numbers→PHONE_NUMBER, telecom_fees→REGULATORY_FEE);
  and `finalizeOnboardingInvoicePaid` wrote event type `"PAID"` which is NOT in
  `OnboardingEventType` — **money collected, submission never marked paid,
  build never started** (`aa3a8861`). ⛔ Never invent an event/enum value —
  grep the Prisma enum first; this class of bug struck twice in one day.
- **Declined cards were unretryable** (`957eb5c6`): the BillingChargeOperation
  businessKey (tenant+invoice+amount+new_card) replayed the old DECLINE on
  every retry — retries never reached the gateway; the customer saw the generic
  contact-support text forever. The public pay route now passes
  `allowRetry: true` on both branches. Semantics preserved: APPROVED still
  replays (no double-charge), PENDING still 409s (charge_in_progress).
  **Izzy's rule: a customer may retry a declined card forever.**
- **Proven live 2026-08-04 ~13:00 ET with Izzy's real card**: declined once
  ("Do not honor"), retried, APPROVED $33.00 → number routed → PBX tenant
  built → owner promoted → invite SENT → wiped afterward with the two-step
  panel protocol (single-tenant variant of `scripts/onboarding/_wipe-round2.mts`;
  payment records deleted with the checkout tenant per Izzy — money kept, no
  refund).

## 2. Owner feature (`a3daef93`)

First extension = account owner. Wizard: Owner radio column (defaults to row 1,
movable; removing the owner row falls back to the first row; owner MUST have an
email — validated client-side with a plain-English message). Submit stamps
`answers.ownerExtNumber`; the orchestrator promotes that extension's user to
**TENANT_ADMIN** after the verify/repair pass (never demotes; never touches a
user belonging to another tenant — that case logs a manual-assignment event).
Before this, EVERY onboarding-created user was role USER and a fresh account
had no admin at all — nobody could even open IVR Studio. TENANT_ADMIN resolves
all IVR keys via `DEFAULT_ROLE_PERMISSIONS` (verified with tsx against
packages/shared/src/portalPermissions.ts).

## 3. Owner emails + journey tracking (the "know everything" layer)

All to `ADMIN_ALERT_EMAIL` (default tod10950@gmail.com), riding the ADMIN_ALERT
EmailJob channel (tenantId `connect-admin-tenant-v1`):

- **Link-open email** — first open of any sign-up link (test-spawned runs are
  tagged "(test)"). `journeyTracking.ts:recordLinkOpened`, called from
  GET /validate; repeat visits log a timeline event, throttled to one per
  10 min; templates never fire it.
- **Sign-up report** — one per pipeline-terminal outcome (done OR failed),
  `adminSignupReport.ts`, fired from the orchestrator's success line and its
  catch. Plain English by contract (Izzy reads these): company/contact/address,
  porting details incl. which documents to chase, team with owner marked,
  money incl. autopay-on, verdict, and a cleaned play-by-play (strips
  `(id …)`/`(path …)`) of the last 40 non-AUTOSAVED events. The orchestrator
  stress test asserts EXACTLY one report per run — `inviteJobs()`/`reportJobs()`
  helpers in setupOrchestrator.test.ts keep invite-count assertions honest.
- **Journey beacons** — `POST /onboarding/:token/track` (public, template-
  refusing, capped at 600 events/submission): step reached with seconds on the
  previous step, went BACK, the EXACT validation message that blocked them,
  number searches with result counts, portability results. Server-side events
  cover the money stages: "Handed to the payment page — $X due", "Payment page
  FAILED to open: …", "Card DECLINED (reason) — they can retry" (from
  publicPayRoutes for onboarding invoices). Everything is STATUS_CHANGED with
  a distinctive message ON PURPOSE — see the enum lesson above.

## 4. The nginx auto-ban ate a customer mid-wizard (Matamim)

- Real customer (Matamim, porting a Verizon number, link
  `Ic6_itPJ…`) reported "the link stopped working". Truth: their office IP got
  a 60-minute 403 ban from `/opt/connectcomms/scripts/monitor.sh` — its rule
  is **>30 responses with status 401 in 5 min** (also 404>60, etc.; TTL 60 min;
  bans land in `/etc/nginx/connectcomms/denylist.conf`; unblock script
  `/opt/connectcomms/scripts/unblock_ip.sh`).
- Root cause was OUR bug: the root portal layout mounts the SIP phone engine on
  EVERY page (including public wizard/pay/login), and `useSipPhone`'s 401
  handler retried `init()` every 2.5 s FOREVER — a signed-out wizard tab
  crossed the ban line in ~75 s. Fixed `cdb88fdf`: `hasBrowserAuthToken()`
  gate in apiClient (no token → the engine makes ZERO authed calls) +
  exponential backoff (2.5 s → 60 s cap) on 401 retries.
- Matamim's office `209.204.124.23` is allowlisted
  (`/etc/nginx/connectcomms/allowlist.conf`, backup taken, nginx reloaded).
- ⛔ Sign-up links NEVER expire by design (no TTL exists in code) — one link =
  one submission = one account; write-block starts only at SUBMITTED. If a
  customer says "the link stopped working", check the ban list and nginx logs
  BEFORE touching link logic.
- Izzy has a standing offer on the table (not yet built): smarter ban rules —
  don't count public-page 401s, never ban an IP with heavy successful authed
  traffic, email on every ban.

## 5. Audit round 1 (`a34dc379`) — the everyone-hits-it fixes

Two very-thorough subagent audits (~30 findings) drove chips; these shipped
from this session directly:

- **Resume never resumed**: `currentStep` is a STRING column (autosave
  coerces); validate's `typeof === "number"` check answered 0 for everyone —
  every refresh restarted at step 1 with answers intact. Now `Number(...)`.
- **Paid-but-never-marked self-heal**: /progress detects a PAID invoice on an
  unpaid submission and re-runs finalize + pipeline (customer's own polling is
  the retry loop).
- **retry-setup gate** matched non-existent enum values ("APPROVED",
  "PROVISIONING") and 409'd the real recovery states; now paid + not-done.
- **E911 address and `language` were silently STRIPPED by publicSubmitSchema**
  (zod drops unknown keys) — address survived only via autosave luck; the
  Yiddish flag was dead code. Both added to the schema; address persisted into
  answers at submit.
- Checkout errors rendered raw codes (`e?.payload` never existed on ApiError —
  it's `.body`); LOA+bill back-to-back uploads lost the first filename (stale
  closure — functional setForm now); number-search failure copy promised an
  assignment that can't happen (validateStep hard-blocks) — honest copy +
  Search disabled while a 20 s search runs.
- **AuthGate dropped the query string on login redirect** — `?firstrun=1` was
  lost, so the IVR first-run walkthrough NEVER opened via the success-page CTA
  (the primary path). One line: pathname + window.location.search.

## 6. ElevenLabs "Make One" speedups (this session's half; see also the
   ElevenLabs handoffs for playback/hardening)

- `/voice/elevenlabs/status` now returns the **voice list too** (Promise.all
  server-side; `voices: null` = client falls back to /voices) — the modal used
  to make two strictly sequential round-trips before rendering anything.
  MakeRecording consumes it with a fallback; a timeout now says "taking too
  long" instead of masquerading as "No voices on this account yet."
- **Preview→save reuse**: preview PCM is cached 10 min keyed by
  sha256(voiceId|text|model|tuning), max 40 entries; `/voice/ivr/prompts/generate`
  reuses it — "Use this recording" no longer synthesises a SECOND time (was
  full provider latency again + double character spend; also means the
  customer gets the exact take they approved).
- The generate route's PBX push now resolves the helper **for the tenant's
  pbxInstanceId** (was called with no args → silent global-helper fallback).

## 7. First-login setup nudge

`apps/portal/components/OnboardingSetupNudge.tsx` (mounted in AppShell) +
`GET /me/onboarding-setup-state` (server decides: TENANT_ADMIN/ADMIN of an
ACTIVE onboarding-created tenant with ZERO IvrRouteProfile rows). Connect-themed
dark+light (`:root[data-theme="light"]` overrides). Once a menu exists the
server answers show:false forever; a dismissal is per-browser localStorage.

## 8. Pricing ($35 floor) — origin

`29fa1af3` added the flat $2/account "Telecom & regulatory fees" line
(REGULATORY_FEE): 1 ext + 1 number = $30 + $3 + $2 = **$35 exactly, never
less** (Izzy's arithmetic: the $30 is $25+tax). Literal-assertion tests in
packages/shared/src/onboardingPricing.test.ts. Month-2 parity was a separate
chip (see the month-2/watchdog handoffs and the onboarding memory file).
Toll-free/vanity ($15/mo, vanity is toll-free-only at VoIP.ms) was specced as
chip task_9c421379 — check its branch state before re-implementing.

## 9. Live-state at handoff

- **Customer links** (single-use, non-expiring):
  link 1 `9lHaW-J2N9fxuGaF3m8cE1ETIdBl_UbW` unused;
  link 2 `Ic6_itPJSSDs4pqZhbqxmxembhYMlcG6` = **Matamim**, mid-wizard at the
  number step, porting a Verizon number — expect their return; their office IP
  is allowlisted. Izzy gets emails at open + finish automatically.
- The reusable stress link spawns fresh runs; test rows from this session are
  CANCELED. The $33 proof tenant/invoice/subaccounts are fully wiped.
- Deploy note: this session's deploys ran through the deploy queue, serialized
  by a server-side sequencer script when parallel sessions collided on the
  heavy-job lock / candidate port 3004 (two failed rollouts were exactly that
  collision — live api was never affected; blue/green held).
