# AGENT HANDOFF — Can Connect drop the VitalPBX One subscription and run its own multi-tenant on top of free VitalPBX? (2026-08-18)

**Read-only investigation. No code change, no deploy, no PBX write, no env change,
no license touched.** Izzy's question, verbatim: *"I'm paying for the VitalPBX One
plan every month, and I'm capped out on extensions. Can we build around the existing
VitalPBX to make our own multi-tenant, so I can cancel the subscription, keep the
free version, and have our own multi-tenant? How much will change, how big a project,
is it even possible?"* — and his follow-up: *"all trunks and outbound routes already
exist in the main tenant … the issue is only the routing of the call … if I stop the
subscription, the only thing that we use is the multi-tenant. Everything else we
keep."*

Short answer, up front:

- **Possible: yes.** Asterisk checks no license. Every cap is enforced by the
  ionCube-encrypted **panel, at save time**. Everything already generated onto disk
  (27 tenants, 119 extensions, 49,149 lines of conf, the AstDB) keeps running the day
  the subscription stops.
- **"The only thing we use is multi-tenant" is not what the free tier says.** The
  Community edition caps the PBX at **12 extensions total**, **20 provisioned desk
  phones**, **1 country** in the geo-firewall, **1 tenant**, **0** VitalPBX Connect
  devices. We have 119 / 55 / several / 27. So after cancelling, the panel refuses
  the 13th extension anywhere, not only the 28th tenant. That is why "our own
  multi-tenant" has to mean **"Connect generates the per-customer Asterisk config
  itself"** — endpoints, dialplan, voicemail, routing — not "our own tenant table
  on top of VitalPBX's extensions".
- **Izzy's core insight is right and it is what makes this feasible:** trunks (66),
  outbound routes (56) and route selections (80) all live in the **Main** tenant
  (tenant 1, 3 extensions — under the free cap), and Connect already owns the
  inbound door (`connect-doorway`), the IVR engine (`connect-menu`), the mobile wake
  path, tenant MOH and the AMI/ARI layer. Roughly half of a multi-tenant PBX is
  already ours. The other half — the per-tenant *extension* dialplan VitalPBX
  generates (605 lines per tenant), the pjsip endpoints, voicemail.conf, ring
  groups, queues, hints, provisioning — is the project.
- **Size: a real project, not a switch.** Honest estimate **2–4 months** of focused
  engineering for a staged, no-downtime cutover, then permanent ownership of a PBX
  config generator. Sequenced correctly it starts paying back in weeks (Phase 1
  un-caps *new* customers immediately) and the subscription is cancelled **last**,
  after a rehearsed lapse on a clone. Details below.

---

## 1. What the PBX actually runs (read live 2026-08-18)

