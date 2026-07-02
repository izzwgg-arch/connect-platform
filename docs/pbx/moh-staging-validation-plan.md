# Staging VitalPBX validation plan — Connect MOH & future PBX work

> **Planning only.** This document is a design/plan. It changes no infrastructure,
> touches no production system, and authorizes nothing. Implementation requires
> explicit owner approval (see §9). Grounded in the PBX brain snapshot
> (`docs/pbx-brain/…`, 2026-06-09), `docs/ai-context/ASTDB_KEYS.md`, and
> `scripts/pbx/install-connect-tenant-moh-dialplan.sh` (branch `feature/moh-per-call-source`, `f3c3012c`).

---

## 0. Why a staging PBX

The MOH per-call-source feature is validated at the **DB/API + dialplan
string-shape** layer (29/29 DB checks, zero schema drift, installer string
tests). What is **unproven** is **live PBX runtime behavior** — `MOH_SRC`
derivation, `CHANNEL(musicclass)`, `CONNECT_MOH`, and the transfer-misclassification
fix — because there is no non-production PBX. Connect has a **single production
VitalPBX**, hard-gated by `AGENTS.md`. A dedicated staging PBX unblocks this and
all future PBX work without ever risking production.

---

## 1. What the staging PBX must replicate (from the brain files)

| Element | Production shape (brain) | Staging must replicate |
|---|---|---|
| **Tenants** | Numeric VitalPBX tenant id `T<id>`; Connect slug via `name.toLowerCase().replace(/[^a-z0-9]+/g,"_")…`; reverse map `connect/pbx_tenant_map/<id>/{slug,moh_class}` | ≥1 test tenant with a numeric id and a **test-only** slug |
| **Extension patterns** | Channel names `PJSIP/T<id>_<ext>-…`; per-tenant contexts `T<id>_cos-all`, `T<id>_<...>-hints`, `T<id>_before-connecting-call-hook` | ≥3 extensions under the test tenant, same `T<id>_<ext>` naming |
| **Inbound route** | DID → `app-incoming` (`extensions__20-baseplan.conf` L95) → tenant routing → local extension dial | 1 test DID (or simulated inbound) → test extension |
| **Outbound route** | Extension → trunk `trk-<id>-dial`; `__CALL_TYPE=3`; Dial carries `U(sub-before-bridging-call^…)` (L216) | 1 **test** outbound route to a sandbox/echo target (no real trunk unless approved) |
| **IVR** | IVR delivery sets `__CALL_ORIGIN=RESTRICTED_IVR_CALL`; Connect IVR family `connect/t_<slug>` `opt_<digit>/dest`, `active_prompt`, … | 1 IVR with ≥1 option routing to a test extension |
| **Ring group** | Delivery sets `__CALL_ORIGIN=ring-group` | 1 ring group over 2 test extensions |
| **Queue** | Member legs `Local/${CALL_SOURCE}@${QUEUE_AGENTS_CONTEXT}` (baseplan L2024…); `QUEUE_AGENTS_CONTEXT` set on those legs | 1 queue with ≥1 test agent extension |
| **Transfer behavior** | Native `${BLINDTRANSFER}` / `${ATTENDEDTRANSFER}`; baseplan sets `__TRANSFERED_CALL=TRUE` **unconditionally** on every local dial (L217) — the trap the fix avoids | Ability to perform real blind + attended transfers between test extensions |
| **MOH include structure** | `[sub-before-bridging-call]` (L3241) → `global-before-bridging-call-hook` (L3254) → `sub-connect-tenant-moh`; connect-leg via `T<id>_before-connecting-call-hook` → shim → resolver; installer drops `extensions__65_connect_tenant_moh.conf` + `#include` sentinel in `extensions__60_custom.conf` | Same VitalPBX baseplan hooks present so the installer's include model works |
| **Caller-leg hold (inbound)** | Generic `[connect-localdial-moh]` (2026-07-02) invoked by one guarded GosubIf after the `U(sub-before-bridging-call` anchor in `[sub-local-dialing]`; resolves tenant at runtime from `${TENANT_PREFIX}` + `pbx_tenant_map`/`connect/t_<slug>` keys; `extensions__67_connect_localdial_moh.conf` + `#tryinclude` in `extensions__60_custom.conf`. See proof doc §P. | Same `[sub-local-dialing]` anchor present; validate an **unpublished** tenant publishes MOH and inbound hold plays it with no installer re-run |
| **AstDB key patterns** | `connect/pbx_tenant_map/<id>/{slug,moh_class}`; `connect/t_<slug>/{moh_class,active_moh_class,moh/src/<source>}`; `connect/t_<slug>/extensions/<ext>/moh/src/<source>` | Same families, written only for the test tenant via the telephony family-scope guard |
| **Connect installer assumptions** | Runs **on the PBX host** (`asterisk -rx …`); discovers tenants from `database show connect/pbx_tenant_map`; requires responsive Asterisk + VitalPBX baseplan hooks; never edits VitalPBX-generated files | Staging host must satisfy all of these (a genuine VitalPBX install, not a bare Asterisk) |

