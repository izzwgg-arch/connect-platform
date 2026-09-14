# ⛔⛔ AGENT HANDOFF — SignalWire is being EVALUATED to replace VoIP.ms: a test bench exists at `/apps/signalwire`, and the FIRST REAL TRUNK IS LIVE — (205) 351-3327 rings Loopcom Demo ext 101 (2026-08-18) — READ FIRST before touching `apps/api/src/signalwire/*`, PBX trunk 132, `[trk-132-in](+)` in `extensions__60_custom.conf`, before wiring ANY carrier path away from VoIP.ms, or before answering "can SignalWire do X?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SIGNALWIRE_PIVOT_2026-08-18.md`**
(`50f9fa69` on `feat/ivr-migration-takeover`, private-index commit. **api DEPLOYED and
container-verified** — `/app/.build-commit` = `50f9fa69`, the module is in the image,
`server.ts` registers it, and from OUTSIDE both hostnames answer `POST
/api/webhooks/signalwire/sms` with the HANDLER's own `401 {"reason":"no_signing_key"}`
(live + fail-closed through nginx), each refusal landing as a `signalwire.webhook_refused`
audit row. **portal DEPLOYED and bundle-verified** (queue job `d8a1abd7`, container
`9c54cfea` ⊇ `50f9fa69`; the `/apps/signalwire` page chunk and the `apps.signalwire`
nav item are in the shipped `.next`). No migration, no PBX write, no env change, no
tenant row touched, no VoIP.ms path touched, and **no SignalWire account touched —
nobody has typed credentials in yet.** ⛔ An already-open portal tab or desktop window
keeps the OLD bundle until reloaded.) Memory: [[signalwire-test-bench-built]].
Izzy, 2026-08-18: *"I want to start pivoting away from voip.ms … set this up and test it
to see if this would be the ideal replacement … build this inside Loopcom."*

- ✅✅ **THE FIRST REAL TRUNK IS LIVE AND PROVEN WITH A CALL (2026-08-18 evening, handoff §10)
  — Izzy: *"create a trunk for that phone number … it's not going to be the same way that we're
  doing the VoIP.ms trunks, open the browser and check how we're supposed to set up this trunk."*
  He was right.** SignalWire endpoint **`loopcom-pbx`** (Fabric, `passthrough`, `send_as
  +12053513327`) ← number **+12053513327** routed to it via `phone_routes`; **VitalPBX trunk
  132 "SignalWire loopcom-pbx"** in Main (panel replay, onboarding's `createTrunk` field set,
  ulaw/alaw/g722) → **`Registered`**, contact `Avail` 40 ms; DID `2053513327` on **Loopcom Demo
  (T102)** + inbound route **244 → ext 101**. Test call (PBX → trunk → SignalWire → back in) ran
  the whole chain and **rang ext 101** (desk + wake-dial); every apply was followed by a doorway
  re-bake (0 lines changed each time; T2/T35/T105 stayed 1/0, 1/0, 2/0). ⏳ Nobody has heard
  audio on it — acceptance is one real call to **(205) 351-3327**. ⛔ No outbound route/ARS
  points at trunk 132 yet, so no tenant dials OUT via SignalWire.