| Fact | Value | How read |
|---|---|---|
| VitalPBX | **4.5.3-1** on Debian 12, Asterisk **20.18.2** | `dpkg -l`, `core show version` |
| Add-ons installed | multi-tenant, api, custom-contexts, phones-provisioning, geo-firewall, sms, queues-callback, voice-hub, ai-assistants, whatsapp, crm, dynamic-destinations, openvpn, paging-pro, phone-books, bulk-extensions, branding, maintenance, monitor, task-manager, ivr-stats, authentication-codes, connect, i18n; sonata-{billing,dialer,recordings,stats,switchboard}; vitxi 4.6.0 | `dpkg -l` |
| License store | `/var/lib/pbx-licenses/vitalpbx.lic` (1,533 B, **binary/obfuscated**, mtime **2026-08-03 20:32**) + `vitalpbx.dat` (2025-07-27) | `stat` |
| Enforcement code | `www/modules/core/APPLicense.php`, `www/includes/addons/license.php`, `www/includes/addons/vitalpbx_multi_tenant.php`, `modules/licensing_usage/*`, `modules/tenants/*` — **all ionCube-encoded**, unreadable | `head -c` |
| License server | `licensing.vitalpbx.com` (research); no cron/timer on the box does the check — it is the panel itself | crontabs, `systemctl list-timers` |
| Tenants / extensions / devices | **27 / 119 / 167** (137 pjsip, 30 virtual "ring my cell", 41 WebRTC `_1`, 30 `mobile_client=yes`) | `ombutel` |
| Per-tenant extension counts | T2 21, T8 18, T9 11, T7 9, T11/T18/T28 7 … T101/T102 (test tenants) 2 each | `ombu_extensions` |
| Trunks / outbound routes / route selections / inbound routes / tenant DIDs | **66 / 56 / 80 / 74 / 47** — all trunks + routes + ARS under **tenant_id 1 (Main)** | `ombutel` |
| Ring groups / queues / IVRs / time conditions / parking lots / custom apps+dests / announcements | **94 / 8 / 38 / 14 / 27 / 22+9 / 33** | `ombutel` |
| Provisioned desk phones | **55** devices, 689 provisioning accounts; 131 `phoneprov` fetches today | `provisioning.*`, nginx |
| VitXi / Sonata Switchboard use today | **0 / 0** requests in today's nginx log; vitxi has 22 users, 1 touched in 30 d | nginx, `vitxi.users` |
| Generated config | `/etc/asterisk/vitalpbx/`: **546 files, 49,149 lines** — extensions 36,627, pjsip 8,250, voicemail 376, queues 434, confbridge 419, MOH 281. Baseplan **3,305 lines** (`extensions__20-baseplan.conf`, ~150 feature subroutines). One tenant (T5, 4 ext) = **817 lines** across 13 files, of which dialplan **605**, pjsip **108** | `wc -l` |
| Connect-owned dialplan already on the box | `extensions__60_custom.conf` **601 lines** (connect-menu engine etc.), `extensions__96-connect-doorway.conf`, `__95-connect-vm-greeting`, `__96-connect-vm-drop`, `__97-connect-probe`, `__65_connect_tenant_moh`, `musiconhold__60-connect-uploads.conf` | `ls` |
| AstDB | 17,071 keys: `CustomDevstate` 3,768, `devices` 3,155, **`connect/` 2,338**, then per-tenant hash families (`f3df739ac62197cd` 1,262 …) | `database show` |
| Extensions with ANY registration in 30 days | **~76 of 119** (from `PbxEndpointRegistrationEvent`, `T<t>_<ext>` and `_1` folded). The other ~43 include the 30 virtual-only "ring my cell" ones, which never register — so this is NOT "43 dead slots"; it is an upper bound to audit | Connect DB |

## 2. How the license is enforced — and what stops when it lapses

- **Where:** entirely in the panel. Asterisk, the generated conf, AstDB, the REST API
  daemon and the helper never consult it. The i18n strings name the exact gates:
  `extensions.max_reached = "You have reached the maximum number of allowed
  extensions."`, `extensions.vitxi_clients.max_reached = "…maximum number of
  Mobile/WebRTC clients allowed for your current license."`,
  `mobile_devices.validation.license_limit` (VitalPBX Connect devices),
  `tenants.no_license = "You have reached maximum number of free tenants. Activate
  this add-on with a valid license to create unlimited tenants"`,
  `provisioning.licensing.max_reached`, `queues.max_reached`, `ivr.max_reached`,
  `trunks.max_reached`, `parking.max_reached`, `geo_firewall.license.max_items = "You
  may only block one country on the free version"`, and the generic
  `app.license.max_items = "You have reached the maximum number of free items allowed
  on this module"`.
- **When:** at **save** (creation, and probably edit) — an item cap, not a runtime
  gate. VitalPBX's own wiki: *"All of our commercial add-ons can be installed even if
  you don't have a license… the only constraint is the number of items you can
  create within an add-on."* Their EULA: on lapse *"you will be left with the
  Community edition"*.
- **Free (Community) caps that matter to us** (official comparison table,
  vitalpbx.com/pbx-features, 2026): **12 extensions**, **1 tenant** (a 2023 forum
  FAQ said main + 1 test tenant), **20 provisioned phones**, **VitXi 2**, **VitalPBX
  Connect app 0**, **geo-firewall 1 country**, queue callback 1, IVR stats 1, Sonata
  Stats 8 agents / Switchboard 15 ext. **Free and unlimited:** Custom Contexts (our
  doorway hook), Dynamic Destinations/Routing, Bulk Extensions, **API v2**, HA.
