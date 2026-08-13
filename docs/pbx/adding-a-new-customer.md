# Adding a New Customer — Connect-only Runbook

**Audience:** Connect operator onboarding a new tenant / DID / MOH pack.
**Prerequisites:** Option A one-time PBX setup is complete
([`option-a-setup.md`](./option-a-setup.md)), including the DID-routing and
MOH-sync additions. After those one-time steps, every item below is done
from the Connect portal — **no SSH, no Asterisk edits, no VitalPBX UI work**.

---

## At a glance

| Step | Where | What |
|------|-------|------|
| 1    | Portal → Tenants              | Create tenant + set name (drives the slug). |
| 2    | Portal → PBX → Prompt Library | Auto-sync tenant recordings from VitalPBX. |
| 3    | Portal → PBX → IVR Routing    | Create Route Profiles (greeting/invalid/timeout + per-digit routing). |
| 4    | Portal → PBX → MOH Scheduling | Upload MOH audio + create Hold Profiles. |
| 5    | Portal → PBX → DID Routing    | Map each inbound DID → tenant + IVR + MOH profile. |
| 6    | Portal → PBX → DID Routing    | Click **Publish** per DID. |

If `PBX_INBOUND_API=1`, step 6 also auto-provisions the VitalPBX inbound
route and presets `__TENANT_SLUG` on the channel. Otherwise, do Step 3 from
`option-a-setup.md` **once** per DID (point the Inbound Route at
`connect-tenant-ivr,${CALLERID(dnid)},1` with `__TENANT_SLUG=<slug>`).

---

## Step 1 — Create the tenant in Connect

1. Portal → **Tenants → Add Tenant**.
2. The tenant **Name** is lowercased + slugged (non-alphanumerics → `_`) and
   becomes the AstDB family suffix: `connect/t_<slug>`. Pick something short
   and stable (renaming later does not rewrite AstDB keys — old keys are
   orphaned until the next publish).
3. Link the tenant to a `PbxInstance` (VitalPBX) row so Connect knows which
   PBX to target.

## Step 2 — Sync the tenant's prompt catalog

1. Portal → **PBX → IVR Routing → Prompt Library**.
2. Click **Auto-Sync from VitalPBX**. Connect queries the PBX's MariaDB
   (read-only), filters recordings to the tenant, and populates
   `TenantPbxPrompt` rows.
3. Every new recording uploaded in VitalPBX will be picked up on the next
   auto-sync (or the scheduled pull). No further action needed for prompts.

> **Tip:** If auto-sync reports "0 recordings found", confirm VitalPBX has
> recordings for that tenant (System Recordings tab) and that the
> `PbxInstance.ombuMysqlUrlEncrypted` is configured.

## Step 3 — Build Route Profiles

A **Route Profile** = one scheduleable IVR state
(Business / After Hours / Holiday / Override / Emergency).

1. Portal → **PBX → IVR Routing → Route Profiles → Add Profile**.
2. Pick greeting, invalid, and timeout prompts from the dropdowns (sourced
   from the synced catalog).
3. Add per-digit routes (Press 1 → `ivr-14,s,1`, Press 2 → `queue-sales,s,1`, etc.).
   Each destination must already exist in VitalPBX.
4. Under **Schedule**, set timezone, default / after-hours / holiday profile,
   plus weekly/holiday/one-time rules.

## Step 4 — Upload MOH + build Hold Profiles

1. Portal → **PBX → MOH Scheduling → Assets → Upload**.
   Upload WAV/MP3 files. Connect stores them locally and generates a unique
   MOH class name (`connect_<slug>_<humanname>`). The PBX-host cron pulls
   new files within ~5 minutes and runs `asterisk -rx "moh reload"` — only
   when files actually changed.
2. Portal → **MOH Scheduling → Profiles → Add Profile**.
   - Name: e.g. "Holiday Jazz".
   - VitalPBX MOH Class: the class name from step 1
     (`connect_<slug>_holiday_jazz`).
   - Optional: enable **Hold Announcement**, pick the announcement prompt
     from the dropdown (same catalog as IVR), set the repeat interval.
3. Under **Schedule**, set timezone + default / after-hours / holiday
   profile + rules (mirrors the IVR schedule, independent data).

## Step 5 — Map each DID

1. Portal → **PBX → DID Routing → + Add a DID mapping**.
2. Enter the E.164 number, pick the tenant, IVR profile, MOH profile,
   optional hold-announcement prompt, and optional PBX instance.
3. Save. The mapping is stored in Connect; nothing has hit the PBX yet.

## Step 6 — Publish the DID

1. In the DID Routing table, click **Publish** on the row.
2. Connect:
   - Snapshots the current `connect/didmap/<e164>/*` values (for rollback).
   - Writes the new values via AMI `DBPut`:
     `tenant`, `profile_id`, `moh_class`, `hold_announce`, `hold_repeat`.
   - If `PBX_INBOUND_API=1`: upserts the VitalPBX inbound route so the
     channel enters `[connect-tenant-ivr]` with `TENANT_SLUG` preset.
3. Click **Preview** to see the live runtime state (Connect DB side-by-side
   with the AstDB snapshot). Place a test call to verify.

> **Rollback:** In the DID Routing page, click **Rollback** on a publish
> record. Connect restores the snapshot AstDB values. If the PBX inbound
> route was also modified, the previous route payload is restored too.

---

## Post-onboarding day-2 operations

- **Change a greeting:** Record in VitalPBX → auto-sync → assign on the
  Route Profile → Publish. No Asterisk reload.
- **Change MOH track:** Upload new file in Portal → cron picks it up → pick
  the new MOH class on the Hold Profile → Publish. No Asterisk reload.
- **Swap a customer's greeting for a holiday:** Create a one-time schedule
  rule or flip the manual override. Effective on next inbound call.
- **Retire a DID:** DID Routing row → **Disable** (soft-delete, keeps
  history) or **Delete** (hard, only if the row was never published).
- **Move a DID between tenants:** Edit the mapping → Publish. AstDB is
  rewritten and the old tenant's didmap keys are cleared via the new publish.

---

## What **never** needs to happen on the PBX after the one-time setup

- No `dialplan reload` per publish.
- No per-tenant custom context. All tenants share
  `[connect-tenant-router]` / `[connect-tenant-ivr]` /
  `[connect-option-router]` / `[connect-hold-announce]`.
- No manual inbound-route edits (when `PBX_INBOUND_API` is enabled).
- No manual MOH class creation via VitalPBX UI (the PBX-host helper creates
  the directories under `/var/lib/asterisk/moh/`).
- No SSH from Connect to the PBX.

---

## Troubleshooting the onboarding flow

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Test call hits `connect-default-fallback` | DID not published yet, or `TENANT_SLUG` not set | Check `database show connect/didmap/<e164>` and VitalPBX inbound route settings. |
| Prompt dropdown is empty | Auto-sync never ran or PBX MariaDB URL missing | Run auto-sync from the Prompt Library tab. |
| Hold announcement silent on test call | `hold_announce` key empty | Check **MOH → Profile** has an Announcement Prompt selected and Publish succeeded. |
| New MOH file not playing | Cron hasn't run yet (≤5 min lag) | Run `/usr/local/bin/connect-media-sync.sh` manually; check `/var/log/connect-media-sync.log`. |
| Publish fails with `e164_already_mapped` | Another mapping owns this DID | Delete or disable the conflicting mapping first. |
| Publish fails with `cross_tenant_profile` | IVR/MOH profile belongs to a different tenant | Pick a profile owned by the DID's tenant. |
