# Staging PBX — implementation checklist (Connect MOH validation)

> **Checklist only. Nothing here is executed.** No provisioning, no deploy, no
> migration, no PBX installer, no AstDB write, no VitalPBX change. Every step is
> gated on the explicit approval marked **[APPROVAL GATE]**. Branch to validate:
> `feature/moh-per-call-source` @ `f3c3012cdabeea98f601345d48857c0d964019f3`.

## PBX brain grounding (call-path shapes staging MUST reproduce)

Verified against the brain snapshot (`docs/pbx-brain/…`, 2026-06-09):

- **Classification origin:** `[sub-setup-call-type]` sets `__CALL_TYPE` (1=internal, 2=inbound, 3=outbound, 4=TRANSIT) — `extensions__20-baseplan.conf` L473–499; inherited via `__CALL_TYPE_CONFIGURED`.
- **Bridge hook:** `[sub-before-bridging-call]` (baseplan L3241) invoked via Dial `U(sub-before-bridging-call^…)` (L216) on the called leg → `global-before-bridging-call-hook` (L3254) → `sub-connect-tenant-moh`.
- **Connect-leg hook:** per-tenant `[T<id>_before-connecting-call-hook]` → `connect-tenant-moh-connect-shim` → `sub-connect-tenant-moh` (installer-generated).
- **Ring group:** `[T<id>_ring-group-dial]` sets `__CALL_ORIGIN=ring-group` — per-tenant `extensions__50-<id>-dialplan.conf` L326/L342.
- **Queue:** `__QUEUE_AGENTS_CONTEXT=T<id>_queue-call-to-agents` (L256); context `[T<id>_queue-call-to-agents]` (L351); member legs `Local/${CALL_SOURCE}@${QUEUE_AGENTS_CONTEXT}` (baseplan L2024).
- **IVR:** `[T<id>_ivr-only-extensions]` sets `__CALL_ORIGIN=RESTRICTED_IVR_CALL` (L442); checked at L212/217.
- **Transfer:** native `${BLINDTRANSFER}`/`${ATTENDEDTRANSFER}`; `__TRANSFERED_CALL=TRUE` is set unconditionally on every local dial (L217) → must NOT be the transfer signal.
- **AstDB families:** `connect/pbx_tenant_map/<id>/{slug,moh_class}`, `connect/t_<slug>/{moh_class,active_moh_class,moh/src/<source>}`, `connect/t_<slug>/extensions/<ext>/moh/src/<source>` (`docs/ai-context/ASTDB_KEYS.md`).

> Implication: create the test tenant's IVR / ring group / queue **through the
> VitalPBX UI** so VitalPBX auto-generates the `T<id>_ring-group-dial`,
> `T<id>_queue-call-to-agents`, and `T<id>_ivr-only-extensions` contexts with the
> exact `__CALL_ORIGIN` / `QUEUE_AGENTS_CONTEXT` markers the resolver keys off.
> Then run the Connect installer to add the `T<id>_before-connecting-call-hook`.

---

## 1. VPS requirements

- [ ] **CPU/RAM/disk:** 2 vCPU / 4 GB RAM / 40 GB SSD (min 2/2/20). Headroom for Asterisk + a few concurrent test calls.
- [ ] **OS:** match production VitalPBX base OS (Debian/RHEL family + version the prod VitalPBX major targets — confirm prod version first, see §2).
- [ ] **Hostname/DNS:** `pbx-staging.<domain>` (MUST contain `staging`); A record → VPS IP. Optional `app-staging.<domain>` for the staging portal/API.
- [ ] **Firewall (default deny, allow-list only):**
  - SSH `22/tcp` → your admin IP(s) only.
  - SIP `5060/udp+tcp` (or `5061/tls`) → test softphone IP(s) only.
  - RTP `10000–20000/udp` (or VitalPBX default range) → test softphone IP(s) only.
  - AMI `5038/tcp` → **loopback + staging Connect host only** (never public).
  - HTTPS `443/tcp` (VitalPBX admin / staging portal) → admin IP(s) only.
  - **No route to any production host.**
- [ ] **Backups/snapshots:** enable provider snapshots; take a clean post-install snapshot ("golden staging") to allow fast reset between validation runs.
- **[APPROVAL GATE 1]** Approve VPS provisioning + budget + region + hostname before anything is created.

## 2. VitalPBX staging setup