---

## 2. Minimum staging setup for MOH validation

- **1 test tenant** — slug clearly test-only, e.g. `moh_stage` / `staging_test`.
- **3+ test extensions** — e.g. `101`, `102`, `103` under `T<id>_…`.
- **1 IVR** — one digit option → `101`.
- **1 ring group** — `102` + `103`.
- **1 queue** — agent `103`.
- **1 test outbound route** — to a **sandbox/echo** number or a local test context (no real PSTN trunk unless explicitly approved).
- **Test MOH classes** — e.g. `moh_stage_a`, `moh_stage_b`, `moh_stage_c` with short, obviously-distinct audio so the ear can tell which class played.
- **No real customer data**, **no production credentials**, **no production trunks** (unless explicitly approved).

---

## 3. Safest infrastructure option (recommended)

**Recommended: a separate, small, dedicated VPS running its own VitalPBX
instance, network-isolated from production.**

- **Separate small VPS** (2 vCPU / 4 GB is plenty) — its own public IP, its own
  hostname containing `staging` (e.g. `pbx-staging.<domain>`).
- **Separate VitalPBX instance** — fresh install (matching the production
  VitalPBX/Asterisk major version so baseplan shapes match), configured by hand
  or from **sanitized** config patterns (see §4). Never a clone of the production disk.
- **Isolated firewall rules** — SIP/RTP/AMI/SSH locked to known test IPs only;
  no route to production hosts; AMI bound to loopback + the Connect staging host only.
- **Test-only SIP accounts** — softphones (e.g. Zoiper/Linphone) registered as
  the test extensions; fresh secrets generated for staging.
- **Test-only subdomain if needed** — `pbx-staging.<domain>` / `app-staging.<domain>`.
- **No shared production AstDB/config writes** — the staging Connect stack points
  only at the staging PBX's AMI; the family-scope guard + a distinct tenant slug
  keep writes contained.

Alternatives (documented, not recommended as primary):
- *Local VM / container VitalPBX* — cheapest, but SIP/RTP/NAT realism is poor and
  some VitalPBX builds resist containerization; acceptable for dialplan-shape and
  AstDB smoke tests, weaker for live-audio proof.
- *Isolated tenant on a second production-grade box you already control* — only if
  it is genuinely non-production and clearly labeled.

---

## 4. Copy vs. must-not-copy from production

**Copy (shape/patterns only):**
- Dialplan **structure/patterns**: the include model (`__60_custom` → `__65`),
  the baseplan hook names, per-tenant context naming (`T<id>_…`) — replicate the
  *shape*, generated fresh by a clean VitalPBX + the Connect installer.
- Connect AstDB **key schema** (families/keys from `ASTDB_KEYS.md`) — written
  fresh for the test tenant, not copied values.
- Non-secret **env var names/structure** (not their production values).

**Must NOT copy:**
- ❌ Customer audio / recordings / voicemail / prompts (unless fully sanitized and non-identifying).
- ❌ Production SIP secrets / endpoint passwords.
- ❌ Real customer data (tenants, DIDs, CDRs, contacts).
- ❌ Production trunk credentials (unless explicitly approved for a specific test).
- ❌ Production AstDB dumps, `/opt/connectcomms/env/*`, nginx/TLS keys, DB dumps.

---

## 5. How Connect points to staging (isolation-first)

A **separate Connect environment** for staging — never reuse production env files.

