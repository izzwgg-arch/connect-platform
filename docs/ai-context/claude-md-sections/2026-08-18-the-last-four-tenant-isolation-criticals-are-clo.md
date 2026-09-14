# ⛔⛔ AGENT HANDOFF — the last four tenant-isolation criticals are closed: a role read from the body, an anonymous tenant factory, four keys that were a string in this repo, and `/admin/*` open to customers (2026-08-18) — READ FIRST before trusting a role that arrived in a request, before adding ANY signed-URL helper, before restricting an `/admin/*` route, and before "fixing" a `NODE_ENV` gate

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0c**
(one api commit on `feat/ivr-migration-takeover`. **No migration, no PBX write, no
nginx change, no env change, no DNS change, and no tenant row or user role was
touched.** Tests **2328 pass / 8 fail**, all 8 pre-existing; typecheck **75 errors,
the exact baseline, none in an edited file.**)

- ⛔⛔ **THE RULE THIS ROUND EARNED: a role that arrives in a request is a CLAIM,
  not a fact — derive it from the database.** `POST /internal/telephony/inbound-crm-match`
  took `viewer.role` from its own JSON body, and both CRM checks open with
  `if (isAdminRole(role)) return true` — so `{"viewer":{"role":"SUPER_ADMIN"}}`
  short-circuited every access check for every tenant, `userId` need not even
  exist. Now `db.user.findUnique({ id: viewer.userId })` decides
  (`decideTrustedViewerRole`), and **an admin's bypass is pinned to their OWN
  tenant** — a TENANT_ADMIN of A asking about B gets nothing.
  ⛔ **The body still ACCEPTS `role` on purpose** — telephony still sends it and
  a stricter schema would 400 a running container mid-deploy. It is parsed and
  dropped. ⛔ **SUPER_ADMIN keeps cross-tenant reach deliberately**: the platform
  admin's telephony feed genuinely carries other tenants' calls.
  ⛔ Ordinary users were **already** safe (`crmUserAccess.findUnique({ tenantId_userId })`
  is tenant-scoped) — the admin bypass was the whole hole.
- ⛔⛔ **A FALLBACK CHAIN ROTATED FOUR SIGNING KEYS BY ACCIDENT, AND NOTHING SAID
  SO.** The prompt / MOH / CRM-doc / CRM-voicemail-drop helpers each ended
  `… || CDR_INGEST_SECRET || "dev-signing-secret"`. Populating `CDR_INGEST_SECRET`
  hours earlier — for the completely unrelated `/internal/*` fix — turned that
  third rung into a real value, so **all four schemes silently rotated off the
  repo literal that night with nobody choosing it** (proven live: they were
  resolving to `sha256[0:12] = 994ecc32aee9`, the CDR secret). Every URL minted
  before then was already unverifiable. **That is why a chain of unrelated
  fallbacks is the wrong shape: a change made for one reason rotates keys for
  four others.** All four now call one resolver
  (`apps/api/src/urlSigningSecret.ts`): the scheme's own variable, else a key
  **derived from `JWT_SECRET`** under a per-scheme label, else **THROW**.
  ⛔ **`CDR_INGEST_SECRET` is deliberately out of the chain** — it is an *auth*
  credential whose rotation is a documented four-step multi-service operation.
  ⛔ **Per-scheme labels are load-bearing:** prompt and MOH sign the
  byte-identical payload `${storageKey}:${exp}`, so on one shared key a valid MOH
  signature was **also** a valid PROMPT signature for the same storage key.
  ⛔ Blast radius measured, not assumed — all four mint *and* verify inside
  `apps/api`, TTLs 300–900 s, and 14 days of nginx logs hold **0 / 2 / 0 / 0**
  fetches. ⛔ **Count the signed path, not the substring** — the 20 apparent
  `/crm/voicemail-drops/` hits are Next.js chunk fetches for the portal page.