- [ ] **Version target:** first read prod VitalPBX/Asterisk major version (read-only; e.g. from the brain snapshot or an owner-provided value) and install the **same major version** on staging (baseplan hook shapes must match).
- [ ] **Base install:** fresh VitalPBX; complete first-boot; confirm `asterisk -rx "core show channels count"` responds.
- [ ] **Test tenant:** create one tenant with a **test-only** name → slug `moh_stage` (verify `slug = name.toLowerCase().replace(/[^a-z0-9]+/g,"_")…` ⇒ `moh_stage`). Note its numeric `T<id>`.
- [ ] **Extensions:** create `101`, `102`, `103` (PJSIP) under the tenant → channels `PJSIP/T<id>_101…` etc.; set fresh staging secrets.
- [ ] **IVR:** 1 IVR, one digit (e.g. `1`) → `101`. Confirm VitalPBX generated `[T<id>_ivr-only-extensions]` with `__CALL_ORIGIN=RESTRICTED_IVR_CALL`.
- [ ] **Ring group:** 1 ring group over `102` + `103`. Confirm `[T<id>_ring-group-dial]` sets `__CALL_ORIGIN=ring-group`.
- [ ] **Queue:** 1 queue, agent `103`. Confirm `__QUEUE_AGENTS_CONTEXT=T<id>_queue-call-to-agents` + `[T<id>_queue-call-to-agents]`.
- [ ] **Outbound sandbox/echo route:** outbound route → a **local echo/test context** (e.g. `Answer()`+`Playback`/`Echo`) or Asterisk `*43` echo; **no real trunk**. Marks `__CALL_TYPE=3` on the leg.
- [ ] **MOH classes:** create `moh_stage_a`, `moh_stage_b`, `moh_stage_c` with short, distinct, non-customer audio (e.g. tone/spoken label) so the ear identifies the class.
- [ ] **Transfer test setup:** confirm softphones can do blind + attended transfer between `101/102/103` (feature codes/BLF as needed).
- **[APPROVAL GATE 2]** Approve creating the VitalPBX instance + this exact fake tenant/objects. **No production trunk. No prod SIP secrets. No customer data/audio/DIDs/CDRs.**

## 3. Connect staging setup

- [ ] **Staging DB:** separate Postgres; DB name MUST contain `stage`/`test` (e.g. `connect_stage`). Apply the branch's migration here (staging only).
- [ ] **Staging env vars (new staging-only files; never edit prod):**
  - `apps/api`, `apps/worker`: `DATABASE_URL` (staging), `CONNECT_ENV=staging`.
  - `apps/telephony`: AMI host/port/user/secret → **staging PBX only**.
  - `apps/portal`: API base URL → staging API; visible `staging` banner.
- [ ] **Staging AMI/API credentials:** generate fresh staging AMI user on the staging PBX; store only in staging env; never reuse prod secrets.
- [ ] **Staging tenant mapping:** seed `Tenant` (slug `moh_stage`) + `PbxInstance` + `TenantPbxLink` → staging PBX; seed `connect/pbx_tenant_map/<id>/{slug=moh_stage}` for the numeric `T<id>`.
- [ ] **Staging deploy target:** separate target (staging host/subdomain); production deploy scripts/behavior untouched.
- [ ] **Branch/commit:** deploy/run `feature/moh-per-call-source` @ `f3c3012c` from a clean checkout (the existing clean worktree `C:/dev/projects/_moh_worktree`).
- **[APPROVAL GATE 3]** Approve standing up the staging Connect stack + staging DB + staging env.

## 4. Safety-gate code changes (build BEFORE any PBX automation)

All additive, default-deny, and unit-tested. Exact sites:

| Gate | File(s) likely touched | Protection added | Prevents |
|---|---|---|---|
| Installer prints target host + refuses unclear target | `scripts/pbx/install-connect-tenant-moh-dialplan.sh` (preflight ~L327; tenant discovery ~L562/L1180) | Print resolved hostname + discovered tenant id/slug; require `--confirm-host <name>` to match; refuse if hostname unresolved/empty; add `--dry-run` | Running the installer against the wrong/prod box unknowingly |
| Installer refuses prod unless approved | same | If hostname does **not** contain `staging`, require `--allow-production` (default deny) | Accidental prod install |
| AstDB publisher prints tenant + keys before writes | `apps/telephony/src/routes/telephony.ts` (`/internal/ivr-publish` DBPut proxy + family-scope guard ~L335–500) | Log target `tenantSlug` + full `(family,key,value)` list before `DBPut`; keep the family-scope `family_scope_mismatch` guard | Writing keys to the wrong tenant/family |
| Staging host name guard | staging env loader / a small `assertStagingTarget()` helper (new, e.g. `packages/shared/src/env/target-guard.ts`) | Refuse to run staging tooling unless PBX host contains `staging` | Pointing staging tooling at prod PBX |
| Staging DB name guard | reuse pattern from `scripts/validation/moh_db_validation.ts` | Refuse DB whose name lacks `stage`/`test` (prod name `connectcomms` hard-blocked) | Migrating/mutating prod DB |
| Production requires explicit approval in deploy | `scripts/deploy-direct.sh`, `scripts/lib/deploy-common.sh` | Add explicit `--target staging` vs `--allow-production` gating for the new staging target; **do not alter existing prod path behavior** | Deploying branch to prod by mistake |

- [ ] **How tested:** unit tests for each guard (host-name accept/reject, DB-name accept/reject, installer target parse + refusal, publisher pre-write echo). Mirror the guard-refusal proof already used for `moh_db_validation.ts` (assert non-zero exit + refusal message, no side effects). Run on the clean worktree; capture PASS/FAIL.
- **[APPROVAL GATE 4]** Approve adding this safety-gate code (additive; prod paths unchanged) before it is written, and again before it is merged.

