# ⛔ AGENT HANDOFF — dropping the VitalPBX One subscription: POSSIBLE, but "we only use the multi-tenant" is wrong — the free tier caps EXTENSIONS at 12 (2026-08-18) — READ FIRST before answering "can we cancel VitalPBX?", before touching the license, or before sizing "our own multi-tenant"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full assessment: **`docs/ai-context/AGENT_HANDOFF_VITALPBX_LICENSE_EXIT_ASSESSMENT_2026-08-18.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no license touched.**
Memory: [[vitalpbx-license-is-panel-only-item-caps]].)

- ✅ **Possible: Asterisk checks NO license.** Every cap lives in the ionCube-encrypted
  panel and fires **at save time** (`extensions.max_reached`, `tenants.no_license`,
  `provisioning.licensing.max_reached`, `extensions.vitxi_clients.max_reached`, …).
  The 27 tenants / 119 extensions / 49,149 lines of generated conf / AstDB keep
  running the day the plan stops. License file `/var/lib/pbx-licenses/vitalpbx.lic`
  (binary, refreshed 2026-08-03 by the panel; no cron on the box).
- ⛔⛔ **Izzy's premise "the only thing we use is multi-tenant" is not what the free
  tier says.** Community = **12 extensions on the whole PBX**, **20 provisioned
  phones** (we have 55), **1 country** geo-block, **1 tenant**, 0 VitalPBX Connect
  devices. So "our own multi-tenant" MUST mean **Connect generates the per-customer
  Asterisk config itself** (pjsip endpoints, tenant dialplan, voicemail, hints,
  ring groups/queues, provisioning), not "our own tenant table on top of VitalPBX
  extensions". ✅ His core point IS right and is what makes it feasible: **all 66
  trunks / 56 outbound routes / 80 route selections live in Main (tenant 1, 3 ext)**,
  and Connect already owns the doorway, `connect-menu`, wake-and-wait, tenant MOH
  and the AMI/ARI layer. Emergency calling already proved Connect dialplan can
  `Gosub(trk-<id>,…)` a VitalPBX trunk directly.
- **Size, honestly: 2–4 months**, staged: (0) reclaim dead slots now — ~76 of 119
  extensions registered anything in 30 d, but ~30 are legit virtual "ring my cell"
  and T101/T102 are test tenants; (1) **hybrid first — Connect-generated config for
  NEW customers (~4–6 wks) un-caps immediately** because the panel never sees them;
  (2) migrate the 27 tenants keeping **identical `T<t>_<ext>[_1]` names + passwords**
  (readable in `ombu_devices`) so no phone/app changes, rebuild provisioning, move
  the 38 legacy IVRs into Studio, replace the **16 `ombutel.*` readers** (E911
  billing's DID sync, queue dir, overdue cutoff's ARS toggle, `ombutel.states`);
  (3) **cancel LAST.** The panel-replay layer, the bake/apply dance and
  `applyRegenRebake` get DELETED, not replaced.
- ⛔⛔ **NOT PROVEN and must be rehearsed before cancelling:** what the panel does to
  the existing over-cap tenants after a lapse (regen refuses? drops `T<t>_*` files?).
  Nothing public documents it. **A full snapshot exists on the box —
  `/root/pbx-full-brain-20260609-063057/` — stand it up on a throwaway VM and let
  the license lapse THERE first.** "Cancel and see" is the one order with an outage.
- ⛔ **Verified unused, so nothing to replace:** VitXi (0 hits today), VitalPBX
  Connect app, Sonata Switchboard/Stats/Billing/Dialer (Connect reads
  `asterisk.queues_log` directly), the SMS add-on, AI assistants.
- ✅ **Izzy's follow-up "replicate EXACTLY what VitalPBX does, our own code, nothing
  changes" is the RIGHT route and is smaller (§9 of the doc, ~6–10 weeks):** a
  MIRROR generator that writes the same `ombutel` rows the panel writes (so the cap
  never runs and every Connect reader stays untouched) and emits byte-identical
  `extensions__50-<t>` / `pjsip__50-<t>` / `voicemail__50-<t>` / hints / AstDB /
  `<tenant-hash>/<mac>.cfg` provisioning files — acceptance = `diff` against the
  546 files on disk reads 0. ⛔ Do NOT rewrite `extensions__20-baseplan.conf` — it
  ships with the free edition we keep and every tenant dialplan calls into it.