- ✅ **OUTBOUND TOO (later the same evening): Loopcom Demo's outbound route 123 now has ONLY
  trunk 132** (panel edit re-post, `trklist[]` 127 → 132, CID line byte-identical
  `"Loopcom Demo" <3479780090>`; backup `/root/ombu_outbound_routes-backup-20260819T015146Z.sql`).
  Proven from inside T102's class of service: `Outbound Route: Loopcom Demo → trk-132 →
  Dial(PJSIP/2053513327@loopcom-pbx)` → SignalWire → back in → ext 101 ringing.
  ⛔ **The far end received caller ID `+12053513327`, not 3479780090** — SignalWire swaps in
  the endpoint's `send_as` because 347-978-0090 is not on the account (the "no arbitrary CID"
  rule, seen live). Verify 3479780090 as a Verified Caller ID on the Space, or accept the 205
  number — Izzy's call. Trunk 127 (VoIP.ms) is still on the PBX, unused by T102.
- ⛔⛔ **A FOURTH PIVOT-DECIDING FACT, seen live: SignalWire signs outbound calls at
  STIR/SHAKEN attestation C BY DEFAULT — even from its own numbers.** Izzy checked the real
  calls from ext 102 through trunk 132: **C**, "carriers are filtering it". Their doc: *"By
  default, all outbound calls from phone numbers bought on the SignalWire platform receive
  attestation level C. Levels A and B … require a vetting process … create a support ticket."*
  Not the 347 caller ID, not the trunk config. VoIP.ms is community-reported to sign **A** for
  account DIDs — so moving a tenant's outbound to SignalWire today DOWNGRADES it A → C (Spam
  Likely). **Open the vetting ticket first; keep tenant outbound on VoIP.ms until A is granted.**
  T102 stays on trunk 132 as the test bed knowingly.
- ⛔⛔ **THE TWO WAYS A SIGNALWIRE TRUNK IS NOT A VOIP.MS TRUNK, both proven live:**
  (1) **the registrar is the SIP PROFILE's domain** — `GET /api/relay/rest/sip_profile` →
  `loopcom-ef2ea3442802.sip.signalwire.com`, NOT `loopcom.sip.signalwire.com` (the console
  guessed that until `8d3dfd04`; a guess registers nothing and reads like a bad password).
  (2) **SignalWire delivers inbound calls with request-URI user `s` and the DID ONLY in `To:`**
  (`INVITE sip:s@pbx;line=…`, `To: <sip:+12053513327@…>`) — VitalPBX's generated `trk-N-in`
  has only a 2+-char pattern, so a bare `s` half-matches and Asterisk answers **484 Address
  Incomplete with NO channel and NO log line**; SignalWire retries from four nodes and gives up.
  It reads as "the call never arrives". Fix = `[trk-132-in](+) exten => s` in
  `/etc/asterisk/extensions__60_custom.conf` (backup `.bak.signalwire-trunk.*`) that lifts the
  DID out of `To`, strips `+1`, and `Goto(default-trunk,<10 digits>,1)`. **Every future
  SignalWire trunk on this PBX needs that block** (VoIP.ms puts the DID in the request URI;
  SignalWire does not). ⛔ `line=yes` on the registration is what identifies the inbound INVITE
  regardless of source IP — SignalWire INVITEs the registered Contact with the `;line=` param.
- ⛔ **Two panel/regen traps hit on the way, both worth carrying:** `default-trunk` (Main) is
  generated from **`ombu_tenant_dids`**, so a DID must be on the tenant's list, not just on an
  inbound route — and **a direct DB write is not a "pending change": Apply in Main regenerated
  NOTHING (0.4 s) until `ombu_queued_changes (1, 99)` + `reload_dialplan=yes` were set the way
  the PBX helper does it.** And `parseFormPairs()` omits checkboxes VitalPBX ticks by JS
  (`outgoing[type]/[trunk]/[qualify]` read as absent on trunk 132's edit form) — **a full-form
  re-post of a trunk or tenant can silently untick them**; trunk 132 was never edited.
- ⚠️ Noticed, NOT touched: `ombu_queued_changes` holds pending rows for tenants 2, 3, 4, 5, …
  (modules 42/43/110) and `T2_reload_dialplan=yes` — somebody's unapplied panel edits; the next
  apply in those contexts flushes them (T2 = doorway wipe → re-bake/reconciler). And
  `addPhoneNumberCapability.ts` passes `pbxTenantId` where `setTenant()` wants the tenant PATH
  hash — a latent bug in that never-proven path.
- ⛔⛔ **IT IS A TEST BENCH, NOT A CUT-OVER.** Every job VoIP.ms does today has a panel
  on `/apps/signalwire` (SUPER_ADMIN only, forced in `isNavItemVisibleForUser` like IVR
  Migration — no grantable key) that does the same job on SignalWire, with every action
  and every inbound webhook written to `AgentAuditLog` `signalwire.*` as the record.
  **Nothing is wired into onboarding, chat, billing SMS, the worker or the PBX**, and a
  source guard in `signalWire.test.ts` fails if the module ever references
  `globalVoipMsConfig` / `voipMs*` / `tenantSmsNumber` / `onboarding/` /
  `@connect/integrations`. A number bought there rings nothing until a person wires it.
- ⛔⛔ **THE THREE FACTS THAT DECIDE THE PIVOT, all read from their docs, none of them a
  code problem:** (1) **10DLC brand + campaign registration is MANDATORY** to text from a
  local US number on SignalWire — unregistered traffic is refused; VoIP.ms does not enforce
  this on us today ($4 brand, campaign fee 3 months up front, 3–5 business days; an API
  exists, not built). (2) **Porting has NO API** — dashboard + LOA only, so `portWatchdog` /
  `portLanding` automation would have to be rebuilt around their portal or ports stay on
  VoIP.ms. (3) **Arbitrary outbound caller ID is NOT allowed** — `send_as` must be a
  purchased or verified number, and four tenants send another company's CID today.
  ⚠️ Local-number and per-segment SMS **prices are not on their public pricing page** — read
  them off the first purchase. Voice ~0.66¢/min in, 0.8¢/min out.
- ✅ **What SignalWire DOES have, and the bench uses:** one credential (Project ID + API
  token, HTTP Basic, scoped — a 403 means a missing scope and the page says so) over THREE
  API families: `/api/relay/rest` (number search/buy/list/release/handlers, E911 addresses +
  per-number registration with 422 corrections like Monsey → SPRING VALLEY, CNAM lookup),
  `/api/fabric` (SIP endpoints the PBX registers with = the subaccount analogue, SIP gateways
  that PUSH inbound to the PBX with no registration, phone routes), and the Twilio-shaped
  Compatibility API for SMS send + the inbound/status webhook contract. Subprojects exist
  (one per customer possible) but share one balance.
- ⛔ **Credentials live in `AgentSecret` key `signalwire_credentials`** (Space URL, Project
  ID, API token, signing key), encrypted like the ElevenLabs/Polly keys — deliberately no new
  Prisma model, an evaluation must not cost a migration. Token + signing key are write-only.
- ⛔ **The two public webhooks (`/webhooks/signalwire/sms`, `/sms-status`) verify
  `X-SignalWire-Signature` (Twilio HMAC-SHA1 scheme keyed with the project SIGNING KEY) and
  FAIL CLOSED** — no key = every inbound text refused with `webhook_refused reason=no_signing_key`
  in the event log. Refusal rows are throttled to 30/h. If a correct URL still reads
  `signature_mismatch`, SignalWire may be signing with the API token — one-line change in
  `webhookGate` to try both. ⛔ The URL SignalWire signed is the PUBLIC one; the portal passes
  `window.location.origin` so a console on `app.loopcom.net` registers loopcom webhooks
  (the two-hostnames rule); `resolvePublicApiBase` trusts only an https origin.
- ⛔ **A purchase is NEVER retried** — a timeout answers "may have gone through, refresh the
  list before trying again". A generated SIP endpoint password is returned ONCE and never
  stored or audited (a test greps every audit call). `createSipEndpoint` tries Fabric first
  and falls back to the deprecated `/api/relay/rest/endpoints/sip` only on 404, reporting
  `via` — a 403 must NOT fall back (a test pins it).
- **Tests: 18** (Twilio signature reference vector, fail-closed auth, fake-fetch client incl.
  one-request purchase, source guards on `server.ts` registration + permission rule + bypass
  list + every admin route opening with `requireOwner` + the module's no-VoIP.ms promise +
  the nav force). **Proven non-vacuous: server.ts, bypass and nav guards read 0 against
  `HEAD`.** api typecheck **75 = the exact baseline**, portal **0**; neighbours 55/55.
  ⛔ Two authoring traps: a comment-stripper applied to `server.ts` opens a fake block
  comment at a regex literal and swallows the registration — do positive matches on the raw
  file; and `assert.match` on a 1.8 MB string prints the whole file on failure.
- ⏳ **NOT PROVEN: nothing has been exercised against a real SignalWire account.** The
  acceptance list is §6 of the handoff, cheapest first: creds (Numbers + Messaging + Calling
  scopes) → search 845 (then 212 for the honest empty) → buy ONE number (⛔ real money — and
  the first time we learn the price) → text it from a phone (`inbound_sms` within ~10 s) →
  text out (⛔ `undelivered` on an unregistered local number is 10DLC, not a bug) → create a
  SIP endpoint, build the PJSIP trunk on the PBX from the recipe on the page (⛔ PBX write,
  Izzy's mandate) → "Ring a SIP endpoint…" and call it, dial out → E911 address + register →
  dial **933**, never 911 → release the number.
- ⏳ **What a real cut-over would need (§8, NOT started, Izzy's decisions):** 10DLC first;
  a porting answer; a caller-ID audit; `TenantSmsNumber.provider = SIGNALWIRE` migration +
  worker switch (inbound is a WEBHOOK on SignalWire vs a POLL on VoIP.ms); a
  `pbxTenantBuild.createTrunk` SignalWire variant; a `voipMsE911.ts` sibling; whether to use
  subprojects.
