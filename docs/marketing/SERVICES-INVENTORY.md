# LOOPCOM — WHAT WE ACTUALLY OFFER

> **Draft — under review.** Not approved copy. See `README.md` in this folder.

Derived from the codebase on branch `feature/loopcom-rebrand`, August 2026.
Every line below is backed by a file in the repo. Nothing here is aspirational.

**Read the last section before writing any marketing copy.**

---

# PART 1 — SHIPPED AND WORKING

## 1. Cloud phone system

Built on a self-hosted Asterisk/VitalPBX stack, controlled through three
layers (REST, AMI, ARI) — this is not a Twilio reseller wrapper.

**Calling**
- Softphone in the browser, no install — WebRTC over SIP/WSS
- Softphone in the mobile app, with native incoming-call UI on Android
- Desktop app with a background phone engine and tray, so calls ring even
  when the window is closed
- Multi-call handling: hold, resume, swap between calls
- Blind transfer, DTMF, click-to-call
- Push-wake handshake so a sleeping phone still rings

**Inbound routing**
- Full IVR / auto-attendant — menus, options, prompts, preview before
  publish, publish history and one-click rollback
- Business-hours, after-hours and holiday routing on a schedule
- Manual override for emergency closures
- DID-to-destination mapping and assignment
- Call queues
- Ring-group destinations

**Voicemail**
- Full mailbox: list, play, download, folders, mark read, delete
- Greeting upload, or record your greeting by phone
- Separate greeting slots: unavailable, busy, temporary, name
- Missed-call records and push notifications

**Audio**
- Music on hold with scheduling and per-extension overrides
- System recordings and announcements, uploaded per tenant and pushed
  to the PBX

**Visibility**
- Live active-call monitoring with real-time updates
- Call history and CDR
- Call reports, call-quality reports, queue reports
- Dashboard KPIs, call traffic, IVR analytics
- Deep WebRTC diagnostics: ICE-candidate tracking, TURN probing,
  SDP diagnostics, incident and outage detection

**Provisioning**
- Extension provisioning with QR-code device pairing
- Call recording playback (recording happens PBX-side)

## 2. CRM

Roughly 45 database models. This is a full product in its own right and is
almost entirely absent from current marketing.

- Contacts with normalized phones, emails, addresses and relational tags
- Campaigns and campaign membership
- Full email suite: templates with attachments, branding, signatures,
  threads, bulk email with scheduling, and inbox sync
- Forms: templates, fields, tokenized public links, submissions
- Checklists and checklist responses
- Call scripts
- Tasks and notes per contact
- An append-only customer timeline covering calls, SMS, email, voicemail
  drops, form submissions, website submissions, notes, tasks, stage
  changes and assignment
- Bulk import with batch tracking, row-level status and pipeline runs
- Lead documents with text extraction
- Voicemail drops — drop a prerecorded message straight into a mailbox
- Caller-ID pool with local-presence suggestion
- Live-call cockpit with inbound caller enrichment and screen-pop
- Website submission capture with email routing rules
- Wallboard and reports

## 3. Messaging

**SMS / MMS** (via VoIP.ms)
- Send and receive, threaded
- MMS with media, including automatic audio conversion and a signed-link
  fallback when a carrier rejects the attachment
- Automatic message segmentation
- Shared or personal inbox modes per number
- SMS templates
- Bulk SMS campaigns with risk scoring and an approval gate
- 10DLC registration workflow

**Team chat**
- Direct messages, group threads, and a tenant-wide default channel
- Reactions, read receipts, typing indicators, unread counts
- File and media sharing with cached metadata
- Edit and delete, per-user or for everyone
- Reply threading
- Push notification on new messages

## 4. AI

- **Lead intelligence** — OpenAI `gpt-4o-mini` generates a summary, business
  overview, entity extraction, risk flags and a confidence score for a
  contact or a whole import batch. Tenant switch defaults ON.
- **AI email writing** — drafts and rewrites email templates.
- **Call transcription and analysis** — Google Cloud Speech-to-Text on call
  recordings, then Vertex AI for summary, action items, sentiment and
  intent. Wired into the live call-record ingest path.
  *(See Part 2 — needs configuration.)*

