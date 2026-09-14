# ⛔⛔ AGENT HANDOFF — the NODE_ENV sweep is FINISHED: the payment-safety guard that had never run, and three more dead gates (2026-08-18) — READ FIRST before writing ANY `process.env.NODE_ENV` branch in apps/api, before touching the Cardknox simulate guard, and before believing a safety check in apps/api has ever executed

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(one api commit on `feat/ivr-migration-takeover`. **No migration, no PBX write, no
nginx change, no env change, no DNS change, no tenant row, no user role touched.**
apps/api typecheck **75 errors — the exact baseline, none in an edited file.**)

- ⛔⛔ **THE RULE THIS CLOSES: in apps/api, a check written as
  `process.env.NODE_ENV === "production"` has NEVER RUN.** `app-api-1` sets no
  `NODE_ENV` at all — re-proven live 2026-08-18: `docker exec app-api-1 printenv
  NODE_ENV` prints nothing and **exits 1**, while `app-telephony-1` prints
  `production` (compose sets it only in the telephony block, `docker-compose.app.yml:455`).
  Four instances of this class had already been fixed one at a time — the login
  throttle, the error-leak handler (`4fb512ed`), and the anonymous tenant factory.
  **This is the rest of the sweep, and the biggest one was still open.**
- ⛔⛔ **THE PAYMENT GUARD: `SOLA_CARDKNOX_SIMULATE` makes the card gateway return
  APPROVALS WITHOUT MONEY MOVING** — invoices marked PAID, receipts emailed, autopay
  "succeeding", the customer's card never touched. `server.ts` was supposed to
  **refuse to boot** in that state and never once did. Now
  `apps/api/src/cardknoxSimulateGuard.ts`, called at boot, with **no NODE_ENV**.
  ✅ **Checked BEFORE flipping it closed, not after — this one could have been a
  total outage:** a fail-closed guard stops the api starting if simulate is on.
  Verified live that `SOLA_CARDKNOX_SIMULATE=false` in **both `app-api-1` and
  `app-worker-1`**, it is set in **no** file under `/opt/connectcomms/env/`, and it
  comes from the compose default `${SOLA_CARDKNOX_SIMULATE:-false}` present in all
  three blocks (`api:29`, `api_candidate:245`, `worker:520`). Nothing in production
  simulates, so the guard cannot refuse boot today.
- ⛔⛔ **A SECOND HOLE IN THE SAME GUARD, AND IT IS THE MORE INTERESTING ONE: the
  guard recognised FEWER truthy spellings than the thing it guarded.** It only
  matched `"true"`, but **`billing/solaGateway.ts:66`/`:195` and
  `billing/solaExternalSchedules.ts:199` turn simulate on for the literal `"1"`**
  (while `server.ts:653` and `apps/worker/src/main.ts:402` use `"true"`). So
  `SOLA_CARDKNOX_SIMULATE=1` put the real gateway into simulate mode **with the
  guard staying silent — even if `NODE_ENV` had been set correctly.** All spellings
  (`1`/`true`/`yes`/`on`) now refuse boot, through one shared rule
  (`apps/api/src/envFlag.ts`). ⛔ **The four readers are deliberately UNCHANGED** —
  they are payment code and out of scope; the guard makes their disagreement
  unreachable in production rather than editing them under a security fix.
  ⏳ **Unifying those four readers on `isEnvFlagEnabled` is the obvious follow-up
  and was NOT done.**
- ⛔ **`crm/formStorage.ts` — the ephemeral-storage-root guard, same shape as the
  onboarding-uploads DATA LOSS bug.** With no configured root it fell back to a
  path **inside the container image**, which every api deploy destroys while the DB
  row pointing at it survives. Now fails closed unconditionally
  (`CRM_FORM_STORAGE_ALLOW_EPHEMERAL=1` is the dev opt-in). ✅ Safe because
  `CRM_DOC_STORAGE_DIR=/var/lib/connect/crm-lead-docs` is set live **and in BOTH api
  compose blocks with the volume mounted** (154/209 and 327/364) — so blue/green
  cannot cut over onto a container missing it. **A test asserts both blocks keep
  it**; that pairing is the only reason the throw is safe.
  ⛔ It is called per-request (`resolveCrmFormStoragePath`), never at module load, so
  a misconfiguration is a loud 500 on one upload, never a container that won't boot.
