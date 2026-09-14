# ⛔⛔ AGENT HANDOFF — `/internal/*` was an unlocked door on the public internet, and it is shut now (2026-08-18) — READ FIRST before touching `CDR_INGEST_SECRET`, before adding ANY `/internal/*` route, before rotating that secret, and before putting a secret in a compose `environment:` block

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0b**
(`6ab8c74b` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**
(`/app/.build-commit` = `6ab8c74bc132`), **telephony and worker restarted**, one env
edit to `/opt/connectcomms/env/.env.platform`. No migration, no PBX config write, no
DNS/Cloudflare change, no tenant row touched. Owner approved the multi-service restart.)

- ⛔⛔ **THE RULE: a lock that opens when its key is missing is not a lock, and the
  key was missing.** `verifyCdrSecret` returned **true** when `CDR_INGEST_SECRET` was
  unset ("dev mode"), seven more inline copies did the same, and the variable was empty
  in api, telephony **and** worker. Anyone on the internet could `GET
  /api/internal/telephony/pbx-tenant-map` and receive **24,839 bytes** — every tenant
  slug, PBX link, inbound DID and extension — or `POST /internal/cdr-ingest` to write
  fabricated calls into a competitor's history. nginx closed the internet-facing half on
  2026-08-18; **this closed the code half.**
- ✅ **One implementation now**: `apps/api/src/internalSecret.ts`. **Unset → 503,
  header absent → 401, header wrong → 403.** `verifyCdrSecret` and the new
  `guardInternalSecret` both delegate to it. ⛔ **Not gated on `NODE_ENV`** — this
  container sets none, which is exactly how the login throttle and the error-leak
  handler sat dead for months.
- ⛔ **A SECOND BUG FELL OUT OF THE EXTRACTION, and a test caught it.** The old
  comparison did `padEnd(64).slice(0, 64)` on both sides, so it compared only the
  **first 64 characters** — two different secrets agreeing on their first 64 chars were
  accepted as equal. Both sides are SHA-256'd now, so length is irrelevant.
- ⛔⛔ **THE ENV EDIT ALONE WOULD HAVE BEEN A SILENT NO-OP — this is the trap worth
  remembering.** `environment:` **wins over** `env_file:`, and api / api_candidate /
  telephony each carried `CDR_INGEST_SECRET: ${CDR_INGEST_SECRET:-}`, substituted from
  the **deploy shell** — and `deploy-direct.sh` sources only `.env.deploy-queue`, never
  `.env.platform`. That is why the containers read *defined: true, length: 0*: the file
  was being overridden with `""`. **All three overrides are deleted**; the worker never
  had one, which is the only reason it would have picked the value up at all.
  ⛔ **Never put a secret in an `environment:` block in this compose file.** The
  telephony block already warned about this for `JWT_SECRET`/`AMI_PASSWORD`; nobody had
  applied it to this variable.
- ⛔⛔ **THE ORDER IS THE SAFETY PROPERTY, AND IT IS NOT "SENDERS FIRST".** api is
  **both** a receiver (telephony, PBX) **and** a sender (to telephony), and telephony's
  own `isInternalRouteAuthorized` turns strict the moment *it* holds the secret — the
  dependency is circular. What was run: **(1)** secret into `.env.platform`
  (`openssl rand -hex 32`, 64 chars; backup
  `.env.platform.bak.20260818T025024Z.internal-secret`; diff = **6 added, 0 removed**;
  fingerprint `994ecc32aee9`) → **(2) worker** (it calls telephony) → **(3) telephony**,
  in a **verified idle window** (polled the PBX read-only until `core show channels
  count` read **0 active calls**, because the restart rebuilds `CallStateStore` from
  zero) → **(4) api** last, blue/green.
  ⛔ **Accepted cost of that order:** between (3) and (4) api had no secret while
  telephony demanded one, so api→telephony calls (IVR/MOH publish, DND, play-prompt,
  voicemail-drop, invite-requeue rescue) were refused for ~5 minutes at 23:00 ET. None
  are on the answer path. **The reverse order is far worse** — it refuses
  telephony→api CDR ingest, which loses call history permanently.
