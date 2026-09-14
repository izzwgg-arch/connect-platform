# ⛔⛔ AGENT HANDOFF — the last seven tenant-scoping findings are closed, and TWO of them were never live (2026-08-18) — READ FIRST before judging who can reach an `/admin/apps/voip-ms/*` route, before assigning or DUPLICATING a custom role, before streaming a recording that has no tenant on it, or before adding a signed URL that is not bound to a tenant

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0d**
(one api commit on `feat/ivr-migration-takeover`. **No migration, no PBX write, no
nginx change, no env change, no DNS change, no tenant row and no user role touched.**
apps/api typecheck **75 errors — the exact baseline**, none in an edited file;
suite **2492 tests, 2482 pass, 7 fail — all 7 the pre-existing
`pbxTenantDirectorySync` ones**.)

- ⛔⛔ **THE CORRECTION THAT MATTERS MOST: §6a and §6b were NEVER LIVE, and the
  audit said they were.** Both routes gate on `connectChatRoutes.ts`'s own
  `isTenantAdmin()`, which admits **only `SUPER_ADMIN` and `ADMIN`** — and there
  are **ZERO `ADMIN`-role users** on this platform. Verified live 2026-08-18:
  **9 TENANT_ADMIN, 1 SUPER_ADMIN, 75 USER, 1 EXTENSION_USER, 0 ADMIN.** The
  audit's *"any tenant admin can walk E.164 ranges"* was read off that helper's
  **NAME, not its contents** — the same trap this file already records for
  `requireAdmin` vs `requireSuperAdmin`. The only account that could reach either
  route today is Izzy's, for whom the behaviour is intended. ⛔ **Creating one
  `ADMIN`-role user arms both**, exactly as §6h records for the raw-PBX-id routes
  — which is why they were fixed anyway. **Read the helper, never its name.**
- ⛔⛔ **§6c: THE AUDIT FOUND ONE PATH AND THERE WERE TWO.** Assigning a custom
  role never checked the role's permissions — but **`POST /admin/custom-roles/:id/duplicate`
  copies `source.permissions` verbatim with no grantability check either**, and
  the update route validates permissions only when the body carries them, so a
  copy could simply be activated afterwards. Both now call
  `ungrantablePermissionsFor()`. ⛔ **The rule: re-check grantability wherever a
  role's permissions REACH a user, not only where they are typed in.** Bounded —
  this grants portal permission *keys*, never the JWT `role`, so everything gated
  on `isSuper()` stays closed.
- ✅ **`customRoleRoutes.ts`'s header no longer claims permissions are "additive
  only".** That was wrong from the moment custom roles became **authoritative**,
  and it is the exact misreading that makes someone build a role as "just the
  extras" and thereby **delete the rest of that person's portal**
  ([[custom-roles-are-authoritative]]).
- **§6b — the guard that skipped itself.** `if (row.tenantId && row.tenantId !== effTenant)`
  short-circuited on an **unassigned** row, so a caller could claim a spare
  platform DID (**57 live**) or one a port-in was landing for another customer,
  and route its inbound SMS to themselves. Strict equality now. ✅ Safe to tighten:
  the numbers LIST route already filters `{ tenantId }` for non-supers, so no
  portal flow ever claimed a spare this way.
- **§6a — a foreign number now answers exactly like a number that does not exist**
  (`{found:false}`), not with its owner and the staff member it rings. ⛔ A 403
  would still be an oracle.
- **§6d — an unattributed recording is refused.** `if (rec.tenantId)` skipped the
  whole tenant check when the CDR had no tenant, and the owner carve-out **also**
  passes when `rec.extension` is null — which it is for every inbound call, since
  `toNumber` is a 10-digit DID and the regex is `/^\d{2,6}$/`. ✅ **Costs no
  customer anything, sized live: 4,316 of 126,052 CDRs are unattributed and
  exactly SIX still advertise a recording** — and an unattributed row is in no
  tenant's history, so nothing in the product ever offered it.