| Concern | Staging value | Safeguard |
|---|---|---|
| **Staging PBX host** | `pbx-staging.<domain>` | Hostname visibly contains `staging`; no DNS overlap with prod |
| **AMI creds** | staging-only AMI user/secret, bound to staging | AMI reachable only from staging Connect host; different secret than prod |
| **Telephony → PBX** | `apps/telephony` AMI config points at staging AMI only | Config lives in a staging-only env file |
| **DB / env** | staging `DATABASE_URL` (separate DB, name contains `stage`) | Reuse the `moh_db_validation.ts`-style guard pattern: refuse non-`stage`/`test` DB names |
| **Tenant mapping** | `connect/pbx_tenant_map/<staging_id>/slug = moh_stage` | Distinct numeric id + test slug; family-scope guard blocks cross-tenant writes |
| **Deploy target** | staging API/portal on the staging host/subdomain | Separate deploy target; production deploy scripts untouched |
| **Prod/stage confusion guard** | env flag `CONNECT_ENV=staging` surfaced in UI banner + logs | Deploy/installer/publisher print target host + tenant before any write (see §6) |

Exact env/config that would change (staging-only files, **not** prod):
- Staging `.env` for `apps/api` / `apps/worker`: `DATABASE_URL`, `CONNECT_ENV=staging`.
- Staging telephony config: AMI host/port/user/secret → staging PBX.
- Staging portal: API base URL → staging API; visible `staging` banner.
- Staging tenant seed: one `Tenant` row + `PbxInstance`/`TenantPbxLink` pointing at the staging PBX; `connect/pbx_tenant_map` seeded for the test tenant.

---

## 6. Safety gates (must exist before any staging write)

1. **Host naming** — staging host must visibly contain `staging` in hostname/DNS.
2. **Tenant slug** — staging tenant slug must be test-only (`moh_stage` / `staging_*`), never a real customer slug.
3. **Deploy refusal** — staging deploy scripts must refuse a production target
   unless explicitly approved (env allow-list; default deny). Production deploy
   path (`scripts/deploy-direct.sh`, deploy queue) stays exactly as-is.
4. **Installer preflight print** — the PBX installer must print **target host +
   discovered tenant id/slug** and require confirmation before writing (extend the
   existing `asterisk -rx 'database show connect/pbx_tenant_map'` discovery with a
   `--confirm-host` / dry-run gate). *(New gate — needs approval to add.)*
5. **AstDB publisher print** — before any `DBPut`, print target tenant slug + the
   exact `(family,key,value)` list and require it to match the staging slug (the
   family-scope guard already enforces slug prefixing; add a human-visible echo).
6. **DB guard** — reuse the `scripts/validation/moh_db_validation.ts` guard pattern
   (refuse non-local / non-`stage` DB) for any staging DB tooling.

---

## 7. MOH validation plan once staging exists

Run entirely on staging, from the clean `feature/moh-per-call-source` worktree
(`f3c3012c`):

1. **DB** — apply the MOH migration to the **staging** DB (`prisma migrate deploy`
   or `db push` on staging only).
2. **API/portal** — deploy the branch to the **staging** target.
3. **PBX installer** — run `install-connect-tenant-moh-dialplan.sh` on the
   **staging** PBX (preflight prints host + tenant; confirm before writes).
4. **AstDB** — publish MOH keys for the **test tenant only** via the telephony
   `/internal/ivr-publish` path (family-scope guarded).
5. **Configure test policies** covering every level:
   - tenant default, global default, extension default, extension source policy,
     tenant source policy, scheduled override.
6. **Live calls** — for each source, place the call, put it on hold, and capture proof:
   - inbound direct → ext
   - outbound from ext
   - internal ext-to-ext
   - IVR → ext
   - ring group → ext
   - queue → ext
   - blind transfer
   - attended transfer
7. **Capture per scenario**, via Asterisk CLI + logs:
   - `MOH_SRC` (from resolver `NoOp` line), `CONNECT_MOH`, `CHANNEL(musicclass)`
   - resolved **policy level** (extension source / extension default / tenant
     source / tenant default / global default / PBX fallback)
   - **audio confirmation** that the expected class plays on hold
   - confirmation **no routing/Dial/Bridge/Answer** behavior changed