## 5. MOH validation sequence (staging only)

1. [ ] **DB migration** → apply to staging DB (`prisma migrate deploy`/`db push` on `connect_stage`).
2. [ ] **API/portal deploy** → deploy branch to the staging target.
3. [ ] **PBX installer** → run on staging PBX with `--confirm-host pbx-staging…` (prints host+tenant; dry-run first).
4. [ ] **AstDB publish** → publish MOH keys for `moh_stage` **only**, via telephony `/internal/ivr-publish` (family-scope guarded; publisher echoes keys).
5. [ ] **Source-policy setup** → configure all 6 levels: tenant default, global default, extension default, extension source policy, tenant source policy, scheduled override — each pointed at a distinct `moh_stage_*` class.
6. [ ] **Live-call matrix** → inbound_direct, outbound, internal, IVR, ring group, queue, blind transfer, attended transfer.
7. [ ] **Rollback validation** → tombstone per-source keys → confirm fallback; roll back installer → confirm prior resolver; confirm `ROLLBACK.sql` exists (run only if full destructive DB rollback is needed on staging).
- **[APPROVAL GATE 5]** Approve executing the sequence on staging (once §1–4 done). Each of steps 1–4 individually re-confirmed before running.

## 6. Expected proof after implementation

For **each** of the 8 scenarios, capture:
- [ ] **Asterisk CLI**: `dialplan show sub-connect-tenant-moh`; during a held call, `core set verbose 5` + the resolver `NoOp(… call_type=… origin=… moh_src=… )` line from `/var/log/asterisk/full`.
- [ ] **`MOH_SRC`** value (expected: inbound_direct / outbound / internal / inbound_ivr / inbound_ringgroup / inbound_queue / transfer).
- [ ] **`CONNECT_MOH`** value (`__CONNECT_MOH` set by resolver).
- [ ] **`CHANNEL(musicclass)`** on the held leg (`core show channel <chan>` or the `NoOp`/`Set` trace) = expected `moh_stage_*` class.
- [ ] **Resolved policy level** matches intent (extension source / extension default / tenant source / tenant default / global default / PBX fallback).
- [ ] **Audio confirmation**: the distinct `moh_stage_*` audio actually plays when the call is placed on hold.
- [ ] **No-routing-change**: no extra Dial legs, no Local loop, no fake Answer, no CDR/recording change (compare `ConnectCdr` + `core show channels` before/after).
- [ ] **Regression proof**: normal inbound_direct/internal/IVR/ring-group/queue do **not** show `moh_src=transfer`; only real blind/attended transfers do. IVR routing, ring group, queue, transfers, voicemail fallback, forwarding, pickup, recording, hold/resume, parking, mobile-app behavior unchanged.
- [ ] **Hidden sources**: UI hides `mobile_app` + `parked`; legacy policies preserved/inactive.
- [ ] Save CLI transcripts + screenshots into a staging proof doc (e.g. `docs/pbx/moh-staging-proof.md`).

## 7. Estimated time & risk

- **Fastest path:** reuse an existing non-prod VitalPBX host (if one can be nominated) → skip VPS provisioning; ~0.5–1 day to configure tenant/objects + staging Connect + run matrix.
- **Safest path (recommended):** dedicated VPS + fresh VitalPBX matching prod version + full safety gates first → ~1–2 days setup + 0.5 day validation. Golden snapshot enables clean re-runs.
- **What can go wrong:**
  - VitalPBX version mismatch → baseplan hook shapes differ → false pass/fail. *Mitigation: match major version.*
  - NAT/RTP realism on a small VPS → audio path issues. *Mitigation: proper firewall/RTP range + real softphones.*
  - Env mis-pointing staging→prod. *Mitigation: §4 gates + name guards + separate secrets.*
  - Trunk temptation for outbound. *Mitigation: echo/sandbox only unless approved.*
- **Approvals required before each phase:** GATE 1 (VPS) → GATE 2 (VitalPBX+fake data) → GATE 3 (staging Connect+DB) → GATE 4 (safety-gate code, write + merge) → GATE 5 (run validation; each of DB/API/installer/AstDB re-confirmed).

---

## Approval gates (summary)
1. **[GATE 1]** Provision staging VPS (budget/region/hostname).
2. **[GATE 2]** Build staging VitalPBX + fake tenant/extensions/IVR/RG/queue/echo route/MOH classes (no prod trunk/secrets/data).
3. **[GATE 3]** Stand up staging Connect stack + staging DB + staging env.
4. **[GATE 4]** Write + merge safety-gate code (additive; prod paths unchanged).
5. **[GATE 5]** Execute the MOH validation sequence on staging (each sub-step re-confirmed).

## Confirmation
No implementation, no provisioning, no production change, no deploy, no migration,
no PBX installer, no AstDB mutation, no VitalPBX change occurred. This is the
checklist deliverable only.