- ⛔ **THE ANONYMOUS TENANT FACTORY IS SHUT, WITHOUT TOUCHING `NODE_ENV`.**
  `canLazyCreate()` no longer reads it at all; it needs an explicit
  `ONBOARDING_ALLOW_LAZY_CREATE=1` and is closed for unset / `""` / junk. ⛔
  **Checked before closing, not assumed:** all **21** `OnboardingSubmission` rows
  in production were admin-created or spawned from a template — **0 lazy** — so
  nothing legitimate depended on it. A refusal logs a warning naming the route and
  token prefix, so a real need is greppable instead of reaching a customer as
  "the link stopped working".
- ⛔⛔ **`/admin/*` AND THE 8 CUSTOMER ADMINS: SCOPE, DON'T BLOCK — and the
  investigation is what told us which.** Before changing anything: the live
  permission snapshot gives TENANT_ADMIN `can_view_admin_tenants` but **NOT
  `can_view_section_admin`** (so the Admin sidebar is already hidden from them)
  and **NOT `can_switch_tenants`**; `useAppContext.tsx:408` pins `adminScope` to
  `"TENANT"` for every non-SUPER_ADMIN, making every `platformData.ts` GLOBAL
  branch unreachable; and of **363** `GET /admin/tenants` calls in 14 days,
  **335 came from two of the SUPER_ADMIN's own IPs**, the rest showing the
  tenant-switcher's 1:1 boot pairing. The other five routes had **ZERO** calls.
  So: **`GET /admin/tenants` and `GET /admin/sms/campaigns` are SCOPED** (a
  per-tenant answer exists, and `/admin/tenant-options` already answers that way),
  while **`PATCH /admin/tenants/:id`, both campaign approve/reject routes and
  `/admin/wake-health` move to SUPER_ADMIN**. ⛔ Scoping the writes would have
  been wrong, not safer: a customer raising their own `dailySmsCap`, setting their
  own `isApproved`, or approving their own first campaign **defeats the control's
  entire purpose**.
  ⛔ **`requireAdmin` itself is UNCHANGED and still admits TENANT_ADMIN** — this is
  per-route, never a global narrowing, and a test pins that.
  ⛔ **`ownTenantScopeWhere` FAILS CLOSED**: an unusable tenantId (`""`, `local`,
  `global`, `vpbx:*`) yields `{ id: { in: [] } }`, **never `undefined`** — which
  Prisma reads as *no filter* and hands back the whole platform. That inversion is
  the bug class itself.
  ⛔ **`/admin/wake-health` matched NO `PORTAL_API_PERMISSION_RULES` entry**, so
  the global gate never ran for it while it returned every Android device with its
  user's email. Now `can_view_admin_server_health` — a key the live TENANT_ADMIN
  bucket does not hold. **Check a new `/admin/*` route has a rule; a missing one
  is silent.**
- ⛔ **Two existing suites were silently exercising the repo literal** — they now
  pin a test key. If a security fix makes an old test fail, read *why* before
  making it pass: here it was the proof the literal was reachable.
- ⛔ **Noted, deliberately NOT changed:** api and api_candidate carry
  `MOH_URL_SIGNING_SECRET: ${MOH_URL_SIGNING_SECRET:-}` in `environment:`, which
  overrides the 43-char `.env.platform` value with `""` — the very trap that left
  `CDR_INGEST_SECRET` empty for the platform's life. Left in place because nothing
  outside `apps/api` mints or verifies a MOH URL; both compose blocks now carry a
  comment saying deleting the line would rotate every outstanding MOH URL.
- ⛔ **Every guard test reads its CALL SITES' source, not just the function** —
  each of these four defects was a caller, and a unit test of the pure function
  passes straight through all of them. All were proven real by replaying them
  against the pre-change files (5, 2, 16 and 9 assertions fail respectively).
- ⏳ **NOT PROVEN: none of it has been exercised by a human.** Acceptance, in §0c:
  a real inbound call still screen-pops a CRM name; an IVR prompt publish still
  gets a **200** on the PBX's signed fetch; a customer's onboarding link still
  saves; and — ⛔ **the negative that matters most** — a TENANT_ADMIN calling
  `GET /api/admin/tenants` sees **exactly one row, their own**, and
  `PATCH /api/admin/tenants/:id` answers **403**.
- ⏳ **§6a–§6l of the audit remain open and untouched**, as do the four items §0b
  left open.
