# ⛔⛔ AGENT HANDOFF — SIGNALWIRE ONBOARDING IS BUILT END TO END and INERT until two env flips (2026-08-30) — READ FIRST before touching the wizard, signalWireProvisioning/TenDlc, the chat SMS paths, the EIN handling, or before flipping ONBOARDING_NUMBER_PROVIDER

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(Commits `cd44c848` → `e9a0f39d` → `22b96a96` → `d90a84c0` → `332e57d1` on
`feat/ivr-migration-takeover`, built to the approved mockups
<https://claude.ai/code/artifact/1fd2575f-a7f5-424b-b5f6-2fd80f990ad2>
("approved, start building exactly, exactly like the mock-ups dark and light").
✅ **FULL STACK DEPLOYED AND CONTAINER-VERIFIED 2026-08-30**: api at
`e5066c27` (migration `20260830190000_signalwire_onboarding` applied — the
`TenantSmsRegistration` table + `SIGNALWIRE` enum value read back from the
live DB; `SIGNALWIRE_TENDLC_SWEEP_ARMED` boot line; the shared ingest, the
registry webhook and the texting opt-out guard all grepped in the container),
worker at `74426643` (SignalWire dispatch + `provider:"VOIPMS"` poll filter +
`signalWireChatSend.ts` present; the VoIP.ms inbound poll verified still
running after the deploy), portal at `2e5e34d2` (`ob-tx-card` in the shipped
CSS, the texting-registration and Port-queue strings in the shipped chunks).
0 restarts and 0 error-level lines on all three; health 200 both hostnames.)

- ⛔⛔ **EVERYTHING IS INERT ON DEPLOY.** `ONBOARDING_NUMBER_PROVIDER` defaults
  `voipms` (the whole wizard keeps its VoIP.ms behavior byte-compatibly) and
  `SIGNALWIRE_AUTO_PROVISION` defaults dry-run. Flipping the first makes new
  sign-ups search/stamp SignalWire; the second lets provisioning spend money.
  **Existing customers stay on VoIP.ms untouched — the per-submission
  `answers.phone.provider` stamp pins the carrier at selection time.**