- ✅ **PROVEN WORKING POSITIVELY, not by absence of errors.** A real call landed a
  `ConnectCdr` row at **03:05:56.910Z** (post-deploy), and in the same second telephony
  logged **`mobile-ring: API notified ok` status 200 ×2**. Telephony's poller keeps
  answering `pbx_tenant_map_refresh_success`; `contact-status` and `user-extensions`
  return 200; CDR retry-queue depth **0**. All nine doors were probed as a matrix
  (none/wrong/right header) and all refuse without the secret and run the handler with
  it. ⛔ **The check that mattered most: every 401/403 since the deploy came from
  `172.19.0.1`** — the docker bridge gateway, i.e. the probes themselves. **Not one
  request from telephony (`172.19.0.5`), the worker (`172.19.0.4`) or the PBX was
  refused.** ⛔ 0 CDRs in the first four minutes was **silence, not proof** — don't
  stop there.
- ⛔ **ROTATING THIS SECRET IS A FOUR-STEP OPERATION, not an env edit**: `.env.platform`
  → worker → telephony → api, in that order, **plus** a `POST
  /internal/pbx/publish-wake-config` so the PBX's AstDB key follows. The live dialplan
  reads `Set(WAKE_SECRET=${DB(connect/system/wake_api_secret)})` — it is **not** baked —
  so skipping the last step silently leaves the PBX wake POST 403ing.
  ⛔ **Disclosed: that AstDB key was written by ACCIDENT during this work** — the
  door-matrix probe of `publish-wake-config` returned 200, which means it really ran and
  published. Left in place: it is the correct value, it went through Connect's own
  sanctioned publish route (not a hand edit on the PBX), it changes no call behaviour,
  and reverting would mean another PBX write to restore a *wrong* value.
  ⛔ A failed wake POST is **non-blocking** either way — the dialplan NoOps the response
  and dials regardless, and fleet-wide `[connect-wake-core]` uses an **AMI UserEvent with
  no synchronous HTTP on the call path**.
- ⛔ **The nginx `/api/internal/` deny STAYS** — defence in depth, untouched, re-verified
  **403 from outside on both hostnames**. Do not remove it now that the code is fixed.
- ⛔ **Guard tests read the CALL SITES' SOURCE**, not just the helper
  (`apps/api/src/internalSecret.test.ts`, 11 tests, picked up by the existing
  `src/*.test.ts` glob). Proven real: all three source guards fail against the
  pre-change file. It also asserts **no compose service re-adds the
  `CDR_INGEST_SECRET:` override** — the defect was half configuration, and a unit test
  of the function passes straight through that.
- ⏳ **STILL OPEN.** `/internal/voicemail-notify` has **not** been exercised by a real
  voicemail (only a probe — the next real one is the acceptance test).
  ⛔ **`inbound-crm-match` still takes `viewer.role` from the request BODY**
  (`server.ts:35782` injects `verifyCdrSecret`, so the door is now locked — but anything
  holding the secret can still claim `SUPER_ADMIN`); it is now the weakest thing behind
  the door. Audit findings **§4** (`TENANT_ADMIN` reaches `/admin/*`) and **§5**
  (anonymous tenant creation behind the dead `NODE_ENV` gate) are **untouched**, as are
  the **four other signing helpers** (prompt / MOH / CRM doc / CRM voicemail-drop) that
  still fall back to the literal `"dev-signing-secret"`.
  ⛔ Pre-existing and **not** caused by this work: **telephony reaches the api at
  `http://api:3001` by docker DNS, bypassing blue/green**, so its calls fail for the
  ~67 s the stable api container is recreated (one `pbx_tenant_map_refresh_failed` and
  two `reg-status ingest failed` this deploy, all `fetch failed`, none auth-related).
