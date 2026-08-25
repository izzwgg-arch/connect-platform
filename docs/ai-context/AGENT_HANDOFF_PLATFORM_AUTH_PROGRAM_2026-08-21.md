# AGENT HANDOFF — the platform-auth program: Google / Meta (FB+IG+WhatsApp) / Microsoft-Outlook / TikTok (2026-08-21)

**RESEARCH ONLY — no code written, no account created, no application filed.**
Izzy, 2026-08-21: *"I want the CRM people to be able to log in to all their
socials and Outlook, and then I want to start doing login/sign up with Google …
For WhatsApp, people are setting up their WhatsApp if we can. For anything I
need, I want to be verified."* He chose **"start the paperwork"**.

⛔ **Read §0 before quoting anything below** — several load-bearing numbers are
secondary-sourced and are flagged as such. Do not launder them into facts.

## 0. THE THREE THINGS THAT OUTRANK EVERYTHING

1. ⛔⛔ **THE NAME SPELLING IS A SYSTEMIC RISK, NOT A D-U-N-S DETAIL.** Three
   separate verifications check the entity name against official records and
   **all three demand an exact match**: D&B ("multiple trade names" is a
   manual-review trigger), Meta (documents must show name+address+phone
   matching the Business Portfolio **character-for-character**), and Microsoft
   (*"business name and address match official registration records exactly,
   without spelling errors or abbreviations"* — and it cross-checks the
   **domain registrar / WHOIS record** too). Loopcom currently has **three
   spellings in circulation**: `LoopCom, LLC` (USAC 499-A), `loopcom llc.`
   (FCC FRN 0038803722), `Loopcom` (brand). ⏳ **Nobody has confirmed what is
   on the actual LLC certificate or the loopcom.net WHOIS.** That single fact
   gates Meta, Microsoft, Apple and Google verification. Settle it first.
2. ⛔⛔ **EMBEDDED SIGNUP v2 IS DEPRECATED 15 OCTOBER 2026** — about eight weeks
   from this handoff. Any WhatsApp customer-onboarding build must target **v4**.
   Following a v2 tutorial buys a rewrite inside the year.
3. ⛔ **"Verified" is THREE different Meta things and they are constantly
   confused.** **Business Verification** (compliance, gates Advanced Access) ≠
   **Access Verification** (gates *Tech Provider* status, ~5 days, the one
   nobody knows about) ≠ **Meta Verified** (a **$14.99–$499.99/month paid
   subscription per asset** that confers **NO developer access whatsoever**).
   ⛔ **Do not buy Meta Verified for API access.**

## 1. WHAT EXISTS IN THE REPO TODAY (surveyed 2026-08-21)

| Platform | State |
|---|---|
| **Google — Gmail send / readonly, Drive readonly** | ✅ **Built & working**, CRM-scoped |
| **Google Sign-In (login with Google)** | ❌ **Absent** — portal login is password + OTP + TOTP + Turnstile |
| **Google OAuth app verification status** | ⚠️ **UNRECORDED ANYWHERE** — and restricted scopes are in use |
| **Microsoft / Outlook** | ❌ **Absent** — zero API code; every "outlook" hit is email-rendering or a tester's address |
| **Facebook Login / Messenger** | ❌ **Absent** — `graph.facebook.com` appears NOWHERE in the repo |
| **Meta infra (via WhatsApp)** | 🟡 **Built but dormant** — webhooks, HMAC verify, encrypted creds, send-policy gates… **no transport, no live traffic, every flag off** |
| ↳ ⛔ `POST /whatsapp/threads/:id/send` | Writes a `WhatsAppMessage` row and **returns — no network call at all**. `WHATSAPP_SIMULATE` defaults **true** → stamped `SENT, simulated:true`. ⛔ **Flipping it to `false` stamps `QUEUED` and NOTHING dequeues it — it claims "pending" forever, which is worse than the simulated path.** |
| **Instagram** | ❌ **Absent** (`instagramUrl` email-signature field only) |
| **TikTok** | ❌ **Absent** — zero occurrences repo-wide |
| **Generic OAuth framework** | ❌ **Absent** — the Google flow is hand-rolled TWICE (`crm/emailRoutes.ts`, `crm/driveRoutes.ts`) |

- **Live OAuth client**: `1004420523742-to03vd0qr795748o10rogqfljm9romim.apps.googleusercontent.com`
  → **Google Cloud project number `1004420523742`**. ⏳ **Which Google account
  owns that project is UNKNOWN** — `jw4226997@gmail.com` has no projects and a
  second account errored. This blocks the scope check below.
- **Scopes requested** (`crm/emailRoutes.ts:453`): `openid email profile
  gmail.send` + `gmail.readonly` (only when reply-tracking is on) + `drive.readonly`
  (incremental, `driveRoutes.ts:219`).
