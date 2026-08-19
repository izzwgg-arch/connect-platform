# AGENT HANDOFF — SignalWire as the replacement for VoIP.ms: test bench BUILT inside Loopcom (2026-08-18)

> Izzy, 2026-08-18: *"I want to start pivoting away from voip.ms, and I want to
> set this up and test it to see if this would be the ideal replacement. I want
> to build this inside Loopcom."* — then a link to https://signalwire.com/docs/apis.
>
> Read this before touching `apps/api/src/signalwire/`, the portal page
> `/apps/signalwire`, before wiring ANY SignalWire path into onboarding / chat /
> billing SMS / the worker / the PBX, or before answering "can SignalWire do X?".

Commit `50f9fa69` on `feat/ivr-migration-takeover` (private-index commit — `server.ts`
was carrying another session's staged + unstaged edits). Deploy state: see §7.
**No migration, no env change, no tenant row touched, no VoIP.ms path touched.**
⛔ **UPDATE, same evening: credentials ARE in (Space `loopcom.signalwire.com`, project "Main"),
one number is on the account, and under Izzy's explicit instruction a real trunk was built —
PBX writes, all backed up. See §10 before touching trunk 132, `extensions__60_custom.conf`'s
`[trk-132-in](+)` block, or Loopcom Demo's DID list.**

---

## 1. What this is, and what it is NOT

**It is a test bench.** Every job VoIP.ms does for the platform today has a panel on
`/apps/signalwire` (owner-only) that does the same job on SignalWire, so each can be
proven or disproven with the result on record — before anything real is pointed at
SignalWire.

**It is NOT a cut-over.** Nothing here is wired into onboarding, chat, billing SMS, the
worker or the PBX. A number bought from the page lives on SignalWire and in the event log;
it is assigned to no tenant, rings no PBX, and appears in no `TenantSmsNumber` row until a
person wires it. A source guard in `signalWire.test.ts` pins that the module never
references `globalVoipMsConfig`, `voipMs*`, `tenantSmsNumber`, `onboarding/`,
`@connect/integrations` or `vms(`.

## 2. What VoIP.ms does for the platform today (the contract a replacement must meet)

Full inventory was taken from the code on 2026-08-18. Three VoIP.ms clients exist; **everything
that runs in production rides the platform-wide `GlobalVoipMsConfig` singleton + the raw
`vms()` client in `apps/api/src/onboarding/voipMsProvisioning.ts`**; the per-tenant
`ProviderCredential` + Twilio/VoIP.ms failover layer in `packages/integrations` is the older,
largely unused one (`VoipMsNumberProvider.purchaseNumber` literally throws "not available yet").

| Job | VoIP.ms method(s) | Where |
|---|---|---|
| Number search (local / toll-free / vanity) | `searchDIDsUSA`, `searchTollFreeUSA`, `searchVanity` | `packages/integrations` `VoipMsNumberProvider`, `onboarding/publicRoutes.ts:207`, `agentProvisioning/addPhoneNumberCapability.ts` |
| Number purchase + routing | `orderDID`, `orderTollFree`, `orderVanity`, `setDIDRouting`, `getDIDsInfo` | `voipMsProvisioning.ts` (`applyOnboardingNumber`), `portLanding.ts`, `addPhoneNumberCapability.ts` |
| Spare pool | `getDIDsInfo` filtered `account:344022` | `listSpareDids` |
| SIP trunk credentials | `createSubAccount`, `getSubAccounts`, `setSubAccount` (⛔ full update) | `voipMsProvisioning.ts` → PBX trunk built by `pbxTenantBuild.ts:138 createTrunk` (PJSIP, registers to `newyork1.voip.ms`, ulaw/alaw/g726/g729) |
| SMS/MMS send | `sendSMS`, `sendMMS` | `VoipMsSmsProvider` ← `apps/worker/src/connectChatSmsJob.ts`, `billing/billingSmsSender.ts`, campaigns |
| SMS/MMS receive | `getSMS`, `getMMS` **poll** (60 s) | `apps/worker/src/voipMsInboundSyncJob.ts` — ⛔ the webhook path is fail-closed and functionally dead |
| SMS enable per DID | `setSMS` | `enableSmsOnDid` |
| E911 | `e911Info`, `e911Validate`, `e911Provision`, `setSubAccount(default_e911)` | `onboarding/voipMsE911.ts` |
| Porting | `addLNPPort`, `addLNPFile`, `getLNPStatus` | `voipMsProvisioning.ts` `submitPortIn`, `portWatchdog.ts`, `portLanding.ts` |
| POPs | `getServersInfo` | `resolveNewYorkPop` |
| Health | `getBalance` | admin page test |

Models: `GlobalVoipMsConfig` (singleton), `TenantSmsNumber` (`provider IntegrationProvider @default(VOIPMS)`,
enum is `TWILIO | VOIPMS` — **adding SIGNALWIRE is a migration**), `ProviderCredential`,
`OnboardingSubmission.voipmsSubaccountEncrypted`, `Tenant.smsPrimaryProvider/smsSecondaryProvider`.

## 3. What SignalWire offers against that contract (researched 2026-08-18 from their docs)

Legend: ✅ documented and used by the bench · ⚠️ documented, unverified live · ⛔ gap

- **Auth / account model** ✅ — HTTP Basic, username = Project ID, password = API token, against
  `https://<space>.signalwire.com`. Tokens do not expire but carry **scopes** (`numbers`,
  `messaging`, `calling`, …) — a 403 usually means a missing scope, and the bench says so.
  **Subprojects** exist (`POST /api/projects`), one per customer is possible with numbers
  isolated per project — but they **share one balance** and no per-subproject billing-records
  API was found ⚠️.
- **Three API families on the same credentials.** `/api/relay/rest/…` (numbers, E911 addresses,
  10DLC registry, lookup); `/api/fabric/…` (SIP credentials, SIP gateways, phone routes);
  `/api/laml/2010-04-01/…` the Twilio-shaped Compatibility API (used ONLY for SMS send and the
  inbound/status webhook contract, because that is the surface whose webhook parameters and
  signature are documented). The docs mark `POST /api/relay/rest/endpoints/sip` deprecated in
  favour of Fabric SIP credentials; the bench tries Fabric first and falls back on 404,
  **reporting which answered** (`via`).
- **Numbers** ✅ — `GET /api/relay/rest/phone_numbers/search?areacode=&number_type=local|toll-free&starts_with|contains|ends_with=&region=&city=&max_results≤100`;
  `POST /api/relay/rest/phone_numbers {number}`; `GET …/phone_numbers` (paged, `links.next`);
  `DELETE …/phone_numbers/{id}`; `PUT …/phone_numbers/{id}` with `call_handler` /
  `message_handler` (`laml_webhooks` + `*_request_url`, `relay_sip_endpoint` + `call_sip_endpoint_id`).
  ⚠️ **Monthly/purchase price for a local number is NOT on their public pricing page** — read it off
  the first purchase (`next_billed_at` comes back on the number).
- **Voice to the PBX** — three shapes:
  1. **SIP endpoint / credential** ✅ (`POST /api/fabric/resources/sip_endpoints`, fallback
     `/api/relay/rest/endpoints/sip`): a login the PBX REGISTERS with at
     `<space>.sip.signalwire.com` (5060 UDP/TCP, 5061 TLS) — the direct analogue of the VoIP.ms
     subaccount. `call_handler: passthrough` allows dialling the PSTN through it. A number can be
     told to ring it (`call_handler: relay_sip_endpoint`).
  2. **SIP gateway** ✅ (`POST /api/fabric/resources/sip_gateways {name, uri, codecs, encryption}` +
     `POST /api/fabric/resources/{id}/phone_routes {phone_route_id, handler:"calling"}`): SignalWire
     PUSHES the inbound call to `user@pbx-host` — no registration. ⚠️ Whether the DID can be carried
     dynamically in the URI, what auth SignalWire offers toward the PBX, and their source-IP ranges
     (deliberately not published — identify by domain in PJSIP, not by IP) are unverified.
  3. **IP-authenticated (registration-less) outbound** ⚠️ — exists only via a "SIP address /
     domain application" with `ip_auth` that hands the INVITE to a small SWML `connect` script;
     there is **no plain carrier-style IP trunk**.
  ⛔ **Arbitrary outbound caller ID is NOT allowed** — `send_as` / `callerId` must be a purchased
  or verified number. VoIP.ms lets the trunk send whatever CID it likes; SignalWire will not, so
  the outbound-route CID per tenant must be a SignalWire-owned number.
  Codecs `OPUS, G722, PCMU, PCMA, G729`; SRTP ciphers listed; encryption `optional|required|forbidden`.
  US list price ~0.66¢/min in, 0.8¢/min out, toll-free in 1.47¢.
- **SMS/MMS** ✅ send via `POST /api/laml/2010-04-01/Accounts/{projectId}/Messages.json`
  (`From/To/Body/MediaUrl/StatusCallback`); inbound webhook = the number's
  `message_handler: laml_webhooks` POSTing `From/To/Body/NumMedia/MediaUrlN/MessageSid`; status
  callback POSTs `MessageStatus`. Signature `X-SignalWire-Signature`, Twilio scheme (HMAC-SHA1
  over URL + sorted params, base64) keyed with the project's **signing key** — the bench
  implements it and its vector test passes against Twilio's published example.
  ⛔⛔ **10DLC brand + campaign registration is MANDATORY** for texting from a local US number
  ("you will not be able to send messages from a local US number" unregistered) — $4 brand,
  campaign fee charged 3 months up front, 3–5 business days, plus 24 h number assignment. There
  IS an API (`/api/relay/rest/registry/beta/brands|campaigns|…/orders`) — not built into the bench.
  **This is the single biggest operational difference from VoIP.ms**, which does not enforce
  10DLC on us today. Toll-free SMS needs a separate verification form (1–2 weeks, no API).
  ⚠️ Per-segment SMS price not found on their pricing page.
- **E911** ✅ full API: `POST /api/relay/rest/addresses` (validates; 422 with candidate
  corrections — the same municipality-vs-postal-town behaviour the VoIP.ms path already handles,
  Monsey → SPRING VALLEY) then `POST …/phone_numbers/{id}/e911_address {e911_address_id}` →
  `e911_status pending|active|failed`. Test by dialling **933**. **$100 fee for a 911 call from an
  unregistered number.** ⚠️ Monthly E911 fee not stated.
- **Porting** ⛔ **dashboard only, no API** — LOA, CSR/bill, ~7 business days. The whole port
  watchdog / port landing automation (`portWatchdog.ts`, `portLanding.ts`) would need rebuilding
  around their portal or support, or ports stay on VoIP.ms.
- **CNAM** — outbound name is a support ticket (≤15 chars, not on toll-free); inbound lookup ✅
  `GET /api/relay/rest/lookup/phone_number/{e164}?include=carrier,cnam` (billable).
- **Trial mode** — until a card is added and ≥ $5 funded: texts only to verified numbers, one
  number purchasable, SIP endpoints can register but not call out, DID releases locked 30 days.

## 4. What was built (`apps/api/src/signalwire/`, `apps/portal/app/(platform)/apps/signalwire/`)

- **`signalWireCredentials.ts`** — Space URL + Project ID + API token (+ optional signing key) as
  ONE JSON row in `AgentSecret` key `signalwire_credentials`, encrypted under
  `CREDENTIALS_MASTER_KEY` — the Polly pattern, **deliberately no new Prisma model** (an
  evaluation must not cost a migration). Token and signing key are write-only; `describe()`
  returns a `…xxxx` hint. `normalizeSpaceUrl` accepts `loopcom`, `loopcom.signalwire.com`, a full
  dashboard URL, and refuses any other host. Env fallback `SIGNALWIRE_SPACE_URL/PROJECT_ID/API_TOKEN/SIGNING_KEY`
  for local dev, placeholder-picky.
- **`signalWireClient.ts`** — plain `fetch` (⛔ no SDK — the `undici` boot-kill rule), one
  `swRequest()` over the three families, `classifyError()` turning 401/403/402/422/429/5xx into
  plain English (403 → "the token is missing a scope"). Read calls: `checkConnection` (numbers
  list + Compatibility account + projects, all GET), `listNumbers` (follows `links.next`, same-host
  only), `searchNumbers`, `listSipEndpoints/Gateways`, `listE911Addresses`, `getMessage`,
  `lookupNumber`. Mutations: `purchaseNumber` (**never retried; a timeout is reported as "may have
  gone through — refresh the list before trying again"**), `releaseNumber`, `updateNumberHandlers`,
  `sendMessage`, `createSipEndpoint` (Fabric → legacy fallback on 404 only), `createSipGateway`,
  `assignPhoneRoute`, `createE911Address`, `assignE911Address`.
- **`signalWireWebhookAuth.ts`** — `computeSignalWireSignature` (Twilio scheme),
  `isSignalWireWebhookAuthorized` **FAIL CLOSED** (no key / no header / mismatch all refuse),
  `candidatePublicUrls` rebuilding the URL SignalWire actually signed from `X-Forwarded-*`
  (`/api`-prefixed and bare, https-upgraded).
- **`signalWireRoutes.ts`** — `/admin/apps/signalwire/*`, **every handler opens with
  `requireOwner` (= `requireSuperAdmin`)**; a test splits the file at each route registration and
  asserts that. `PORTAL_API_PERMISSION_RULES` gained
  `{ prefix: "/admin/apps/signalwire", permission: "can_manage_global_settings" }` so the prefix
  is not silently outside the global gate (the `/admin/wake-health` class). Routes: status,
  credentials PUT (blank Space URL clears; a re-save may leave token/signing key blank to keep the
  stored ones), numbers search/list/purchase(`confirm:true`, auto-points messaging at Loopcom)/
  handlers/release(`?confirm=true`), sms send (StatusCallback set) + read-back, events (last N
  `signalwire.*` audit rows), sip list/endpoints(password generated if blank, **returned once**,
  never audited)/gateways/routes, e911 addresses list/create/assign(`confirm:true`), lookup.
  **PUBLIC** `POST|GET /webhooks/signalwire/sms` and `POST /webhooks/signalwire/sms-status` — on
  the JWT bypass list, signature-verified, fail closed, refusals audited (throttled to 30/h so an
  unsigned flood cannot fill the table). Inbound answers an empty cXML `<Response/>` (no auto-reply).
  Every mutating action and every webhook → `AgentAuditLog` `signalwire.*` (never a module
  variable). Webhook base URL: the portal passes `window.location.origin` (`resolvePublicApiBase`
  trusts only an https origin, else env, else the primary hostname) — the two-hostnames rule.
- **Portal `/apps/signalwire`** — credentials + connection readout (numbers scope / messaging
  reachable / project status / subprojects), the two webhook URLs to paste, number search →
  Buy (browser confirm), owned numbers table (texts-to-Loopcom tag + "Point at Loopcom", "Ring a
  SIP endpoint…" picker, E911 status, Release), Send a text (from = owned number) + "Check now",
  SIP: create endpoint (shows registrar/username/password ONCE with a PBX PJSIP-trunk recipe),
  create gateway (`user@pbx-host`), point a number at a gateway/endpoint, E911: validate address
  + register on a number, CNAM lookup, event log (polls every 10 s while visible), and a static
  "how it compares to VoIP.ms" panel. Nav item `apps.signalwire` under Apps, **forced SUPER_ADMIN**
  in `isNavItemVisibleForUser` (the `pbx.ivr_migration` pattern) — there is deliberately no
  grantable key.

## 5. Tests (18, `apps/api/src/signalwire/signalWire.test.ts`, glob registered in `apps/api/package.json`)

Pure: space-URL normalisation, credential shape refusals, **the Twilio reference signature vector**
(`0/KCTR6DLpKmkAf8muzZqo1nDgQ=`), fail-closed webhook auth (no key / no sig / tampered body /
wrong URL then right URL), public-URL rebuild. Fake-fetch client: per-family URLs, error
classification, search query + capability mapping (array and object shapes), Compatibility form
body for SMS, **purchase sends exactly one request on timeout**, SIP endpoint Fabric→legacy only
on 404 (a 403 must not fall back), connection check is GET-only and separates numbers-OK from
messaging-refused. Source guards: both webhook paths bypass JWT and no admin path does,
`server.ts` import + registration with `requireSuperAdmin` + the permission rule, every admin
route opens with `requireOwner`, the module never touches VoIP.ms/TenantSmsNumber/onboarding/
integrations and never `console.log`s, no audit call carries a password/token/signing key, nav
item exists and is SUPER_ADMIN-forced. **Proven non-vacuous:** the server.ts, bypass-list and nav
guards read **0** hits against `HEAD`. Neighbours green: `publicReadyJwtBypass`,
`deployReadinessJwtBypass`, `adminRouteTenantScope`, `internalSecret`, `nodeEnvGates`,
`dependencyHygiene` (55/55). api typecheck **75 = the exact baseline**, portal **0**;
`navAuthoritativeWiring` 3/3.

⛔ Two test-authoring traps hit and fixed: (1) a comment-stripper (`/\*[\s\S]*?\*/`) applied to
`server.ts` opens a fake block comment at a regex literal and swallows the registration — do
positive matches on the raw file; (2) `assert.match` on a 1.8 MB string prints the whole file on
failure — use `assert.ok(re.test(s), msg)`.

## 6. How to test it (the acceptance list — nothing has been proven live yet)

Owner account, `/apps/signalwire`. In this order, cheapest first:
1. **Credentials.** SignalWire dashboard → project → API → make a token with Numbers +
   Messaging + Calling scopes; copy the signing key from the same page. Save. Expect the pill
   `connected · <project name>` and "Numbers API working; messaging API working". A 403 with
   "missing a scope" means the token was made without one.
2. **Search 845.** Expect rows within a second or two. Then a sold-out code (try 212) — expect
   the honest "SignalWire has nothing for local in 212" line, not an error.
3. **Buy one number** (⛔ real money, monthly). Confirm. It should appear under "On the account"
   with the "Loopcom" texts tag. **Read the price off SignalWire's dashboard/invoice** — it is not
   published, and this is the first number we would know the real cost of.
4. **Inbound text.** Text the new number from a phone. Within ~10 s an `inbound_sms` row should
   appear in "What happened". If instead `webhook_refused reason=no_signing_key`, paste the signing
   key; if `signature_mismatch`, the URL SignalWire called differs from the one we think we
   published — compare the number's `message_request_url` on SignalWire with the "Where SignalWire
   reaches Loopcom" box.
5. **Outbound text** to a real phone. Expect "accepted as queued", then `sms_status` rows
   (`sent` → `delivered`). ⛔ **On an unregistered local number the likely result is `undelivered`
   / a 30007-class error — that is 10DLC, not a bug.** A trial account only delivers to verified
   numbers. Toll-free needs their verification form first.
6. **SIP endpoint.** Create `loopcom-pbx`, send-as = the bought number. Copy the password. On
   the PBX (⛔ a PBX write — Izzy's mandate, done in the panel like every other trunk): a PJSIP
   trunk with host = `<space>.sip.signalwire.com`, username/password from the page, from-domain =
   the registrar, registration on, ulaw/alaw/g722. Then from the page pick "Ring a SIP endpoint…"
   on the number and CALL IT. Then dial out through the trunk. That is the inbound+outbound proof.
   Alternatively **SIP gateway** `signalwire@m.connectcomunications.com` + "Point it" — no
   registration; needs the PBX to accept INVITEs from SignalWire's (unpublished) source IPs by
   domain, and the DID must be routable from what arrives in the To header.
7. **E911.** Validate a real customer address (expect Monsey → SPRING VALLEY correction), register
   it on the number, dial **933** from the trunk. ⛔ Never 911.
8. **Lookup** any number — proves the relay lookup surface and CNAM data quality.
9. **Release** the test number when done (⛔ trial accounts lock releases for 30 days).

## 7. Deploy state

- api: queue job `beacf3f9`, **success, deployed_commit `50f9fa69`**, container-verified
  2026-08-18 ~20:04 ET: `/app/.build-commit` reads `50f9fa69`, `apps/api/src/signalwire/*`
  present in the image, `server.ts` registers the routes. Live probes: `GET
  /admin/apps/signalwire/status` without a JWT → 401 (the hook — reachable); `POST
  /webhooks/signalwire/sms` and `/sms-status` unsigned → `401 {"error":"unauthorized",
  "reason":"no_signing_key"}` — the HANDLER's own refusal, on `127.0.0.1:3001` AND from
  outside on both `app.connectcomunications.com` and `app.loopcom.net` (so nginx passes the
  path and the fail-closed gate is what answers); each probe wrote a
  `signalwire.webhook_refused` row to `AgentAuditLog`. `/health` 200 throughout.
- portal: queue job `d8a1abd7`, **success, deployed_commit `9c54cfea`** (the branch tip had
  moved — another session's docs commit — and `50f9fa69` is its ancestor). Container-verified:
  `/app/.build-commit` = `9c54cfea`, the `(platform)/apps/signalwire/page.js` server chunk is
  in `.next`, a client chunk carries `admin/apps/signalwire/status`, and `apps.signalwire` is in
  the nav bundle. ⛔ An already-open tab or desktop window keeps the OLD bundle until reloaded.

## 8. What a real cut-over would need (NOT started — decisions for Izzy)

1. **10DLC** — register Loopcom's brand + a campaign on SignalWire (API exists) BEFORE moving any
   customer's texting; assign each moved number to the campaign. Budget the fees and the 3–5 day
   lead time. Or keep local-number texting on VoIP.ms and use SignalWire for voice only.
2. **Porting** — no API. Either ports stay on VoIP.ms (numbers then need to be moved carrier→
   carrier afterwards, i.e. a second port) or the port automation is rebuilt around SignalWire's
   portal / support tickets.
3. **Caller ID** — every tenant's outbound route CID must be a SignalWire-owned (or verified)
   number; audit the four tenants whose first profile carries another company's CID first
   (emergency-calling handoff).
4. **Schema** — `TenantSmsNumber.provider` needs `SIGNALWIRE` (enum migration), the worker's
   `connectChatSmsJob` / `voipMsInboundSyncJob` need a per-number provider switch (inbound on
   SignalWire is a WEBHOOK, not a poll — the webhook path here becomes the real ingest), and
   `billingSmsSender` / `agentEscalationDispatch` need a provider choice for (845) 723-1213.
5. **PBX trunk** — `pbxTenantBuild.ts createTrunk` gets a SignalWire variant (registrar +
   endpoint credentials from `createSipEndpoint`, one endpoint per tenant, `send_as` = the
   tenant's number) — the same shape as the VoIP.ms subaccount, so the panel replay stays.
6. **E911** — `voipMsE911.ts` gets a sibling; the correction loop already exists conceptually.
7. **Subprojects** — decide whether one project per customer is worth it (isolation) given the
   shared balance and no per-project billing API.

## 9. Open / not proven

- ⏳ **Nothing has been exercised against a real SignalWire account.** No credentials exist in
  the store; every route was proven by fake-fetch tests and source guards only. Prices, the
  Fabric-vs-legacy SIP endpoint answer, gateway auth/IP behaviour and the exact webhook signing
  behaviour are all things the first real session on the page will settle.
- ⚠️ SignalWire's docs describe `X-SignalWire-Signature` as validated with the **signing key**
  via their Twilio-compatible validator; the algorithm was inferred from that parity and the
  vector test uses Twilio's published example. If a real inbound text is refused with
  `signature_mismatch` on a correct URL, try the API token as the key (some older SignalWire
  guides used it) — one-line change in `webhookGate` (`creds.signingKey` → try both).
- ⏳ 10DLC registration, porting, CNAM ticketing and subproject creation are NOT on the page.

---

## 10. THE FIRST REAL TRUNK IS LIVE — +1 (205) 351-3327 rings Loopcom Demo ext 101 through SignalWire (2026-08-18, evening)

Izzy, 2026-08-18: *"create a trunk for that phone number that's currently in SignalWire"* …
*"it's not going to be the same way that we're doing the VoIP.ms trunks, so open the
browser … and check how we're supposed to set up this trunk."* He was right, in one specific
way (§10.3). Everything below is **PBX writes under that explicit instruction**, all logged as
`signalwire.*` audit rows, all with backups named here.

### 10.1 What SignalWire's own docs say the trunk is
Read in the browser before touching anything: `/docs/platform/voice/sip/trunking`,
`/docs/platform/freepbx`, `/docs/platform/voice/sip/sip-credentials` and the blog "The Best Way
to Use SignalWire for SIP Trunking with Asterisk or FreePBX".
- A trunk = a **SIP credential the PBX REGISTERS with** at the Space's SIP domain — the same
  shape as the VoIP.ms subaccount, so VitalPBX's registered PJSIP trunk form fits.
- ⛔ **The registrar is the SIP PROFILE's `domain`, not `<space>.sip.signalwire.com`.**
  `GET /api/relay/rest/sip_profile` → `loopcom-ef2ea3442802.sip.signalwire.com` (space +
  `domain_identifier`). The console guessed the short form until `8d3dfd04`; the guess registers
  nothing and reads exactly like a bad password.
- Inbound calls "arrive from a number of different IP addresses" — identify by domain / the
  registration, never by a single IP. In practice VitalPBX's `line=yes` on the registration did
  it: SignalWire INVITEs the registered Contact **with the `;line=` parameter**, so PJSIP ties
  the request to the endpoint whatever the source address (152.42.144.114 today).
- ⛔ **The DID is in the `To:` header and the request-URI user is literally `s`** — the
  FreePBX guide's whole custom context is `[from-signalwire] exten => s` extracting the number
  from `To`. That is the one place VitalPBX and SignalWire genuinely disagree (§10.3).
- Encryption: their guide sets the endpoint to Required + SRTP; the profile default is
  `optional`. The trunk was built plain (RTP over UDP 5060, endpoint `optional`) to match how
  every other trunk on this PBX runs; SRTP is a follow-up.

### 10.2 What was built, in order
1. **SignalWire** (`sw-build-trunk.ts` run in the api container, via the module's own client):
   Fabric SIP endpoint **`loopcom-pbx`** id `d70efe1e-8620-4e33-ac78-249cee8e3a47`
   (`call_handler passthrough` = may dial the PSTN, `send_as +12053513327`, codecs
   PCMU/PCMA/G722, encryption optional; password generated, travelled to SignalWire and to the
   panel form only, never printed or stored). Number **+12053513327**
   (id `6dc9dc7e-d2f8-4293-997a-8283ecffe783`) pointed at it with
   `POST /api/fabric/resources/{ep}/phone_routes {phone_route_id, handler:"calling"}` — the
   Fabric route worked first try, no fallback needed.
2. **VitalPBX trunk 132 "SignalWire loopcom-pbx"** in Main — panel replay with the SAME field
   set onboarding's `createTrunk` posts (so it renders like every VoIP.ms trunk), differences:
   `outgoing[host]/[match]/[fromdomain]` = the profile domain, `outgoing[username]/[defaultuser]/
   [fromuser]/[contact_header]` = `loopcom-pbx`, `codecs[]` ulaw/alaw/g722, `get_did_from=to`
   (harmless — see §10.3, the generated "Build DID from headers" branch is never reached).
   Rendered as `[loopcom-pbx]` endpoint/auth/aor + `identify match=<domain>` (resolves to
   159.65.244.171 + 152.42.144.114) + `registration … line=yes`, inbound `context=trk-132-in`.
   Apply Changes (18 s) → **`pjsip show registrations`: `Registered (exp. 574s)`**, contact
   `Avail` at 40 ms. Re-bake on T2/T35/T105 afterwards: **0 lines changed** — the apply did not
   wipe the doorway (nothing was pending on those tenants at that moment).
3. **Tenant DID**: `INSERT INTO ombutel.ombu_tenant_dids (102,'2053513327','SignalWire test')`
   from `/root/sw-tenant-did-102.sql`, backup `/root/ombu_tenant_dids-backup-20260819T012113Z.sql`
   on the PBX. ⛔ **`default-trunk` in Main is generated from this table** (`exten =>
   _2053513327 → Forwarding call to Loopcom Demo tenant`); an inbound route alone does NOT get a
   DID into the tenant. And ⛔ **a direct DB write is not a "pending change" — the panel's Apply
   in Main regenerated nothing (0.4 s, file mtime unchanged) until the tenants module was queued
   the way the PBX helper does it**: `INSERT IGNORE INTO ombu_queued_changes (tenant_id,
   module_id) VALUES (1, 99)` (99 = tenants) + `UPDATE ombu_settings SET value='yes' WHERE
   name='reload_dialplan'` (`/root/sw-queue-main-tenants.sql`), then Apply in Main context
   (`cfg.mainTenant` = `2dc3974017c1bc65`, 1.9 s, `default-trunk` rendered).
4. **Inbound route** in T102 (`9b501d62d63478a9`): `createInboundRoute(session, "2053513327",
   extensionId("101") = 395, "SignalWire 2053513327")` → route id **244** → ext 101, applied in
   T102 context (T102 file rendered `_2053513327 INBOUND_ROUTE: SignalWire 2053513327`).
   Re-bake after every apply: **0 lines changed** each time; T2 1/0, T35 1/0, T105 2/0
   throughout.
5. **The `s` handler** — appended to `/etc/asterisk/extensions__60_custom.conf` (backup
   `extensions__60_custom.conf.bak.signalwire-trunk.20260819T012xxxZ`), then `dialplan reload`:
   `[trk-132-in](+)` / `exten => s,1,NoOp(Incoming call through: SignalWire loopcom-pbx (DID from To))`
   → set `__TRUNK_ID=132`, `CDR(trunk)=132` → `SWDID = FILTER(0-9, user part of To)` → strip a
   leading `1` when 11 digits → set `__DID_NUMBER`, `CDR(did)`, `DID` → if 10 digits
   `Goto(default-trunk,${SWDID},1)` else `Hangup(1)`. `(+)` extends the generated context (the
   custom file is `#include`d after `vitalpbx/extensions__*.conf`), so it survives every regen.
   Verified with `dialplan show trk-132-in`: exten `s` (11 priorities from the custom file)
   beside the generated pattern.

### 10.3 The bug that would have hidden forever behind "it registers": 484 Address Incomplete
First test call (PBX → trunk → SignalWire → hairpin back): SignalWire's INVITE was
`INVITE sip:s@209.145.60.79:5060;line=uuklawl` with `To: <sip:+12053513327@loopcom-ef2ea…>`.
VitalPBX's generated `[trk-132-in]` has only `_[+*#0-9A-Za-z].` — a **2+ character** pattern —
so a bare `s` *half-matched* it and Asterisk answered **`484 Address Incomplete`** (proven with
`pjsip set logger host 152.42.144.114`; SignalWire then retried from four different media
nodes, ~1.5 s apart, each 484). No channel is created and **nothing is logged at NOTICE**, so
without the SIP trace this reads as "the call just doesn't arrive". `get_did_from=to` cannot help
because the generated "Build DID from headers" lines sit INSIDE that pattern branch. Hence the
exact `exten => s` above, which wins over the pattern.
⛔ **VoIP.ms puts the DID in the request URI; SignalWire does not.** Every future SignalWire
trunk on VitalPBX needs its own `[trk-N-in](+) exten => s` block (or a shared one, if
several trunks are built — a follow-up), and the DID on the tenant as **10 digits**.
⛔ Also learned: `parseFormPairs()` omits checkboxes whose state VitalPBX sets by JS — trunk
132's edit form reads `outgoing[type]`/`[trunk]`/`[qualify]` as ABSENT — so a full-form
re-post of a trunk (or tenant) can silently untick them. Trunk 132 was therefore never edited;
the DID went in by SQL + queued regen instead.

### 10.4 Proven, with a real call
`channel originate PJSIP/+12053513327@loopcom-pbx application Playback demo-congrats` (PBX
dials its own SignalWire number through the trunk; SignalWire routes the number to the endpoint
and pushes it back — both directions in one call, rings nobody outside):
`s@trk-132-in` → `SWDID=12053513327` → `2053513327` → `default-trunk: Forwarding call to
Loopcom Demo tenant` → `T102_default-trunk` → `T102_incoming-calls: INBOUND_ROUTE: SignalWire
2053513327` → **`Dial(PJSIP/T102_101&Local/T102_101_1@connect-mobile-wake-dial/n,30,…)` ringing
ext 101** (desk + wake-dial leg). Caller ID delivered as `+12053513327`. Hung up by hand after
~28 s; CDR rows `+12053513327 → 101 / T102_101_1, NO ANSWER, 28 s`. Outbound worked implicitly
(SignalWire accepted and completed the PBX's INVITE — `passthrough`, `send_as` = the number).

### 10.5 What is NOT done / not proven
- ⏳ **No human has heard audio on it** — the proof is signalling + dialplan, not a two-way
  conversation. Acceptance: call **(205) 351-3327** from any phone → Loopcom Demo ext 101 must
  ring; answer and talk both ways. Then dial out from ext 101 through the trunk — ⛔ **no
  outbound route / ARS selection points at trunk 132 yet**, so today no tenant dials out via
  SignalWire; that is a route + route-selection change (Main), same shape as onboarding's
  `createOutboundRoute` + ARS.
- ⏳ SRTP/TLS not enabled (plain, like every other trunk here). ⏳ E911 not registered on the
  number (an unregistered 911 call costs $100 at SignalWire — dial 933, never 911, from this
  trunk). ⏳ Texting on the number is pointed at Loopcom's webhook but no 10DLC campaign exists,
  so outbound texts will be `undelivered`.
- ⚠️ **Pre-existing, noticed in passing:** `ombu_queued_changes` holds pending rows for tenants
  2, 3, 4, 5, … (modules 42/43/110) and `T2_reload_dialplan=yes` — somebody's saved-but-not-
  applied panel edits. The next Apply in one of those tenants' contexts flushes them (T2 is a
  Connect-mode tenant → doorway wipe → the reconciler / re-bake covers). Not touched.
- ⚠️ `agentProvisioning/addPhoneNumberCapability.ts` passes `pbxTenantId` ("102") to
  `session.setTenant()`, which expects the tenant PATH HASH (`9b501d62d63478a9`). Never proven
  live; likely a latent bug in that (unrelated) path.

### 10.6 Rollback
Reverse order, all local to this test: delete inbound route 244 in T102 (panel);
`DELETE FROM ombutel.ombu_tenant_dids WHERE tenant_id=102 AND did='2053513327'` (or restore
`/root/ombu_tenant_dids-backup-20260819T012113Z.sql`); queue tenants for Main + apply; delete
trunk 132 (panel) + apply; restore `extensions__60_custom.conf` from the `.bak.signalwire-trunk.*`
copy + `dialplan reload`; then on SignalWire delete the phone route / endpoint `d70efe1e-…`
(dashboard or `DELETE /api/fabric/resources/{id}`). Every apply → re-bake the Connect doorway
(`rebakeConnectRoutesAfterRegen`) for T2/T35/T105.
