# ⛔⛔ AGENT HANDOFF — tenant isolation audit: the ROUTES are fine, the SECRETS are empty (2026-08-17) — READ FIRST before adding any `/internal/*` door, any signed URL, any `requireAdmin` route, or before assuming a shared secret is actually set

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full findings: **`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md`**
(**Read-only audit — no code changed, nothing deployed, no PBX interaction, and
no cross-tenant request was ever sent to production.** 1,016 routes across 62
files, plus the JWT bypass list, the permission resolver and every signed-URL
scheme.
⛔⛔ **SUPERSEDED — ALL FIVE CRITICALS BELOW ARE NOW FIXED. Read the two
remediation sections instead: `§0b` (the `/internal/*` door, 2026-08-18) and
`§0c` (the other four, 2026-08-18), both summarised in their own CLAUDE.md
sections further down. The bullets below are kept ONLY because each records the
mechanism and the rule it earned — do not read them as live findings.** The
medium/low items §6a–§6l ARE still open.)

- ⛔⛔ **THE RULE: per-route tenant scoping in this codebase is GOOD — the bugs
  are in the layers around it.** `findFirst({ id, tenantId })` is applied
  consistently and the classic IDOR essentially does not exist on the
  tenant-facing surface (billing, CRM, voicemail, recordings, contacts, chat
  threads, IVR, MOH, DID, delivery, remote support and the agent gates all check
  out — §7 of the handoff lists what was cleared, and that list matters).
  **Four of the five criticals are invisible if you only read route bodies.**
  **Check the env the guard reads, and check which roles the gate admits.**
- ⛔⛔ **`CDR_INGEST_SECRET` IS EMPTY IN PRODUCTION AND ELEVEN `/internal/*`
  DOORS FAIL OPEN.** Proven by `docker exec` (`defined: true, trimmedLength: 0`);
  it is in **no** env file, and compose passes `${CDR_INGEST_SECRET:-}`. Those
  paths are all in `shouldSkipJwtVerification`, and nginx proxies `/api/` with
  **no path exclusion on either hostname** — so
  `https://app.connectcomunications.com/api/internal/telephony/pbx-tenant-map`
  hands an anonymous caller **the entire tenant directory**, and
  `/api/internal/cdr-ingest` lets them **write calls into any tenant's history**.
  ⛔ `verifyCdrSecret` (`server.ts:18267`) literally reads
  `if (!secret) return true; // not configured → allow`. **`agentMohSecretOk` and
  `billingPayToken.ts` both do this correctly — copy those, not these.**
- ⛔⛔ **THE VOIP.MS INBOUND SMS WEBHOOK IS COMPLETELY UNAUTHENTICATED.**
  `connectChatRoutes.ts:2230` sets `authorized = !cfg.webhookSecretEncrypted`,
  and the 401 at `:2243` is **itself gated on the secret existing**. Confirmed
  live: `GlobalVoipMsConfig(id="default")` exists with `webhookSecretEncrypted`
  **null**. So anyone who knows a customer's public phone number can POST a
  message that lands **in that customer's SMS inbox, from any sender they trust**,
  with push notifications fanned out and a CRM timeline entry written. This is
  the single most abusable finding — a phishing channel into a customer's own
  staff. ⛔ Inverting the default alone stops real inbound SMS; the secret must
  be set too.
- ⛔⛔ **EVERY SIGNED DOWNLOAD URL IS FORGEABLE, TWO DIFFERENT WAYS.**
  (1) `chatSignedUrl.ts:37` and `:97` use **`createHash`, not `createHmac`** —
  **no key at all** — while its three siblings in the same file use `createHmac`;
  and `GET /chat/attachments/download/*` deliberately falls back to that scheme
  after an unscoped `storageKey` lookup. `GET /chat/threads/:id/messages` hands
  every caller all three inputs, so any user can mint a **permanent,
  self-renewing, unauthenticated** URL. (2) Five helpers share one `||` chain
  whose every variable is EMPTY or UNDEFINED in production, so they all resolve
  to the literal **`"dev-signing-secret"`** — which is in this repo. ⛔ **`""` is
  falsy, so a variable "set" to blank falls silently through to the next.** Worst
  landing: `GET /chat/a/:attachmentId` is JWT-bypassed **and** does an unscoped
  `findUnique`, so the HMAC is the only thing standing there.