- ⛔ **The cleanest extension point for new providers is `ProviderCredential` +
  the `IntegrationProvider` enum** (already `credentialsEncrypted` + `isEnabled`
  + unique `(tenantId, provider)`, but currently only `TWILIO`/`VOIPMS`).
  Adding `GOOGLE`/`MICROSOFT`/`META` there plus ONE shared OAuth module avoids a
  fifth bespoke copy. Credentials pattern is solid and reusable: AES-256-GCM via
  `packages/security`, `CREDENTIALS_MASTER_KEY`, `keyId` rotation column.
- ⛔ The unified inbox seam already exists and is the right one for Messenger/IG:
  `ConnectChatThreadType` = `SMS | DM | GROUP | TENANT_GROUP | WHATSAPP`, with
  per-type adapter dispatch behind the existing `/chat/threads` routes
  ("Option A" in `ARCHITECTURE.md`). **Only SMS actually flows today.**

## 2. GOOGLE

- ✅ **"Sign in with Google" needs NO verification at all.** `openid`/`email`/
  `profile` are non-sensitive: no review, no warning screen, **no 100-user cap,
  and no 7-day token expiry**. Shippable immediately — pure build task.
- ⛔⛔ **CASA IS REQUIRED FOR RESTRICTED GMAIL SCOPES IN A PUBLIC MULTI-COMPANY
  APP, AND IT REPEATS EVERY 12 MONTHS.** Google: *"Every app that requests
  access to Google users' restricted data and has the ability to access data
  from or through a third-party server must go through a security assessment"*,
  renewed *"at least every 12 months"*. Loopcom is server-side SaaS, so the
  server-access condition is met. **None of Google's exemptions fit** (personal
  use / dev-test / service-account-own-data / internal-org-only / domain-wide).
- ⚠️ **CASA tier and cost are SECONDARY-SOURCED**: reportedly Tier 2 for most
  SaaS at roughly **$540–$1,800/year**. ⛔ The widely-repeated **$50,000 figure
  is a myth**. Get a written quote from an App Defense Alliance assessor.
- ⛔⛔ **THE HIGHEST-LEVERAGE UNKNOWN, AND IT IS A TWO-MINUTE CHECK: is
  `gmail.send` RESTRICTED or merely SENSITIVE?** Google's own pages do not
  enumerate per-scope classification. **Sensitive = 3–5 day review and NO CASA.
  Restricted = the annual-assessment regime.** Same question for `drive.file`
  (per-file, widely understood to be the non-sensitive escape hatch) vs
  `drive.readonly`. **The OAuth consent-screen scope picker in Cloud Console
  labels every scope inline.** ⏳ **NOT YET RUN — blocked on Console access.**
  ⛔ **Do not guess this and do not budget before running it** — scope
  minimisation (send-only + `drive.file`) may remove a recurring four-figure
  cost and several weeks from the critical path.
- ⛔ Unverified apps with sensitive/restricted scopes are capped at **100
  users**; Testing mode also expires refresh tokens after **7 days**.
  Loopcom has ~85 users. ⏳ **Whether this app is Testing or Published is
  UNKNOWN — check it.**