- **The five chunks, so nobody re-derives the map:**
  **(1) Search + provisioning** (`onboarding/signalWireNumbers.ts` +
  `signalWireProvisioning.ts`): all four modes (areacode/starts/contains/ends —
  the three patterns are MUTUALLY EXCLUSIVE at SignalWire, 3–7 digits;
  T9-translation server-side because their API refuses letters), region/city,
  purchase-after-payment (never retried; a timeout reconciles by re-listing),
  E911 create+assign with `auto_correct_address`, routing to the proven
  `loopcom-pbx` SIP endpoint (env pin `SIGNALWIRE_PBX_SIP_ENDPOINT_ID`, else
  discovered from the anchor number's own config) + `laml_webhooks` message
  handler; ports get a temp DID + `answers.provisioning.portFiling
  {status:"awaiting_manual_filing"}` (**SignalWire has NO porting API**).
  PBX build rides the SHARED trunk 132 "SignalWire loopcom-pbx" — no
  per-tenant trunk/subaccount (a VoIP.ms concept).
  **(2) 10DLC** (`signalwire/signalWireTenDlc.ts`): brand → campaign →
  number-order chain, sweep-driven (`SIGNALWIRE_TENDLC_SWEEP_*`, boot kick
  beside the interval) + registry status webhook
  (`/webhooks/signalwire/registry`, an untrusted TRIGGER that only kicks the
  sweep). Classification decides the campaign class and the cap —
  conversational LOW_VOLUME_MIXED 2000/day, marketing 2000, sole_prop 1000 —
  and activation ENFORCES it on `Tenant.dailySmsCap`, upserts the
  `TenantSmsNumber` row (provider SIGNALWIRE, tenant default — what wires the
  number into chat), and emails the customer (`SMS_REGISTRATION_ACTIVE`, never
  ADMIN_ALERT).
  ⛔⛔ **THE EIN IS PASS-THROUGH AND HAS NO COLUMN**: browser → ONE endpoint
  (`POST /onboarding/:token/texting-registration`) → create-brand in the same
  request; never in answers, never autosaved, never logged — schema-reading
  guard tests pin that `TenantSmsRegistration` has no EIN column and the
  wizard's autosave payload cannot carry it. **Never "improve" this into
  encrypt-and-hold.**
  **(3) Chat wiring** (`22b96a96`): ONE shared inbound ingest
  (`smsInboundIngest.ts` registry + the extracted `ingestInboundSmsToChat` in
  `connectChatRoutes.ts` — the VoIP.ms webhook DELEGATES to it; providerMessageId
  dedupe because carriers RETRY on non-2xx); the SignalWire inbound webhook
  routes verified messages into it AFTER its signature gate; the status webhook
  stamps delivered/failed onto the message. Outbound: `connectChatSmsJob`
  dispatches on `TenantSmsNumber.provider === "SIGNALWIRE"` BEFORE any VoIP.ms
  concern → `SignalWireSmsProvider` (packages/integrations, Compatibility API,
  10 media/message, never retried) — ⛔ **voice notes ship as their REAL audio
  file; removing the MP4 conversion IS the feature** (source-guarded). The
  VoIP.ms poll now filters `provider: "VOIPMS"`.
  **(4) The wizard** (`d90a84c0`, desktop + full mobile): mode chips + letters +
  state/city + capability chips (no "Ready now" on SignalWire), typed LOA
  signature (required for ports; `porting` is a zod passthrough so it persists),
  the full texting-registration card (two-tier fork, hosted-vs-own fork with the
  carriers' own sample questions, collapsible "Why do we ask for this?",
  sole-prop "I don't have an EIN" path, pricing, consent; files at Continue),
  review rows; and the MOBILE micro-step wizard — matchMedia ≤640px (never user
  agent), 9 ring-numbered screens over the SAME step machine and side-effect
  closures (`fireApplyNumber`/`fileTextingRegistration`/`advance` — ⛔ never a
  second implementation).
  **(5) Admin Port queue** (`332e57d1`, `/admin/onboarding/ports`): ready-to-file
  packages, a GENERATED LOA PDF (pdf-parse-proven), record-only "Mark filed"
  (source guard: the route never touches a carrier), and the 10DLC registration
  board incl. the sole-prop manual queue. Downloads carry `?token=` (a bare
  `<a>` sends no Authorization).
- ✅ **SCOPED INVITE LINKS (2026-08-31, `4dc33be5` — handoff §9): the admin
  invite card can send a link for ONE job** — "Transfer a number only" or
  "Add extensions only" — stamped as `answers.linkKind` and read off
  `/validate`. ⛔ **A scoped link can NEVER reach money**: checkout, the full
  /submit and /apply-number all answer 409 `wrong_link_kind` before any side
  effect (test stubs THROW if provisioning is reached). ⛔ **The save route
  re-stamps `linkKind`** — autosave replaces `answers` wholesale, and without
  the re-stamp the first autosave silently turned a scoped link back into a
  full one. A scoped port writes the SAME `portFiling` block, so it lands in
  the Port queue with zero new queue code; a scoped extension request writes
  `OnboardingRequestedExtension` rows at SUBMITTED. ⛔ **The port fields +
  validation live ONCE, in `scopedFlows.tsx`** (`PortDetailsSection` /
  `validatePortDetails`) — the full wizard's step 2 renders the same section;
  never reintroduce an inline copy in page.tsx (source-guarded), and the
  scoped render branch must stay BEFORE the `isPhone` branch. The scoped
  extension editor deliberately has NO owner-email rule (these people join an
  EXISTING account). ⏳ NOT PROVEN: no scoped link has been sent to a human.
- ✅ **Proven:** 62 SignalWire api tests + 7 worker + 8 portal wizard guards, all
  registered/globbed; **all replayed source guards fail against HEAD**; api/worker
  typechecks clean in every touched file; portal typecheck 0, suite 402/404 (the
  two documented pre-existing).
- ⏳ **KNOWN GAP, deliberately not half-built: the SignalWire PORT-LANDING
  watchdog.** A filed port completes at SignalWire and nothing lands it — the
  VoIP.ms `runPortLanding` machinery (routing, texting move, temp retirement) has
  no SignalWire arrival detector yet ("watch the number appear on the account").
  First ports are manual cutovers; build the detector before porting at volume.
- ⏳ **Go-live checklist (Izzy's):** hold the first signup for the attestation-A
  grant (outbound signs C until SignalWire grants it); flip
  `ONBOARDING_NUMBER_PROVIDER=signalwire` + `SIGNALWIRE_AUTO_PROVISION=on` (env
  edits must ride a real api commit — the skip=unrelated_paths trap); one full
  dry-run signup on the demo tenant; registration pricing (mockup shows $15
  one-time, monthly fee absorbed — his call).
- ⏳ **NOT PROVEN: no human has run a SignalWire sign-up, no real 10DLC filing has
  happened, no SignalWire number has texted through chat.** Acceptance: one
  end-to-end dry-run signup, then one real one — search with letters, port with a
  typed signature, texting registration with a real EIN, and the negatives: a
  VoIP.ms tenant's texting must be byte-identical, and the EIN must appear in NO
  row, NO log and NO answers blob afterwards.