- ⛔ **`TENANT_ADMIN` REACHES `/admin/*` ROUTES WRITTEN FOR A PLATFORM ADMIN.**
  `requireAdmin` admits it, and the live permission snapshot grants the
  TENANT_ADMIN bucket **`can_view_admin_tenants`** — so the preHandler passes
  too. `GET /admin/tenants` (`server.ts:8653`) returns **every tenant on the
  platform** and `PATCH /admin/tenants/:id` (`:8718`) **writes** `isApproved` /
  `dailySmsCap` on **any other customer**. `GET /admin/wake-health` (`:5326`)
  has **no permission-map entry at all** and returns every Android device with
  its user's **email address**. Live blast radius: **8 ACTIVE TENANT_ADMIN
  accounts in 8 different real customer tenants.** ⛔ **`requireAdmin` ≠
  `requireSuperAdmin` — check which one a `/admin/*` handler uses before trusting
  that it can only be reached by us.**
- ⛔ **ANYONE CAN CREATE APPROVED TENANTS AND INVOICES, UNAUTHENTICATED.**
  `onboarding/publicRoutes.ts:61`'s `canLazyCreate()` is `!isProduction()`, and
  **`NODE_ENV` is UNDEFINED in `app-api-1`** — the class this file already
  records, and it names this exact line. `PUT /api/onboarding/<anything>/save`
  creates a submission with unvalidated `answers`; `…/checkout` then runs
  `tenant.create({ kind:"CUSTOMER", isApproved: true })` plus a `BillingInvoice`.
  ⛔ **Do NOT fix by setting `NODE_ENV=production` on the container.**
- **Sized against production, read-only** (so nobody re-derives it): 50 tenants /
  29 live; 8 TENANT_ADMIN, 1 SUPER_ADMIN, 75 USER, **0 ADMIN**; 125,266 CDR rows
  with 4,310 unattributed but **only 6** advertising a live recording; **58
  unassigned `TenantSmsNumber` rows**; 20 active mobile devices; 0 SMS campaigns;
  0 10DLC submissions.
- ⛔ **A THIRD LATENT `ADMIN` FINDING, found 2026-08-19 in the one place the audit
  said it had never looked: `/ws/telephony`.** The live-call socket authenticates
  properly (`jwt.verify` against `JWT_SECRET`, `1008 Unauthorized` on failure, a
  per-IP connection cap) and its snapshots ARE tenant-scoped — a scoped viewer
  sees only its own tenant and records with no tenant are dropped for them. But
  `TelephonySocketServer.handleConnection` treats **`SUPER_ADMIN` *or* `ADMIN`**
  as global (`tenantId = null`), which bypasses the filter entirely — so creating
  one `ADMIN` user lets them watch **every company's live calls in real time**.
  Same class as the raw-PBX-id routes and the chat routes: harmless today (0
  `ADMIN` users), armed the moment one exists. **Deliberately NOT changed** — it
  is a telephony deploy, and `SUPER_ADMIN`-global is intended.
- ⛔ **Two findings are LATENT because no `ADMIN`-role user exists** —
  `PATCH`/`DELETE /voice/pbx/resources/:resource/:id` pass a raw id straight to
  VitalPBX with the platform app-key and **no tenant scope**, including
  `resource: "tenants"`. `TENANT_ADMIN` is absent from
  `VITALPBX_ROLE_PERMISSIONS` so it falls back to the view-only `USER` set.
  **Creating one `ADMIN` user makes `DELETE .../tenants/<other customer>` live.**
- ✅ **A long-standing mystery is explained in passing:** the `401/401` on
  `/pay/invoices/` recorded in the Cloudflare section is **not** a routing quirk —
  the JWT bypass list has `/billing/platform/invoices/pay/` and `"pay-multi/"`
  does not match `"pay/"`, so every combined pay link is dead before the handler
  runs. Fails closed; an availability bug, not a leak.
- ⏳ **NOT COVERED:** `apps/telephony`, `apps/worker`, `apps/agent` — including
  **`/ws/telephony`, which broadcasts live call state and was NOT audited**;
  whether VitalPBX enforces tenant ownership on a raw resource id; and anything
  proven by exploitation (deliberately, none was attempted).
- ⛔ **Several fixes are config-only (`.env.platform`) and therefore have NO
  deploy path of their own** — an env change cannot trigger an api rebuild; it
  must ride a real `apps/api/` commit. See the SIP-hostname section below.