- 🔴 **A LIVE BUG WITH NO APPROVAL DEPENDENCY**: the OAuth client is registered
  for `app.connectcomunications.com` only. **`https://app.loopcom.net/api/crm/
  email/oauth/callback` and the Drive callback are NOT registered**, so Gmail/
  Drive connection fails at Google for anyone on the Loopcom hostname. Fixable
  today. (Already flagged in CLAUDE.md's identity section; still not done.)
- Lead times: brand verification 2–3 business days; sensitive-scope 3–5;
  restricted-scope *"several weeks"* **plus** the assessment.

## 3. META — Facebook + Instagram + WhatsApp are ONE app and ONE chain

⛔ **All three of Izzy's Meta asks sit behind the same Meta app and the same
verification chain. They are one process, not three.**

**The required order (each step independently rejectable, cannot be parallelised):**
1. **Business-type Meta app** + connected business portfolio
2. **Business Verification** — mandatory since 2023-02-01 for any app serving
   other businesses. Documents: certificate/articles of incorporation, business
   registration/licence, tax document, bank statement, or utility bill **in the
   business name**; PDF/JPEG/PNG, ≤5 MB, ≤3 docs. Must show **legal name,
   physical address, phone and/or website** matching the portfolio exactly.
   ⚠️ Standard turnaround is **NOT stated on any official page**; third-party
   claims of ~3 attempts then a 3–5 day appeal are **unverified**.
3. **App Review** for Advanced Access — ⛔ **Standard Access only reaches users
   who have a ROLE on the app**, so anything touching a customer's Page/IG/WABA
   is Advanced by definition.
4. **Access Verification** (~5 days) → **Tech Provider status**. ⛔ Tech Provider
   is **NOT self-declared**. 36 permissions trigger it, including
   `whatsapp_business_management`, `instagram_basic`, `pages_show_list`,
   `business_management`.
5. Live mode, ToS acceptance, webhooks.

- ✅ **Cost: no fee is stated on any Meta page** for BV, Access Verification,
  App Review, DPA or Tech Provider status.
- **App Review submission traps**: ⛔ **a separate screencast per permission**
  (*"Any requested permission or feature missing a screen recording will not be
  approved"*), 1080p+, monitor width **≤1440px**, **no audio**, English UI,
  visible cursor, and it must show **both** the user granting the permission
  **and** the app using it. ⛔ **≥1 successful API call per requested permission
  within 30 days before submission.** ⛔ Never supply a personal Meta account as
  test credentials. Turnaround *"less than one week, often 2–3 days"* (WhatsApp
  reviews average ~24 h). **No binding SLA.**

### WhatsApp — customers onboarding their OWN numbers
- ✅ **Tech Provider is the correct model, not Solution Partner.** Clients
  *"provide their own payment method after onboarding"* and **Meta bills them
  directly**; Loopcom bills separately for its own services and fronts no
  message spend. (Solution Partner carries a credit line and is *"a lengthy
  process"*.)
- Permissions needing Advanced Access: `whatsapp_business_messaging` +
  `whatsapp_business_management`. Review needs **two demo videos** (a message
  delivered to the WhatsApp client, and template creation).
- ⛔ **Onboarding throughput is capped at 10 new business customers per rolling
  7 days by default; completing BV + App Review + Access Verification raises it
  to 200.** Plan the go-to-market around that.
- **Embedded Signup**: Facebook Login **for Business** + JS SDK, a
  **config ID**, `account_update` webhook, valid SSL / HTTPS-only domains, and
  the token code has a **30-second validity** — exchange server-side at once.
  ⛔ **Target v4; v2 dies 2026-10-15.**
- **Pricing is PER MESSAGE since 2025-07-01** (conversation pricing deprecated),
  charged **only on template delivery**, billed to the customer.
  ⛔ **Architectural consequence: the cost model must track the 24-hour customer
  service window per conversation** — an identical utility template is free
  inside it and billed outside it. Per-conversation amortisation is now wrong.
- **Messaging limits** start at 250 unique contacts/24 h and scale to unlimited;
  BV is one of three scaling paths to 2,000.
- ✅ **Coexistence exists**: a customer already on the WhatsApp Business app can
  connect the same number and keep using both (v2.24.17+, 20 mps cap; loses
  disappearing/view-once, broadcast lists, group chats).

### Facebook Login
- ✅ `public_profile` + `email` alone need **no review and no BV** — fine for
  plain consumer login.
- ⛔ **BUT Facebook Login for Business (what Tech Providers use) requires
  Advanced Access to `public_profile` BEFORE going live** — the exception to the
  above. FLB uses a **`config_id`** instead of `scope`, needs a **Business-type
  app**, and logs in a **business portfolio**, not a person.

### Instagram
- ⛔ **Use the Instagram Login path, not the Facebook Login path.** It needs
  **no linked Facebook Page** and just **two** permissions
  (`instagram_business_basic` + `instagram_business_manage_messages`) versus
  four-plus; Meta's own migration guide cites *"an average of 12 steps to just
  two"*. ⛔ **The FB Login path is NOT deprecated** (a common misreading — the
  Jan 2025 deprecation was of scope *names* inside the IG Login path) and Meta
  states no preference, but IG Login is the strategic direction.
- ✅ **Creator accounts work too** — not Business-only.
- ⛔⛔ **THE #1 CAUSE OF "connected successfully but no messages arrive": the
  customer must toggle Instagram → Settings → Messages and story replies →
  Message controls → Connected Tools → *Allow Access to Messages*.** Build this
  into the onboarding instructions or support will drown in it.
- ⛔ **Conversations API is rate-limited to 2 calls/sec per account** — the
  binding constraint for inbox sync.

### Ongoing obligations (the part that bites later)
- ⛔ **Data Protection Assessment is ANNUAL**, with a **60-day clock that starts
  silently** (email + the app's **Alert Inbox**) and ends in **loss of platform
  access**. It is being absorbed into **"Data Access Renewal"**, whose language
  is harsher: app **deactivation**, and *"Extensions are not provided"*.
  ⛔ **Point the app-admin email at a MONITORED shared mailbox and put the Alert
  Inbox on someone's weekly checklist.**
- ✅ **A current SOC 2 Type 2 / ISO 27001 / ISO 27018 certificate short-circuits
  most of the 17-question security section.** Without one, expect to remediate:
  **MFA on all admin tools, ≥30-day log retention, TLS 1.2+ everywhere**,
  encryption at rest, documented access reviews, and **written agreements with
  every service provider** binding them to use Platform Data only at your
  direction.
- ⛔ **90-day per-user regrant**: a permission unused for 90 days (usually user
  inactivity) must be re-granted — **per token, not per app**, so dormant
  customers silently drop off.
- ⛔ **2026-04-27 (already in force): Messenger tags `CONFIRMED_EVENT_UPDATE`,
  `ACCOUNT_UPDATE`, `POST_PURCHASE_UPDATE` now return error 100.**
  `HUMAN_AGENT` (7-day window) survives but needs App Review + BV and
  *"may also need additional contracts"*.

## 4. MICROSOFT / OUTLOOK

- ✅ **No Microsoft approval gate to ship.** Registration free, Publisher
  Verification free, **Microsoft 365 Certification NOT mandatory** (unlike
  Google's CASA). Microsoft gates via *consent policy* instead.
- ⛔⛔ **BUT A LATE-2025 POLICY CHANGE (MC1163922) MEANS READING MAIL NOW NEEDS
  THE CUSTOMER'S TENANT ADMIN — IN EVERY TENANT, VERIFIED PUBLISHER OR NOT.**
  The Microsoft-managed default consent policy excludes `Mail.Read`,
  `Mail.ReadBasic`, `Mail.ReadWrite` (plus all `Calendars.*`, the `.Shared`
  variants, and legacy EAS/EWS/IMAP/POP) from user consent.
  ✅ **`Mail.Send` is NOT on that exclusion list.**
  ⛔ **THE TRAP: `permissions-reference` still says `Mail.Read` needs no admin
  consent.** That field describes the *permission*, not the tenant's *consent
  policy* — which now overrides it. **Building off the reference table produces
  an app that works in your dev tenant and fails at every customer.**
  ⛔ **The exclusion list is explicitly "subject to change without notice" —
  `Mail.Send`'s absence today is not a guarantee. Build the admin-consent path
  regardless** (`/adminconsent` endpoint + the admin consent request workflow).
  **Product consequence: "send from Outlook" is self-serve; "sync my Outlook
  inbox" needs their IT admin.**
- ⛔⛔ **THE APP MUST BE REGISTERED WITH A WORK/SCHOOL ACCOUNT — a personal
  Microsoft account can NEVER be publisher verified, and an app object cannot be
  moved between tenants. This is unrecoverable if done wrong.** ⛔ Loopcom is on
  **Google Workspace, not Microsoft 365**, so a **free Entra tenant must be
  created first**. Register as **`AzureADMultipleOrgs`** (multi-tenant).
- **Publisher Verification is a functional prerequisite, not a badge**:
  risk-based step-up consent (on by default) blocks user consent to
  newly-registered unverified multi-tenant apps → `AADSTS90094`, and the prompt
  reads *"unverified publisher… risky to download or install"*.
  Requirements: a **Partner One ID for a verified MAICPP account** that is the
  **Partner Global Account** (⛔ **location IDs are NOT supported**), a
  **publisher domain** (⛔ not `*.onmicrosoft.com` — use `loopcom.net`),
  matching email domain, Entra + Partner Center roles, and MFA.
  **Free; minutes once the prerequisites hold.** The wait is MAICPP account
  verification: *"three to five business days"*, needing government ID
  (name matching exactly), **domain registration documents**, and formation
  documents with **exactly matching** name and address.
- ⛔ Publisher-domain JSON must be served at
  `https://<domain>/.well-known/microsoft-identity-association.json` with
  **Content-Type `application/json`** — anything else fails.
  ⚠️ Given Loopcom's history of static assets falling through nginx location
  blocks ([[email-images-are-refetched-every-open]]), check the header, not just
  the body. The file may be removed after verification.
- ⛔ **Two hostnames matter here**: with a null publisher domain a multi-tenant
  app is restricted to a **single root domain** across all redirect URIs.
  **Setting the publisher domain is what makes registering both
  `app.connectcomunications.com` and `app.loopcom.net` legal.** ⚠️ Verify in the
  portal before committing to a two-hostname OAuth flow.
- ⛔ **Never use application (app-only) mail permissions** — they grant access to
  **every mailbox in the tenant**, are wildly over-privileged for a per-user CRM
  integration, and fail least-privilege review. Use **delegated + `offline_access`**.
- ⛔ **Breaking change, enforcement 2026-12-31**: modifying `subject`, `body`,
  `recipients` on **non-draft** messages will require `Mail-Advanced.ReadWrite*`
  (all admin-consent). Drafts are unaffected. ⛔ **Audit the SMS↔email bridge —
  if any path mutates a received message rather than creating a draft or new
  message, it dies on that date.**
- ⚠️ M365 Certification, if ever pursued: Publisher Verification **and**
  Attestation are prerequisites; contract is with **Claranet** (price
  unpublished); Stage 1 14 days + Stage 2 60 days; **annual recertification**;
  and ⛔ **mandatory annual penetration testing for any app connecting to
  externally-hosted services** — which for Loopcom drags VitalPBX, VoIP.ms/
  SignalWire, Cardknox/Sola and ElevenLabs into scope. **A real project, not a
  checkbox. Defer until an enterprise customer demands it.**

## 5. TIKTOK — ⛔⛔ AN EARLIER PASS OF THIS DOC SAID "NO DM API, US EXCLUDED, DROP IT". THAT WAS WRONG.

⛔ **CORRECTION (recorded deliberately, because it was told to Izzy in chat
before the deeper pass landed).** A first-pass research agent concluded there is
no third-party DM API and that the US is excluded, and recommended allocating
zero engineering time. **A Business Messaging API exists, it is fully
documented, and the United States IS supported.** The widely-repeated
third-party claim that TikTok Business Messaging is unavailable in the US
(SleekFlow, respond.io and others) is **wrong as of 2026**, or describes a
superseded beta. ⛔ **The lesson: `developers.tiktok.com` and
`business-api.tiktok.com` are TWO SEPARATE PORTALS with separate registrations
and separate review pipelines. There is genuinely no messaging product on the
first one — searching only there produces exactly this false negative.**

- ✅ **The DM endpoints are real** (`business-api.tiktok.com/portal/docs/
  direct-messages/v1.3`): send a message, list conversations, list messages,
  upload/download images, check per-account capability, enable Comment-to-
  Message, plus inbound webhooks.
- ⛔ **The excluded regions are the EEA, Switzerland and the UK — NOT the US.**
  Region is determined by **the sign-up location of the customer's Business
  Account**, not by where Loopcom is.
- ⛔⛔ **BUT US ACCESS IS A SEPARATELY EARNED PERMISSION, AND IT IS A
  SECURITY-COMPLIANCE PROJECT, NOT AN INTEGRATION.** Verbatim: *"For Business
  Accounts signed up in the US, only developers who have passed the Data
  security & privacy review, the US data security review, and agreed to the
  USDS Addendum, are permitted to call the Business Messaging API on behalf of
  these accounts."* And: *"you will not be able to obtain Business Messaging
  scope of permission for your developer app without completing the data
  security and privacy review process. **There are no exceptions.**"*
  **The chain:** intake (TikTok initiates within 10 working days) → **DSPR
  DDQ** (2–4 weeks) → **USDS VAQ** (7–10 business days, arriving ~1 week after
  the DDQ) → **USDS Addendum** contract. **Budget 6–10 weeks minimum.**
- ⛔ **The DSPR is a real audit of the security programme**, not a form:
  encryption at rest ≥AES-256, TLS 1.2+ in transit, MFA on admin accounts,
  15-minute screen lock, written infosec policy signed by leadership, network
  segregation + NIDS/HIPS, least-privilege access policy with annual privilege
  review and retained access logs, vulnerability scans / penetration tests with
  retained reports, incident-response policy with annual drills, named privacy
  owner, deletion on de-authorisation. ✅ **ISO 27001 / SOC 2 / a recent pentest
  are strongly recommended supporting evidence and TikTok says supplying them
  speeds approval.**
- ⛔ **USDS runs an OFAC/CFIUS Restricted-Countries screen on Ultimate
  Beneficial Owners** (China incl. HK, Russia, Iran, North Korea, Cuba, Syria),
  including **aggregate ownership >25%**. A US-owned LLC should pass cleanly,
  but **UBO disclosure is required** and misrepresentation is instant
  disqualification.
- ⛔ **Business Accounts only, with per-customer authorisation** — the same
  onboarding shape as WhatsApp: each customer converts their TikTok account to
  Business and explicitly authorises Loopcom. **TikTok Shop messages are a
  separate system and are NOT manageable via this API.**
- ⛔ **Silent failure mode to design for:** for an EEA/CH/UK account — or a US
  account before USDS approval — **authorisation SUCCEEDS but every API call
  fails.**
- ⚠️ The **Messaging Partner Specialty** appears to be a *badge* within the
  Marketing Partners Programme, **not** a prerequisite; the documented access
  path is the review chain above. (Inferred from framing, not stated as
  optional verbatim.)
- ⛔ **Do not confuse `portability.directmessages.*` with messaging** — those
  belong to the **Data Portability API**, a DSA/DMA bulk-export mechanism
  **limited to EEA and UK users**. Useless for a US customer base.
- ✅ **The cheap fast win is Login Kit + Display API**: `user.info.basic` is
  auto-attached and needs no scope justification (the app itself still needs
  review), turnaround *"several days to two weeks"*.
- ⛔ **Three automatic app-review rejections that matter for B2B SaaS:** adult
  content, **private-use apps**, and **development/testing-stage applications**.
  A "we're just wiring it up internally" framing is rejected — it must be a real
  shipped product. Sandbox (5 per app, 10 test accounts) is **required** for a
  first-time approval.
- **Registration:** organisation account with an admin-level company email
  (⛔ the org name is the full legal entity and **cannot be changed after
  creation**); no fee stated anywhere. Developer-portal *business verification*
  (1–3 business days) is mandatory only for mini-games/mini-dramas/monetisation
  — **not** for Login Kit or Content Posting.
- ⛔⛔ **NO INDIVIDUAL DEVELOPERS ON THE BUSINESS PORTAL** — verbatim:
  *"Currently, we are unable to onboard personal accounts or individual
  developers."* It requires a **verified company-domain email** (*"You will be
  rejected if you are using a personal email"*) and a **public company website
  on a company-owned domain** — no social/hosting/e-commerce domains, no
  shortened links. ✅ Loopcom clears this with `izzy@loopcom.net` +
  `https://loopcom.net`. Developer registration review **3 business days**; app
  review **2–3 business days**; max **5 apps** per developer.
- ⛔ **Already in force: since 2026-03-20 an "Accounts API Access Application
  Form" must be completed** before submitting a new app or a scope increase that
  includes the **TikTok Accounts** scope.
- ✅ **VERIFIED NEGATIVE: TikTok Marketing Partner status is NOT required for
  API access.** The partner programme (four *badges* — Agency, Creative,
  Measurement, Marketing Technology) is never mentioned in the access chain and
  is a separate track. ⚠️ Third-party blogs claiming spend thresholds and
  Silver/Gold/Platinum tiers are **uncorroborated** — so is the claim that "the
  API is not free in 2026", which contradicts TikTok's own Developer ToS.
- ⛔ **Accounts API access tokens are valid ONE DAY** and must be refreshed
  (`auth_code` 10 minutes), whereas **Marketing API advertiser tokens never
  expire**. Building the former on the latter's assumption breaks in 24 hours.
- ✅ **No US developer cut-off ever happened.** The changelog across the whole
  post-divestiture window is **additive-only — zero deprecations, zero scope
  migrations, zero rate-limit changes**. TikTok USDS Joint Venture LLC has been
  operational since 2026-01-23 (ByteDance retains 19.9%). The only US-specific
  developer regime is the Business Messaging one above. ⛔ `user.info.basic` is
  **not** deprecated — `user.info.profile`/`.stats` are granular additions.

### ⛔⛔ THE CROSS-PLATFORM INSIGHT: ONE SECURITY EVIDENCE PACK UNLOCKS THREE PROGRAMMES
Meta's **Data Protection Assessment**, TikTok's **DSPR**, and Microsoft's
(optional) **M365 Certification** all demand the same underlying artefacts, and
Google's **CASA** is the same genre. The shared list: **SOC 2 Type 2 or ISO
27001** (which short-circuits most of Meta's 17-question security section),
a **recent penetration test**, **MFA on all admin tooling**, **≥30-day log
retention**, **TLS 1.2+ everywhere**, encryption at rest, documented access
reviews, a written incident-response policy, and **written agreements with every
service provider**. ⛔ **Treat this as ONE investment with four payoffs, not four
separate compliance exercises** — and note it is the gate on the two most
valuable channels (WhatsApp customer onboarding and TikTok US messaging).

## 6. DEPENDENCY-ORDERED START LIST

**Can start TODAY, zero prerequisites, free:**
1. ⛔ **Run the Cloud Console scope-picker check on `gmail.send` / `drive.readonly`
   / `drive.file`** — decides the entire Google budget. ⏳ **Blocked only on
   knowing which account owns project `1004420523742`.**
2. **Register the missing `app.loopcom.net` OAuth callbacks** — fixes a live bug.
3. **Ship Sign in with Google** — no approval needed, ever.
4. **Create a free Entra tenant + register the Graph app** as `AzureADMultipleOrgs`
   under a work/school account, publisher domain `loopcom.net`.
5. **Create the Business-type Meta app.**
6. ⛔ **Settle the legal-name spelling** against the LLC certificate and WHOIS.

**Blocked on business documents (file next, they are the long poles):**
- **Meta Business Verification** → App Review → **Access Verification**
  (three sequential, independently rejectable gates)
- **Microsoft MAICPP enrolment** (~3–5 business days) → Publisher Verification
- **Google restricted-scope verification + CASA** *if and only if* the scope
  check says it applies — *"several weeks"*, and the longest pole if it does

**💰 Material costs:** Google CASA ⚠️ ~$540–$1,800/yr **recurring** (quote it);
WhatsApp messaging **billed to customers, not Loopcom**; ⛔ Meta Verified
**not required — do not buy**; M365 Certification unpublished and **optional**.
⛔ **The largest un-costed item is the security evidence pack** (SOC 2 / ISO
27001 + pentest) — see §5. It is optional for Google/Microsoft, **effectively
required for TikTok US messaging**, and it short-circuits most of Meta's annual
DPA. Price it once, against all four.

**Longest poles, in order:** (1) **TikTok US messaging** — 6–10 weeks *plus*
whatever the security evidence takes to assemble; (2) **Meta's three sequential
gates** (BV → App Review → Access Verification), which cannot be parallelised;
(3) **Google restricted-scope + CASA** *if* the scope check says it applies;
(4) **Microsoft MAICPP** (3–5 business days) → Publisher Verification (minutes).

## 7. NOT PROVEN / OPEN

- ⏳ **Nothing has been filed and no account created.** This is research only.
- ⏳ The Google Cloud project owner is unknown; the scope check, the app's
  Testing-vs-Published status, and its user count against the 100 cap are all
  **unread**.
- ⏳ The legal-name spelling question is **unresolved** and gates four
  verifications.
- ⚠️ Weakly sourced and flagged throughout: CASA tier/pricing, Meta standard BV
  turnaround, the Gmail per-scope classification, M365 Certification cost, and
  Meta's document recency window. ⛔ Meta's `facebook.com/business/help/*` pages
  are JS/login-gated and returned title-only; the Messenger changelog 500s.

---

## 7. UPDATE 2026-08-24 — THE WHATSAPP NUMBERS ARE "PENDING" BECAUSE THE REVIEW NEVER STARTED

**Read-only investigation in Izzy's real Chrome. No Meta setting changed, no
document uploaded, no verification submitted, no code, no deploy.**
Izzy: *"I've applied for the WhatsApp number in Meta and it's been pending for
days. Can we figure out why?"*

### 7a. The mechanism — and it inverts the intuition

⛔⛔ **Meta's own help article
(<https://www.facebook.com/business/help/338047025165344>) states:**
> *"Your requested display name becomes eligible for review once your business
> becomes eligible for higher messaging limits."*

So the display-name review is **not a queue Meta drains on its own schedule** —
it does not ENTER the queue at all until the business qualifies for higher
messaging limits. WhatsApp Manager's Business Status panel names the only two
qualifying paths, and reports both as not met:

1. **Verify your business** → button reads **"Get Started"** (never started)
2. **Send high-quality messages** → **0 conversations started / 30d**

⛔ **Therefore nothing is being reviewed and waiting cannot help.** Do not answer
this symptom with "give Meta a few more days" — read the Business Status panel
first. Security Center confirms the same from the other side: Business
Verification shows **"Eligible for verification"** with a **"Start
verification"** button, i.e. never submitted.

### 7b. Measured state (portfolio Loopcom, business_id 1679921306977288)

**TWO WABAs, TWO numbers, BOTH Pending, both created 2026-08-16:**

| WABA | WABA ID | Number | Display name | Phone number ID | Name review requested |
|---|---|---|---|---|---|
| loopcom | 1349133117379462 | **+1 845-723-1213** | `loopcom` | 1287606197767864 | Aug 16, **1:11 PM** ET |
| Connect comunications | 1437420911538490 | **+1 845-557-7768** | `Connect comunications` | 1282357178294967 | Aug 16, **11:37 AM** ET |

Each activity log reads `Added` → `Updated Business Profile` →
**`Name verification requested`**, all inside one minute. **8 days elapsed**,
quality rating blank, 0 messages sent, 0 of 250 business-initiated conversations.

⛔ **Both numbers are LIVE PRODUCTION SMS SENDERS.** (845) 723-1213 is the
platform billing / pay-link / 2FA / compliance SMS sender
(`BILLING_SMS_FROM_NUMBER`); (845) 557-7768 is the agent-escalation number, the
Loopcom Direct verification sender, and the admin shared SMS inbox. WhatsApp
registration does not remove SMS (separate transports) — but never delete and
re-add these numbers casually to "retry" the review.

⛔ **The numbers were NOT waiting on an OTP.** Both render the full tab set
(Insights / Profile / Automations / Message links / Two-step verification / Call
settings / Call logs), which an unverified number does not get. The Profile tab
shows the display name with no "pending review" badge.

### 7c. ⛔⛔ AND SUBMITTING VERIFICATION TODAY WOULD BE REJECTED — §0 IS NOW BITING

`Settings → Business info` for the **Loopcom** portfolio reads:

- **Legal business name: `Connect comunications`** — misspelled (one `m`) **and
  not the legal entity**, which is **`Loopcom LLC`** (Izzy confirmed that
  spelling 2026-08-23; FCC FRN 0038803722 carries "loopcom llc.", USAC carries
  "LoopCom, LLC")
- **Address: `United States of America`** — no street, city, state or ZIP
- **Business phone: none**
- **Primary Page: None**
- Website: `https://connectcomunications.com/`
- Business verification status: **Unverified**

⛔ §0 of this handoff warned that Meta matches documents against the portfolio's
**name + address + phone character-for-character**, and listed **three** spellings
in circulation. **The Meta portfolio is a fourth — and it is the one gating
this.** No incorporation document will say "Connect comunications" at an address
of "United States of America".

⛔ **Fix Business info BEFORE clicking Start verification.** A rejected
verification costs more to unwind than getting it right once.

### 7d. What is NOT the problem

- ✅ **Nothing is blocked on Loopcom code.** `apps/api` still has no WhatsApp
  transport at all (see `AGENT_HANDOFF_WHATSAPP_AUDIT_2026-08-16.md`); this is
  entirely a Meta-side account problem.
- ✅ **He is not blocked from building or testing.** Meta: *"You don't need to
  complete a WhatsApp display name review or account checks to get started on
  WhatsApp Business Platform. You can begin sending messages to customers
  immediately."* Pending affects the **name customers see**, not API access.
- ⚠️ A standing Overview alert reads *"Missing valid payment method — free tier
  conversations can only be initiated by your customers."* Separate from the
  review, but it blocks business-initiated messaging.

### 7e. The fix, in order — all of it is Izzy's to do, none of it is code

1. `Settings → Business info → Business details → Edit`: legal name matching the
   LLC certificate exactly, real street address, business phone.
2. `Settings → Security Center → Business Verification → Start verification`,
   documents matching (1) character-for-character.
3. Add a payment method.
4. ⛔ **Expect `Connect comunications` to be DECLINED even after verification** —
   it is misspelled and unrelated to "Loopcom LLC". Meta requires the display
   name to be related to the business, or the relationship established on the
   website listed in Business Manager. Settle the customer-facing name first.
5. ⏳ **Open question: why two WABAs?** One portfolio, two accounts, two of our
   own numbers. The second may simply be a duplicate worth deleting.

⏳ **NOT PROVEN: nothing has been submitted, so no verification outcome exists.**
The acceptance test is the Business Status panel's "Verify your business" step
turning green, followed by the two numbers moving off **Pending** — Meta says
that notification lands 1–2 days after verification completes.

### 7f. UPDATE 2026-08-25 — business info CORRECTED and verification SUBMITTED

⛔ **§7c above is now history — re-read this before repeating any of it.** Izzy
fixed the portfolio and submitted verification the same session.

**Business details, saved and verified on the live page:**
- Legal business name: **`Loopcom LLC`** (was `Connect comunications`)
- Address: **`33 Route 17M, Harriman, New York 10926`** (was `United States of America`)
- Business phone: **`+18457231213`** (was none)
- Website: **`https://loopcom.net/`** (was `connectcomunications.com`)
- Tax ID (EIN): entered by Izzy himself

⛔ **The EIN was deliberately NOT typed by the agent** — a government-issued tax
ID is not something to enter into a form on someone's behalf. The field is
optional (`"Tax ID will be used to find potential matching business records"`),
so leaving it blank blocks nothing; it exists to help Meta auto-match the
business and skip the document upload.

✅ **Business verification status is now `In review`** — *"Your business
verification application is being reviewed by Meta."* That is the gate the two
Pending numbers were stuck behind since 2026-08-16.

⛔⛔ **DOCUMENTS ARE CONDITIONAL, NOT MANDATORY — the wizard's own words:**
*"You may need to upload accepted documents to confirm these details **if your
business is not found**."* Meta tries to match the legal name against official
records first (which is what the EIN feeds). Only an unmatched business is asked
to upload. The three wizard steps are **Verify business details → Confirm your
connection → Upload documents (conditional)**.

⚠️ **A correction the agent made to its own earlier advice:** §7e said to get a
real website up *before* submitting verification. That was over-cautious —
**verification turns on the documents and the record match, not the website.**
loopcom.net being a parked page does not block BV. It DOES still matter for the
display-name approval and for Tech Provider App Review, both of which lean on
the site to prove "loopcom" belongs to Loopcom LLC.

### 7g. The Tech Provider path — the app already exists and is further along than expected

**Meta app `Loopcom`, ID `1027780856754202`**, owned by the Loopcom portfolio,
Izzy the only person on it with full access. On its dashboard:

- ✅ **"Customize the Connect with customers through WhatsApp use case" — DONE**
- ○ Test use cases — not done
- ○ Check requirements and publish — not done
- **Publish status: `Unpublished`** (still development mode)
- **A "Become a Tech Provider" card is present**: *"Become a Tech Provider to
  submit to App Review and request access to user data and data from other
  businesses. You'll be required to complete access verification."*
- `Facebook Login for Business` already appears in the left nav — the product
  Embedded Signup needs.

⛔ **Note a sequencing discrepancy worth resolving before planning around it:**
§3 of this handoff has the order as App Review → Access Verification → Tech
Provider, but **Meta's own dashboard copy says you become a Tech Provider in
order TO submit to App Review.** Do not assert either order as fact until the
"Become a Tech Provider" flow has actually been opened and read.

⛔⛔ **THE REAL LONG POLE IS NOT PAPERWORK — IT IS THAT WE CANNOT SEND A MESSAGE.**
App Review requires **at least one successful API call per requested permission
within the 30 days before submitting**, plus a separate screencast per
permission. `apps/api` has **no WhatsApp transport at all** —
`POST /whatsapp/threads/:id/send` writes a row and returns. So App Review is
blocked on a real build, not on Meta.

⏳ **Still open:** no payment method on the WABAs; loopcom.net is still a parked
"under construction" page; and the display name `Connect comunications` on the
second WABA remains likely to be declined once reviews do start.