- ⏳ **Izzy asked for a TWO-DAY A-to-Z plan (2026-08-18) — it is §10 of the doc:** scope
  = every write Connect makes FROM NOW ON goes through the mirror (tenant create,
  add extension/device, DID + inbound route, voicemail, hints, AstDB, reloads);
  the 27 existing tenants stay on VitalPBX's files. Day 0 = baseline fixture +
  clone with **Revoke License** to learn what the free panel still allows on
  over-cap tenants; Day 1 = diff harness + generator to 0 on T104/T5/T9/T2; Day 2 =
  wire onboarding + `addExtensionToTenant`, one real throwaway tenant end-to-end,
  cancel only after Day 0's table is read. NOT in two days: migrating existing
  tenants, a provisioning generator (interim clone-a-cfg), and ring groups /
  forwards / E911 / ARS-toggle for over-cap tenants if the clone says the panel
  refuses them.
- ✅✅ **DONE AND PROVEN ON PRODUCTION (2026-08-19, handoff §11–§13). A new tenant is created
  AND rendered entirely by Connect's own code, no licence; existing tenants are untouched and
  stay editable.** The clone confirmed the unlicensed panel refuses ONLY "create tenant". Prod
  (VitalPBX 4.5.3-1) then revealed the real behaviour: **no Apply Changes does a tenant's FIRST
  generation** (panel Apply AND the REST per-tenant apply both rendered ZERO files for a
  row-inserted tenant), so the mirror **renders the baseline itself** (the byte-identical
  `vitalpbx_mirror.py`). ⛔ **And once a tenant has baseline files, prod's INCREMENTAL Apply works
  normally** — adding an extension to a mirror-made tenant rendered + loaded through the ordinary
  panel path — which is exactly why the 27 existing tenants keep working after the lapse. Live
  acceptance: a full `buildPbxTenant` on prod created tenant 108 via the mirror, rendered 17 files,
  **4 PJSIP endpoints loaded** (desk + WebRTC × 2 extensions), inbound route, hints, voicemail,
  **doorways of T2/T35/T105 untouched**, then deleted (prod back to 27 tenants). helper
  `2026.08.19.2` (`/mirror/tenant-create` renders the baseline, `/mirror/tenant-render`
  re-renders; SELECT ON ombutel.* granted; ships vitalpbx_mirror.py + mirror_features.py); api
  DEPLOYED `1c1d067e` (baseline render at create + final re-render). **STRESS-TESTED
  2026-08-19 (§14): 10 tenants × 5 extensions built via the mirror on the LIVE PBX, all 10
  verified (17 files / 10 endpoints / vm / hints each), then deleted completely — PBX DB,
  files, AstDB, Main trunk/route/ARS rows, AND the 10 `PbxTenantInboundDid` rows Connect's DID
  sync had picked up; every count byte-back to baseline, doorways 0 cc-wipes throughout.**
  ⛔ Teardown re-proved the trap: a direct DB delete is NOT a pending change — Main's rendered
  files kept all 12 fake trunks until `ombu_queued_changes (1,26),(1,99),(1,42),(1,43),(1,110)`
  + `reload_dialplan=yes` + ONE Main Apply. ⛔ Tenant tests use fake 845-555-02xx numbers, never
  a real DID (routing collision).
  ✅✅ **ROUND 2, 2026-08-19 evening (handoff §20): 20 tenants × 10 extensions, all via the
  mirror, all 20 verified (17 files / 20 endpoints / 20 devices each), torn down to
  byte-baseline on BOTH systems** — and it earned four rules worth more than the run:
  ⛔⛔ **(1) VitalPBX's REST tenant list is a STALE CACHED SNAPSHOT** — it answered 31 rows
  against a DB of 35, then 41 against 27, for 40+ minutes across two Applies. **Resolve tenant
  membership from `ombutel.ombu_tenants` (MySQL), never REST**, for anything that decides
  existence. ⛔⛔ **(2) That staleness made the orphan sweep AUTO-MARK TWO LIVE CUSTOMERS
  REMOVED** (Comfort control + LUZER: delisted, links UNLINKED, autopay off, LUZER archived)
  when `sync-tenant-dids` was called mid-test — exactly 3 "orphans", inside the auto cap, and
  `isPbxAnswerHealthy` can't see a full-length lie. **Both restored within the hour; fixed in
  `9068acca`**: marking now requires MySQL to confirm each PBX tenant id is gone (`ConfirmGone`
  / `mysqlConfirmGoneVerifier`); no verifier or unreachable MySQL marks NOTHING; the confirm
  route 503s. ✅ Their fate was Izzy's call and he made it (2026-08-19 late evening, "Erase
  those two tenants"): **Comfort control ERASED** (no payments — row + user + extension
  cascaded), **LUZER ARCHIVED** (has PAID invoices — delisted, autopay off, the erase REFUSED
  by the money guard, books kept forever; ⛔ never "finish" it with a raw DB delete — the
  refusal is the feature). **(3) The tenant cascade does NOT clean
  `ombu_settings`** — every mirror tenant leaves `T<n>_reload`/`T<n>_reload_dialplan` rows (65
  orphaned rows from §13/§14/§18/§20 all cleaned, guarded on tenant-gone); and ⛔ the teardown's
  reload flag lives in **`ombu_settings`**, NOT `ombu_tenant_settings` — the wrong table
  silently no-ops and Main's dialplan keeps every stale ARS context (check with `ARS-[0-9]+`,
  `[0-9]*` matches `ARS-all`). **(4) The PBX→Connect sync auto-creates Connect Tenant shells**
  for stress tenants (14 appeared, 10 billable Extension rows each) — a teardown must erase
  them (money/user guards) and the 20 fake `PbxTenantInboundDid` rows too. ⛔ **Long api-side
  scripts run in `docker compose run --no-deps` one-offs** — an auto-deploy recreated
  app-api-1 mid-run and killed the in-container exec at tenant 28; `STRESS_START` resumes, and
  every build step adopts what an earlier pass created (proven live). ⏳ **Before cancelling:** one real phone-registers-and-call
  test on a mirror tenant; the free-tier untested items (manual extension form, provisioning
  past 20, geo-firewall) if used; ⛔ rotate the robot panel password.