## 5. Billing and payments

Payment processing through Sola / Cardknox, with card capture via hosted
iFields so card numbers never touch our servers.

- Invoice generation with a mature engine and full test coverage
- Branded invoice PDFs
- Plan catalog with per-extension, per-DID and per-SMS pricing
- Usage metering — billable extensions, local vs toll-free DIDs
- Subscriptions with past-due handling and retry logic
- Autopay and scheduled billing runs
- Dunning and collections
- Tax profiles and telecom-fee handling
- Lifecycle emails and receipts
- Aging, failed-payment and transaction reports with CSV export
- Hosted single-invoice payment page for customers
- A kill switch that halts all live charging via one environment variable

## 6. Delivery tracking — REAL CORE, STUBBED EDGES

The domain logic is genuinely built: orders, runs, run stops, drivers and
driver profiles, zones, stores, packages, proof of delivery, ETA snapshots,
exceptions, status events, customer tracking tokens, SMS consent with STOP
handling, a dispatch map, role-based access and an audit trail.

**But four edges are stubs, so it cannot run a real delivery operation yet:**
- Order ingest uses a **mock adapter** — the supermarket's ordering API was
  never supplied
- Route/ETA calculation is **straight-line distance**, not real routing
- Geocoding is a **no-op** unless a provider is configured
- Customer SMS is **off** by default and needs separate approval to go live
- The delivery voice IVR resolves correctly but **nothing on the PBX calls
  it**

Treat this as a working pilot skeleton, not a sellable product.

## 7. Administration

- 21 admin areas in the portal
- Tenant provisioning and management
- Full user lifecycle: invite, activate, disable, role assignment
- Custom roles with fine-grained permission keys
- Phone number management
- Operator-driven onboarding: tokenized customer form with autosave, bill
  upload and card capture, plus an operator queue with status workflow
- Ops centre, deploy centre, server health, storage health
- Incident tracking and outage detection
- CDR tenant mapping, call flight and call-timeline diagnostics

## 8. Platform

- Multi-tenant with per-tenant isolation on every model
- Role-based access with custom roles
- Web portal (149 pages), Android app, desktop app
- QR-code device provisioning

---

# PART 2 — BUILT, NOT YET SWITCHED ON

Real code that needs configuration or a final wiring step. Safe to describe
as "coming", not as available today.

| Capability | What is missing |
|---|---|
| **CRM call transcription + AI call analysis** | Code complete and wired. Needs a Google Cloud bucket, project and Vertex model set in the environment, plus the tenant flag turned on. |
| **Document OCR** for lead documents | Complete (Tesseract). Disabled by env flag. English only. |
| **Self-serve number purchase** | API complete, including search, purchase and release. No screen in the portal calls it. |
| **iOS app** | JavaScript layer, VoIP push and CallKit wiring are done. No native iOS project has ever been committed; blocked on Apple credentials and a first build. |
| **Multi-invoice pay links** | Complete and unit-tested. Routes were never registered and the database model is missing from the schema. |
| **Chat "mark as unread"** | Database migration only. No API, no UI. |
| **Voicemail shared notes + callback reminders** | Database migration only. Notes in the UI today are browser-local, not shared. |
| **Ring group / trunk / route editors** | Read-only. The admin screens for these render but cannot save. |
| **Attended transfer, conference creation, supervisor whisper/barge** | Not implemented — the underlying calls throw. |
| **Queue callback and announce-position** | Not implemented. |
| **XLSX import** for CRM | CSV works; the XLSX branch is gated off. |
| **Gmail OAuth** | Placeholder in the UI. |
| **Signed/flattened PDF from CRM forms** | Submissions capture data; PDF generation is pending. |

---

# PART 3 — CORRECTIONS TO CURRENT MARKETING

These claims appear in the brochures, the status cards and the ad script.
**They are not supported by the codebase.** Fix before distributing.

### 1. WhatsApp Business — NOT a working channel
Outbound sending is simulated in every configuration. The endpoint writes a
database row, generates a fake message ID and returns; there is no queue
consumer, and no WhatsApp API client exists in the repo. Templates, session
windows, media, opt-out and usage billing are unreferenced schema.