8. **Regression matrix** — prove the fix and no regressions:
   - normal inbound_direct / internal / IVR / ring-group / queue must **not**
     classify as transfer; only real `BLINDTRANSFER`/`ATTENDEDTRANSFER` do.
   - IVR routing, ring groups, queues, transfers, voicemail fallback, call
     forwarding, pickup, recording, hold/resume, parking, mobile-app behavior
     unchanged; no duplicate Dial legs; no Local loop; no fake Answer; no tenant leakage.
9. **Hidden sources** — confirm UI still hides `mobile_app` + `parked`; legacy
   policies preserved but inactive.
10. **Rollback on staging** — tombstone per-source AstDB keys → confirm fallback;
    roll back the installer → confirm prior resolver behavior; confirm `ROLLBACK.sql`
    exists (run only if a full destructive DB rollback is needed on staging).

CLI reference (staging): `dialplan show sub-connect-tenant-moh`,
`database show connect/t_moh_stage`, `core set verbose 5`, and read the resolver
`NoOp(… moh_src=… )` line from `/var/log/asterisk/full` during a held call.

---

## 8. Summary: architecture, steps, risks, approvals

### Recommended architecture
Dedicated small **VPS + standalone VitalPBX** (matching prod major version),
network-isolated, test-only SIP accounts, a separate staging Connect stack
(API/worker/portal/telephony) pointed only at the staging PBX, with a distinct
test tenant and `CONNECT_ENV=staging`.

### Estimated setup steps (high level)
1. Provision VPS + hostname `pbx-staging.<domain>` + firewall lockdown.
2. Install VitalPBX (prod-matching version); create test tenant + 3 extensions + IVR + ring group + queue + test outbound route + test MOH classes.
3. Register test softphones.
4. Stand up staging Connect stack with staging env files (DB, AMI, API URLs, `CONNECT_ENV=staging`).
5. Seed `Tenant` + `PbxInstance`/`TenantPbxLink` + `connect/pbx_tenant_map` for the test tenant.
6. Add the §6 safety gates (installer host print, publisher echo, deploy refusal).
7. Execute the §7 validation plan and capture proof.

### Files/env/config that would need changes (staging-only; **no prod files**)
- New staging env files for `apps/api`, `apps/worker`, `apps/telephony`, `apps/portal` (DB URL, AMI creds, API base, `CONNECT_ENV`).
- Optional new gate code: installer `--confirm-host`/dry-run print; AstDB publisher pre-write echo; staging deploy allow-list. *(All additive, behind approval.)*
- Staging seed script for the test tenant + `pbx_tenant_map`.
- No changes to any production config, deploy script behavior for prod, or VitalPBX-generated files.

### Risks
- **Version drift** — if staging VitalPBX/Asterisk major version ≠ prod, baseplan hook shapes may differ and mask/introduce behavior differences. *Mitigation: match versions.*
- **NAT/RTP realism** — a VM/container may not reproduce prod SIP/RTP/NAT; audio-path bugs could hide. *Mitigation: real VPS with proper networking.*
- **Accidental prod pointing** — a mis-set env could aim staging Connect at prod AMI/DB. *Mitigation: §6 gates + name guards + separate secrets.*
- **Trunk temptation** — using a real trunk for "just one outbound test" risks real PSTN/toll and customer confusion. *Mitigation: sandbox/echo target; real trunk only on explicit approval.*
- **Cost/time** — a VPS + VitalPBX + softphone setup is a few hours plus ongoing hosting cost.

### Approval needed from you before ANY implementation
1. Approve provisioning a **new staging VPS** (and budget) — or nominate an existing non-prod host.
2. Approve the **staging domain/subdomain** naming.
3. Approve creating a **standalone staging VitalPBX** and test tenant/extensions/IVR/RG/queue.
4. Decide on **outbound**: sandbox/echo only (default) vs. an approved test trunk.
5. Approve adding the **new safety-gate code** (installer host print, publisher echo, staging deploy allow-list).
6. Approve standing up a **separate staging Connect stack + staging DB**.

Nothing above will be built until you approve the specific items.

---

## 9. Confirmation
No production was touched by producing this plan. No implementation, no deploy,
no migration, no PBX installer, no AstDB write, no VitalPBX change occurred — this
document is planning only. Live validation remains blocked per
`docs/pbx/connect-moh-per-source-phase2-proof.md` until staging exists or an
owner-approved production maintenance window is granted.