- ⛔ **`redis.ts` — behaviour-identical in production, and that is the point.** The
  "stop reconnecting + swallow every redis error" fallback was `NODE_ENV !==
  "production" && !REDIS_URL`; with NODE_ENV absent, only `!REDIS_URL` ever decided
  it. It is now keyed on `REDIS_URL` alone (**set live**:
  `redis://connectcomms-redis:6379`), so nothing moves — what it removes is the trap
  where someone "fixes" the dead-gate class by setting `NODE_ENV=development` and
  **silently turns off redis reconnection platform-wide.** A missing `REDIS_URL` now
  also logs one loud warning.
- ⛔ **A FAIL-OPEN BRANCH NOBODY HAD COUNTED: `canIssueDevObserveJwt`
  (`server.ts`) opened with `if (NODE_ENV === "development") return true;` — no
  secret required — on `POST /admin/dev/generate-observe-token`, which is on the
  **JWT bypass list** and mints a **SUPER_ADMIN token scoped to `tenantId "global"`
  for up to 120 minutes**. It was dead only by accident; anyone who ever set
  `NODE_ENV=development` on this container — **the exact "fix" CLAUDE.md forbids** —
  would have opened it to anonymous callers. Removed; `DEV_OBSERVE_TOKEN_SECRET` was
  then the only key. Production behaviour was unchanged.
  ✅ **SUPERSEDED 2026-08-18 — THE WHOLE ROUTE IS DELETED, not merely re-gated.**
  See the dedicated section below. The secret is no longer read by anything.
- ⛔ **ONE `NODE_ENV` READER SURVIVES ON PURPOSE:
  `apps/api/src/ops/serverHealth.ts:66`, `isLocalDevHost()`.** It is **not a gate** —
  it only chooses which URL to probe for a health readout, and its
  permanently-false branch already selects the CORRECT production value
  (`PORTAL_INTERNAL_URL` / `http://portal:3000`), with `process.platform === "win32"`
  covering real local dev without NODE_ENV. **Dead in the right direction; changing
  it would alter a working probe for no security benefit.**
- ⛔ **The guard test sweeps the WHOLE TREE, with comments stripped**
  (`apps/api/src/nodeEnvGates.test.ts`, 18 tests, picked up by the existing
  `src/*.test.ts` glob): it asserts `apps/api/src` contains **exactly one**
  executable `process.env.NODE_ENV` reader, and names it. Several files quote the
  old broken line in their doc blocks deliberately, which is why a naive
  `git grep NODE_ENV` reads as a regression and is the wrong check.
  ✅ **Proven non-vacuous:** all five source guards were replayed against the
  pre-change files from `git show HEAD:` and **all five fail**.
- ⛔ **An existing test was quietly asserting the bug.**
  `crmFormService.test.ts` set `NODE_ENV="production"` to make the storage guard
  fire — so it passed while the guard was dead in the only environment that
  mattered. It now asserts the throw with **NODE_ENV unset**, production's real
  shape. **If a security fix makes an old test fail, read why before making it
  pass.**
- ⏳ **NOT PROVEN: none of it has been exercised by a human.** Proven by 18 new
  tests + the existing suites, a typecheck at its exact 75-error baseline, and the
  container's env read live. **Acceptance after deploy: the api BOOTS** (health 200
  on both hostnames, bad-credential login 401) — which is the whole risk here, since
  three of these changes now throw where they previously did not. Then one CRM form
  upload/download still works.