Inbound webhook capture *does* work with proper signature verification, and
projection into the chat inbox exists behind a flag that defaults off.

*Safe to say:* nothing yet.
*Not safe to say:* "we handle your WhatsApp."
*Unaffected:* using WhatsApp as our own contact number is entirely fine.

### 2. Yiddish voicemail and call transcription — NOT in the product
The Yiddish work is real and well-designed — a Yiddish Labs translation
bridge, an ivrit.ai fallback, a dialect glossary, a language judge. All of
it lives in `apps/agent/`, which contains **two of roughly forty-five
files**. It imports about forty modules that do not exist, references six
database tables that are not in the schema, and writes voicemail columns
that were never created. It cannot compile.

The portal and mobile apps both render an "AI transcript" panel. In
production that field is never populated — only local mock data fills it.

**Open question for the team:** `apps/agent` is committed to `main` with the
same two files. If the full service runs on a server or in another repo,
this assessment changes. Confirm before deciding.

### 3. "An assistant that does everything" — NOT implemented
No auto-reply, no AI call answering, no agent tools or function-calling —
a repo-wide search for tool-calling returns nothing. The conversational
assistant UI is complete, polished, and never mounted anywhere in the app.

What *is* real AI: lead intelligence, AI email writing, and call
transcription with sentiment and intent.

### 4. "Customizable voice recordings with multiple voices" — NOT supported
There is no text-to-speech anywhere in the product. Greetings and IVR
prompts are uploaded audio files, or recorded by calling in from your phone.
The only "voices" concept is Asterisk's fixed greeting slots. A delivery
setting offers a TTS option that nothing consumes.

*Safe to say:* upload your own recordings, or record them by phone.

### 5. Things that ARE true and are being undersold
- **"We build everything and anything phone-related"** — well supported.
  The PBX, IVR, routing, softphone and diagnostics work is deep and real.
- **Invoicing and payments** were removed from marketing scope. That
  decision is worth revisiting; the billing engine is one of the most
  mature parts of the platform.
- **The CRM barely appears in any material** despite being roughly a third
  of the product.

---

# PART 4 — OPERATIONAL RISKS

Not marketing issues, but they affect what we can promise.

1. **SMS is in test mode by default.** `SMS_PROVIDER_TEST_MODE` defaults to
   `true` in all four places it is read. Unless production sets it to
   `false` explicitly, SMS does not leave the building.
2. **No STOP/opt-out handling on the main SMS inbox.** It exists only in the
   delivery module. 10DLC opt-in text is collected at registration but never
   enforced at send time. This is a compliance exposure.
3. **Schema drift.** Five migrations are untracked in git and add columns
   that the Prisma schema does not declare. The next `prisma migrate` will
   report drift. Two of them may already be applied to production.
4. **Audit logging is thin.** The audit table has a good shape but around
   five write calls, and none in billing. Billing has its own parallel
   event log, so history is not lost — but do not claim "full audit
   logging" to a compliance-minded buyer.
5. **Role separation is weaker than it looks.** Eleven roles collapse into
   three permission buckets. `READ_ONLY`, `SUPPORT` and `MANAGER` carry no
   distinct rights — `SUPPORT` gets full tenant-admin.
6. **Four admin screens cannot save.** Trunks, routes and ring groups render
   as normal admin pages but their underlying calls throw.
7. **Most modules ship switched OFF per tenant.** CRM, delivery tracking and
   WebRTC calling all default to disabled, and new tenants are created
   unapproved with SMS in test mode. That is sensible engineering, but it
   means "we offer X" is only true after an operator enables X for that
   customer. Onboarding is operator-driven, not self-serve.
8. **Team chat has no live transport.** The chat UI polls. The realtime
   service is a 34-line echo server with no fan-out, so "real-time" is a
   claim to avoid.
9. **PBX config writes are blocked by default.** Any write to PBX
   configuration throws unless an environment variable explicitly permits
   it — worth knowing before promising self-service changes.
10. **Security: `JWT_SECRET` falls back to the literal string `change-me`**
    if unset, in both the API and the realtime service, along with three
    other token secrets. Verify production sets these. This is unrelated to
    marketing but is the most serious single finding in the audit.