- ⏳ **Izzy can read the exact used/allowed numbers in Admin → Licensing Usage**
  (robot role lacks that module). The One plan's tier ladder was NOT confirmable
  online (floor: 25 ext / $225 yr; a $125/mo entry exists) — the invoice knows.

## 2026-09-15 — SUBSCRIPTION CANCELED (Izzy's word). Provisioning verified ALIVE post-cancellation, read-only.

- Izzy reported the VitalPBX subscription canceled and asked whether the phone
  provisioning server / template generation still works and whether the backend
  can drive it. **Answer: yes to both, verified live 2026-09-15 (read-only SSH):**
  - **Serving:** `/phoneprov/f3df739ac62197cd/805e0c4d796d.cfg` answered **200,
    185,332 bytes, on BOTH http and https** from the box. Configs are STATIC files
    behind a plain nginx `alias` (§17 trap) — no license check at fetch time, ever.
  - **Generation:** the 20-phone cap lives ONLY in the panel's SAVE controller;
    `Device::generateProvisioningFile()` via `render_phone.php` was proven
    byte-identical on the UNLICENSED clone holding 55 phones (§17) and on prod.
    `/opt/connect-pbx-helper/` still carries `render_phone.php` + `console_writes.py`
    + `mirror_writes.py` — the backend path (helper `/console/phone-save|delete|render`,
    api PBX Console add/edit/delete/Rebuild/Resync) is installed and unchanged.
  - ⛔ **The license has NOT visibly lapsed yet:** `/var/lib/pbx-licenses/vitalpbx.lic`
    was refreshed **Sep 12 20:32** by the panel — cancellation likely means no renewal
    at term end, not an instant Community drop. The §"NOT PROVEN" items about
    post-lapse panel behaviour on over-cap tenants remain unrehearsed on prod;
    the mirror + console paths are the safety net either way.
  - ⚠️ Spotted in passing: `/var/lib/connect-pbx-helper/audit.jsonl` is **84.8 GB**
    (disk 63% used, 173 GB free — not urgent, but it needs rotation; helper change,
    Izzy's install button). **2026-09-15: rotation DESIGNED, not yet implemented —
    full design in the handoff's §26** (result-size cap in `audit()` is the real fix,
    in-process rename rotation bounds the file, installer renames the 85 GB aside and
    deletes only on Izzy's explicit flag). Summary:
    `2026-09-15-helper-audit-jsonl-rotation-design.md`.