- **§6e — `/crm/voicemail-drops/:id/stream` is DUAL-GATED now.** It was the only
  route in its file with no `requireCrmAccess` and no `tenantId` filter, resting
  entirely on an HMAC bound to **neither tenant nor user** — so a signed URL
  issued to one company was replayable by any authenticated user of any other.
  Now: authenticate → scope the row to the caller's tenant → **then** check the
  signature, the shape `docImportRoutes.ts` next door already used.
  ✅ **Safe for `<audio>`** — the route is not JWT-bypassed and the global
  preHandler copies `?token=` into Authorization, which all three portal
  consumers already send (`withToken` ×2, `tokenized`); there is no mobile caller.
- **§6f — `retry-payment`** resolves the card with `findFirst` scoped to
  `invoice.tenantId` + `active: true`, like its admin-charge sibling. Not
  exploitable (the id is server-derived), but one stale `paymentMethodId` would
  have charged **another company's vaulted card** and read as a gateway anomaly.
- **§6g — delivery `createDriver`** validates both caller-supplied ids against
  the tenant and answers **400 with a reason**, not an unhandled 500;
  `driverNameMap` gained `tenantId`, so a profile pointing at a foreign user
  renders as an id stub instead of that person's name and email.
- ⛔⛔ **A GUARD THAT GUARDED NOTHING, AND ONLY THE REPLAY FOUND IT.** The §6e
  "no bare-id fetch" assertion was first written as `findFirst({ where: { id } })`
  and **passed against `HEAD`** — the real pre-change line is
  `findFirst({ where: { id }, select: … )`, so it matched nothing in either
  version. **Running new guards only against the fixed tree would have shipped a
  decorative test.** Replay every source guard against the pre-change blob.
- **Tests: 17 in `apps/api/src/tenantScopeHardening.test.ts`** (picked up by the
  existing `src/*.test.ts` glob — no registration needed). ✅ **Proven
  non-vacuous: all 12 source guards fail when replayed against `HEAD`**; the 5
  that pass there are the pure unit tests of the new module. All reads are
  CRLF-normalised.
- ✅ **DEPLOYED and CONTAINER-VERIFIED 2026-08-18.** It rode another session's api deploy: the running container's `.build-commit` is **`058002d0`**, and `git merge-base --is-ancestor d19c9c00 058002d0` confirms this work is inside it. ⛔ **A own `deploy-direct.sh api` run then printed `success` while logging `skip=unrelated_paths`** — correct, not a failure: the clone had already been built at `058002d0` and the only newer commit was docs. **The exit line is never the proof; `/app/.build-commit` plus a grep inside the container is.** All nine changes greped live — `canReadSmsNumberRow` 2, `canModifySmsNumberRow` 2, the old `row.tenantId && …` short-circuit **0**, `ungrantablePermissionsFor` 3, the stale "additive only" sentence **0**, the unattributed-CDR else-branch 1, the voicemail-drop DUAL GATE 1, retry-payment's tenant scope 2, `driver_user_not_in_tenant` 1. Health **200** on both hostnames, portal **200**, a bad credential still **401 `invalid_credentials`**, container **0 restarts**, and **no `level:50/60` line** in the 20 minutes after.
- ⏳ **NOT PROVEN: nobody has exercised any of this by hand.** Acceptance, negatives first: a CRM user can still
  play a voicemail drop **from their own tenant**; `routing-preview` for a number
  the caller does not own reads **`found: false`**; a retry-payment still charges;
  `POST /delivery/drivers` still creates a driver for an own-tenant user.
- ⏳ **Still open from the audit: §6h, §6i, §6j and §6l.** §6i is the one worth
  doing next — `@fastify/rate-limit` is registered with **no `keyGenerator`** and
  Fastify has **no `trustProxy`**, so the default key is `req.ip`, i.e. the nginx
  hop: **one global bucket for the whole platform**, letting a single client 429
  every customer. §6j is an availability bug customers feel (combined pay links
  401 because `"pay-multi/"` does not match the `"pay/"` bypass entry).