- **⚠️ NOT PROVEN, and it is the one thing that must be rehearsed before cancelling:**
  what the panel does to the **existing** 27 over-cap tenants after the lapse —
  whether Apply Changes / `fully-gen-conf` keeps regenerating their files, refuses,
  or (worst case) regenerates *without* the multi-tenant module and drops the
  `T<t>_*` files. Nothing public documents this and no forum thread describes a real
  expiry. **A full PBX snapshot already exists on the box**
  (`/root/pbx-full-brain-20260609-063057/`, the "pbx-brain" dump) — stand it up on a
  throwaway VM, revoke/let the license lapse there, and watch. That rehearsal is
  step zero of any plan below and costs a day.
- I could not read the panel's own **Licensing Usage** screen (Admin → Licensing
  Usage: *Module / Used Items / Allowed Items* for extensions, tenants, Connect App,
  MS Teams) — the robot account's role lacks the module. **Izzy can open it in ten
  seconds and it answers "how many do I have left" exactly.** The plan's tier ladder
  (which extension counts cost what) could not be confirmed from the web either; the
  invoice knows.

## 3. What Connect depends on from VitalPBX today (the "how much changes" answer)

Full inventory in the report below (§7). Summarised by bucket, with what happens to
each if Connect owns the generator:

| Bucket | Today | If Connect generates the config |
|---|---|---|
| **A. Panel replay** (`POST /index.php` — `panelClient.ts`, `pbxTenantBuild.ts` 644 lines, `teamBuilder.ts`, `forwardBuilder.ts`, `arsMemberToggle.ts`, `emergencyProvisioning.ts`, `retireTempPbxRoute.ts`, robot tools) — ~12 modules, ~40 form POSTs | The only write path that works | **Deleted**, not replaced — along with `applyRegenRebake.ts`, the doorway self-heal, the `_chown_gui_conf` panel-lockout workaround, and the whole "Apply Changes wipes the doorway" class of incident |
| **B. VitalPBX REST v2** (`packages/integrations/src/vitalpbx/client.ts`, ~49 sites in `server.ts`) | Reads: tenants, extensions, devices/deviceProfiles, **cdr.list**; writes mostly `throw NOT_SUPPORTED` already | Shrinks to nothing; **CDR** needs a replacement (read Asterisk's own `cdr` table — the CDR ingest already rides telephony/AMI for live calls) |
| **C. Direct `ombutel.*` reads** (16 api modules, user `connect_read`: DID→tenant sync that **E911 billing** counts, queue directory + `asterisk.queues_log`, ring-group list, MOH/prompt sync, provisioning tables, `ombutel.states`, ARS/outbound profiles for the **overdue cutoff**) | The de-facto API for everything REST won't do | **The real hidden cost** — each becomes a Connect-owned table/query. Nothing here is hard; there is just a lot of it |
| **D. The PBX helper** (`vitalpbx-inbound-route-helper.py`, 4,308 lines, ~70 % VitalPBX-shaped: bakes into `extensions__50-<t>-dialplan.conf`, `apply_tenant_changes` via REST, MOH patches, voicemail spool by `<slug>-voicemail`, doorway rows in `ombu_custom_contexts`) | Connect's private write plane | Roughly half disappears (baking, apply, MOH patching, destination decoding); the voicemail/spool, greeting, media-sync and doorway halves stay |
| **E. Naming conventions** (`T<t>_<ext>`, `T<t>_<ext>_1`, `T<t>_cos-all`, `T<t>_Q<ext>`, `<slug>-voicemail`, `<tenantHash>/extensions/<n>/dial`, `<tenantPath>/diversions/…`) in telephony, api, mobile | Parsed everywhere; the **cross-tenant leak guard** works off `T<n>_cos-all` | **Keep the names.** If our generator emits the same endpoint/context names, nothing in telephony/mobile/portal changes and no phone or app is re-provisioned |
| **F. Add-ons** | multi-tenant (load-bearing), custom-contexts (doorway hook), custom app/dest (forwards), **phones-provisioning (55 desk phones)**, geo-firewall (several countries), VitXi/Connect-app **not used**, Sonata **not used in code**, SMS add-on **not used** | Multi-tenant → ours; forwards → plain dialplan; **provisioning must be rebuilt** (free cap 20 < 55); geo-block → our own ipset job (small) |
| **G. Portal/mobile refs** | Thin | Rename-scale |

**Already Connect-owned and Asterisk-native (the seed of "our own multi-tenant"):**
`connect-doorway` (DID → tenant via `DB(connect/didmap/<did>/tenant)`), the
`connect-menu` / `connect-tenant-ivr` / `connect-tenant-router` engine + AstDB key
families (`connect/didmap/*`, `connect/t_<slug>/*`, `connect/pbx_tenant_map/*`),
`connect-wake-core` + `Local/…@connect-mobile-wake-dial` (mobile wake-and-wait),
`connect-vm-drop`, tenant MOH + caller-leg MOH + `connect-media-sync`, uploaded MOH
classes `connect_<slug>_<name>`, and the entire `apps/telephony` AMI/ARI layer.
Emergency calling was already proven to work as a straight `Gosub(trk-<id>,…)` with
no outbound route in the path — i.e. Connect dialplan can dial a VitalPBX-generated
trunk directly.

## 4. What "our own multi-tenant" would have to produce (per customer)

This is the list VitalPBX's generator makes today and we would make instead. Sizes
are the live footprint, so nobody guesses:

1. **PJSIP endpoint/auth/aor** per device — desk (`T<t>_<ext>`, profile p1),
   app/WebRTC (`T<t>_<ext>_1`, the p12 wss/DTLS template — plain pjsip, nothing
   VitXi-specific in the rendered block), virtual "ring my cell" (30 today, rendered
   as a Dial to an outside number). ~30 lines a device; 167 devices. Passwords are
   readable in `ombu_devices`, so migration keeps every credential and **no phone or
   app changes**.
2. **Per-tenant dialplan** replacing `T<t>_cos-all` and friends (605 lines/tenant
   today, built from a 3,305-line baseplan): internal dialling, ring desk + app +
   cell together (wake path exists), busy/no-answer → voicemail, DND / call-forward /
   follow-me (today AstDB `<tenantPath>/diversions/…`), MixMonitor recording **in the
   same file layout Connect's players resolve today**, caller-ID construction,
   pickup, transfers, feature codes (*97 etc.), **BLF hints** (`T<t>_extension-hints`,
   the desk phones' keys), **ring groups (94)**, **queues (8, Gesheft)**, time
   conditions (14), parking (27 lots), the 38 legacy VitalPBX IVRs (→ Connect Studio,
   which is what the `feat/ivr-migration-takeover` branch exists for).
3. **voicemail.conf** per tenant, keeping `[<slug>-voicemail]` and the spool path
   (Connect's voicemail ingest, players and the guardrails all key on it).
4. **Outbound**: per-tenant outbound *profile* → the right trunk with the right
   caller ID (Trust Bookkeepings runs **9** profiles; four customers' first profile
   carries another company's CID — see the emergency-calling handoff). Trunks stay
   VitalPBX-generated in Main. The **overdue-account cutoff** (`arsMemberToggle`)
   becomes a Connect flag in our own dialplan — simpler than today.
5. **Inbound**: DID → tenant. The doorway already does this for Connect-mode numbers;
   extend to every number (today VitalPBX's `verify-did` + per-tenant inbound routes).
6. **MOH** per tenant (helper already writes `connect_*` classes), **hints/devstate**
   for BLF and queue agent state, **queues.conf**, **CDR** attribution (keep
   `T<n>_cos-all` naming so `pbxTenantResolve` and the leak guard are untouched).
7. **Desk-phone provisioning** for 55 phones (free cap 20): a Yealink/Polycom
   config-template generator + the MAC-named files nginx already serves — VitalPBX's
   templates are on disk to copy the shape from.
8. **Reload orchestration**: `pjsip reload`, `dialplan reload`, `voicemail reload`,
   `queue reload` — targeted, no whole-system regen, no more doorway wipes.
9. **Replace the 16 `ombutel.*` readers** and the REST reads with Connect's tables.
10. **Geo-blocking** as our own ipset/iptables job (the panel's `build_firewall_
    blacklists` cron will only keep 1 country on the free tier — verify on the clone).

**Not needed at all** (verified unused): VitXi, VitalPBX Connect app, Sonata
Switchboard/Stats/Billing/Dialer/Recordings, the SMS add-on, AI assistants, MS Teams.

## 5. Options, sized honestly

| # | Option | Cost | What you get | Risk |
|---|---|---|---|---|
| 0 | **Reclaim slots now** (buy time) — audit the ~43 extensions with no registration in 30 d (minus the 30 legitimate virtual ones), delete the two test tenants T101/T102 (4 ext incl. "Claude Test" 199), review the 30 `mobile_client=yes` "VitalPBX Connect device" rows (their app; we don't use it) | days | maybe 10–20 slots | panel deletes have the orphan-`mobile_client` fatal (documented); each is a PBX write needing a mandate |
| 1 | **Move up a tier / annual** — read Admin → Licensing Usage for used/allowed; the ladder wasn't confirmable online (floor: 25 ext for $225/yr; a $125/mo entry exists) | $ | keeps everything as is | none technical |
| 2 | **Hybrid — Connect-generated config for NEW customers first, existing 27 stay on VitalPBX's files under the current license** | **~4–6 weeks** for a first generator (endpoints, tenant dialplan for the features new sign-ups actually get, voicemail, hints, MOH, inbound via doorway, outbound to their trunk, reloads) + onboarding switched to it | **Un-caps immediately** — extensions the panel never sees don't count. Onboarding gets simpler and faster (no panel replay, no Apply Changes) | Two config styles on one box until migration finishes; `pbxExtensionSync` and the ombutel readers need a Connect-native source for the new tenants |
| 3 | **Migrate the 27 existing tenants** onto the generator (byte-identical endpoint names, keep passwords, per-tenant cutover on a clone first), rebuild provisioning for the 55 phones, move the 38 legacy IVRs into Studio, replace the ombutel readers, then **rehearse the lapse on the clone and cancel** | **another ~6–10 weeks** | subscription gone; the panel replay layer, the bake/apply dance and the doorway-heal machinery are deleted; one owner of the phone system's config | Ring-group / follow-me / feature-code parity is where customers feel any gap; provisioning is the fiddliest piece; a customer admin who logs into the VitalPBX panel today (56 `tenants_users` rows) loses that screen |
| 4 | Different platform (FusionPBX/FreeSWITCH, Wazo, Kazoo…) | months–year | — | throws away every proven piece of Connect dialplan and the AMI/ARI layer; not recommended |

**Recommendation:** Option 0 this week if a few slots buy breathing room; then Option
2 → 3 as one project, **cancel last**. Total ≈ **2–4 months** of focused work with a
clone-first cutover. The order matters: cancelling first, or "just letting it lapse
to see", is the one sequence with a real outage in it (see §2 unproven).

## 6. What was NOT proven / left open

- The behaviour of the panel and its regenerators on the 27 over-cap tenants after a
  lapse (§2) — clone rehearsal needed.
- The One plan's tier ladder and what the current invoice covers — read the invoice
  and Admin → Licensing Usage.
- Whether the free tier caps trunks (a `trunks.max_reached` string exists; the
  feature table lists no cap). Existing trunks stay on disk regardless; a generator
  can also emit trunk endpoints if it ever has to.
- Whether any customer admin actually signs into the VitalPBX panel today.
- Nothing here was exercised by a human; every number is a live read.

## 7. Source inventory (for whoever builds it)

*(Verbatim from the repo sweep run for this assessment; paths + lines as of
`feat/ivr-migration-takeover` 2026-08-18.)*

**Panel replay:** `apps/api/src/onboarding/panelClient.ts` (engine: login, `sid` +
`vpbx_tenant` cookies, `csfr_token`, `applyChanges()` = `call=generateConfigurations`),
`apps/api/src/onboarding/pbxTenantBuild.ts` (trunk → outbound route → ARS → tenant →
extensions CSV → inbound route; `applyChanges` ×6), `onboarding/vitalpbxTemplate.ts`
(58-column CSV, `Default WebRTC Profile` + `vitxi_client=yes`), `pbx/teamBuilder.ts`
(ring groups/queues), `pbx/forwardBuilder.ts` (custom app + dest, the only writer
that fires Apply), `pbx/applyRegenRebake.ts`, `onboarding/retireTempPbxRoute.ts`,
`onboarding/portLanding.ts`, `onboarding/setupOrchestrator.ts` (robot pool),
`agentProvisioning/addPhoneNumberCapability.ts`,
`billing/serviceInterruption/{emergencyProvisioning,arsMemberToggle,serviceInterruptionBoot}.ts`,
`tools/connect-robot/*` (`/opt/connect-robot/`).

**REST v2:** `packages/integrations/src/vitalpbx/{client.ts,endpointRegistry.ts}`;
callers `server.ts:705-711` + ~49 sites (`vitalListByResource` etc. behind
`/voice/pbx/resources/:resource`), `pbxExtensionSync.ts`, `pbxTenantDirectorySync.ts`,
`pbxLiveAriSlice.ts`, `apps/worker/src/pbxWebrtcDriftReconcileCycle.ts`,
`apps/agent/src/pbx/client.ts`; the helper's `apply_tenant_changes` (`UPDATE
/api/v2/tenants/<id>/apply_changes`).

**`ombutel.*` readers (apps/api):** `pbxOmbutelInboundDidSync.ts` (E911 billing),
`pbxTenantResolve.ts`, `pbxQueueDirectory.ts` + `pbxQueueStats.ts`
(`asterisk.queues_log`), `pbxOmbutelRingGroupList.ts`, `pbxOmbutelMohClassSync.ts`,
`pbxOmbutelPromptSync.ts`, `pbxPhoneProvisioning.ts` (`provisioning.*`),
`pbxTenantInboundDidSync.ts`, `mohReverseMapPublish.ts`,
`billing/serviceInterruption/{serviceInterruptionBoot,serviceInterruptionPlan,arsMemberToggle}.ts`,
`onboarding/emergencyStateId.ts` (`ombutel.states`), `onboarding/{retireTempPbxRoute,portLanding}.ts`,
`server.ts` (recordings/ivrs/music groups), `pbx/{teamBuilder,forwardBuilder}.ts`,
`ivrMigration.ts`. telephony/worker/agent: none (AMI/ARI or via api).

**Helper:** `scripts/pbx/vitalpbx-inbound-route-helper.py` — bake (L2629-2858),
apply (L2893-2946), chown-back (L1013-1044), tenant path (L1609), DND/CF diversions
(L1625-1662), MOH (L683-1318), voicemail (L1811-2472), doorway (L251-682),
destination decoding (L2524-2628), IVR/queue ops (L3076-3829), routes (L3862-4008).

**Naming parsers:** `apps/telephony/src/telephony/normalizers/normalizeExtension.ts:62-72`,
`CallStateStore.ts`, `TelephonyService.ts` (`_cos-all`), `TenantResolver.ts`,
`apps/api/src/pbxTenantResolve.ts:29` (leak guard),
`packages/integrations/src/vitalpbx/amiLiveEndpointRead.ts:172`,
`apps/api/src/voiceProvisioningBundle.ts:9`, `apps/mobile/src/sip/jssip.ts:813,2770`,
`apps/telephony/src/routes/{dndPublish,wakeCanaryPublish,wakeDialPublish,voicemailDropLegs}.ts`,
`apps/api/src/pbxQueueDirectory.ts:81` (`T<t>_Q<ext>`), `ivrMigration.ts:22-341`
(destination-ref dialect).

**Boundary that already exists:** `scripts/pbx/install-connect-caller-leg-moh.test.ts:266`
and `install-connect-cos-wake-overlay.test.ts:100` assert Connect never writes
`extensions__50-`, `pjsip__`, `musiconhold__`, `queues__` files — the generator
would be the first Connect code allowed to, under its own file names.

## 8. Research sources (licensing)

- Feature/plan comparison table: https://vitalpbx.com/pbx-features/ (Community vs
  VitalPBX One columns — the caps quoted in §2).
- One plan page: https://vitalpbx.com/vitalpbx-one-pbx-plan/ ("start with 25
  extensions … $225 per year"); store: https://vitalpbx.com/vitalpbx-store/ ($125
  monthly entry, variants not readable).
- Wiki on licensing (item caps, install-without-license):
  https://wiki.vitalpbx.com/wiki/vitalpbx/licensing/ ; custom contexts free:
  https://wiki.vitalpbx.com/wiki/vitalpbx/custom-contexts/
- Forum FAQ on free tenants: https://forums.vitalpbx.org/t/do-you-have-multi-tenant/3119 ;
  Starter EOL / subscription move: https://forums.vitalpbx.org/t/forced-subscription-policy-with-1-day-notice/5419
- EULA (lapse → Community): https://vitalpbx.com/eula/
- Press release, VitalPBX One (2026-07-14): https://www.einpresswire.com/article/926594555/
