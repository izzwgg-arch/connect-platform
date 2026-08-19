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

## 9. Izzy's follow-up (2026-08-18): "replicate exactly what VitalPBX does, our own code, nothing changes" — the MIRROR-GENERATOR route (recommended over §4/§5's own-dialplan route)

Everything VitalPBX produces is plain text on disk and readable even though its
generator is ionCube: 546 conf files, 160 rendered phone configs under
`/var/lib/vitalpbx/provisioning/provisioning_templates/<tenant-hash>/<mac>.cfg`,
17,071 AstDB keys, and the `ombutel` / `provisioning` MySQL tables (passwords
included; `provisioning.templates` has 53 rows). So the OUTPUT can be the spec, and
the acceptance test is mechanical: **run our generator against the live DB, `diff`
against every file on disk → 0.**

The mirror route, one layer under today's panel replay:
1. **Write the same `ombutel` rows the panel writes** (extensions, devices, tenants,
   inbound routes, ring groups, queues, DIDs) straight into MySQL — the panel's
   save-time cap never runs, and all 16 Connect readers, the helper, E911 billing,
   the queue reports, `T<t>_` numbering, tenant hashes, voicemail contexts and spool
   paths stay **untouched**.
2. **Emit the same files** — `extensions__50-<t>-dialplan.conf`, `pjsip__50-<t>-*`,
   `voicemail__50-<t>-main.conf`, `queues__`, `musiconhold__`, `res_parking__`,
   `manager__`, `extensions__25-<t>-hints.conf` — plus the AstDB keys VitalPBX
   seeds; same names, text, ownership (`www-data`, see the panel-lockout handoff).
3. **Render the same provisioning files** (`<tenant-hash>/<mac>.cfg`); the free
   "20 phones" cap is a panel-save cap, files we write are not counted; nginx
   unchanged.
4. Reload with `pjsip reload` / `dialplan reload` / `voicemail reload` /
   `queue reload`; never Apply Changes for tenants again (ends the doorway-wipe class).
5. **Do NOT rewrite the shared feature library** `extensions__20-baseplan.conf`
   (3,305 lines) — it ships with the free Community edition we keep installed, and
   every tenant dialplan just keeps calling into it. That is why no phone, app, or
   Connect component changes.

Limits, stated: we only know the output shapes the 27 tenants exercise (generate a
sample of anything unseen on the CLONE with the free panel, then diff); two writers
to one DB during migration (rule: tenants are ours, panel = Main/trunks only); the
§2 lapse rehearsal on `/root/pbx-full-brain-20260609-063057/` still comes first;
we pin to 4.5.3's schema/dialect (policy: no VitalPBX package updates without
re-running the diff); EULA check for whoever advises Izzy (our per-tenant files are
our config; the baseplan is part of the free edition we keep — not legal advice).

**Size, revised: ~6–10 weeks** — per-extension path (ext + desk device + app device
+ voicemail + hints) byte-identical first (~2–3 wks; new sign-ups can move to it at
that point and the cap stops mattering) → ring groups / queues / time conditions /
IVRs / tenants + DIDs + inbound routes (~2–3) → provisioning (~1–2) → tenant-by-
tenant cutover rehearsed on the clone (~1–2) → cancel LAST.

## 10. Izzy (2026-08-18): "A-to-Z plan, TWO DAYS, production-ready to migrate; existing tenants stay, only from here on" — the plan, and the honest scope

**His premise, checked:** *"if I cancel, existing tenants are not deleted, I just can't
create new ones."* Correct as far as anything runtime goes — nothing on the PBX
deletes config; Asterisk keeps every file. Two "ifs" remain, both cheap to settle:
(1) what the panel's **regenerator** does to the 27 over-cap tenants on its next
Apply Changes after the lapse (unknown — see §2); (2) "existing stays the same"
almost certainly also means **you cannot EDIT them in the panel either** (add an
extension to Gesheft, change a ring group) — so the panel-free path must cover
add-extension-to-EXISTING-tenant, not only new tenants. The panel has a **"Revoke
License"** button (`addons.revoke_license`), so the lapse can be simulated on the
clone in minutes instead of waiting for an expiry.

**What "two days" CAN mean (the scope of this plan):** every write Connect performs
from today on stops going through the panel and goes through a mirror generator that
writes the same `ombutel` rows and byte-identical files. The 27 existing tenants stay
on their VitalPBX-generated files untouched. Regularity measured live: a 1-ext tenant
(T104) = 644 lines / 14 files, 21 `ombu_tenant_settings` rows, 2 devices, 2 DIDs,
2 inbound routes, 3 queued_changes, ~25 AstDB keys per extension + ~6 per tenant; T104
vs T5 (4 ext) differ by 287 normalised lines = repeated per-extension blocks +
emergency + ARS. Tables an extension/tenant touches: `ombu_tenants`,
`ombu_tenants_users`, `ombu_tenant_settings`, `ombu_tenant_dids`, `ombu_extensions`,
`ombu_devices` (+`ombu_pjsip_devices`, `ombu_virtual_devices`), `ombu_extensions_vm`,
`ombu_extensions_contact_info`, `ombu_extension_diversions`, `ombu_extension_pea`,
`ombu_followme`, `ombu_inbound_routes` + `ombu_destinations`, `ombu_parking_lots`,
`ombu_classes_of_service`, `ombu_ars` (Main), `ombu_ami_users`, `ombu_queued_changes`,
`ombu_drivers_to_reload`.

**What two days does NOT include (say it up front):** migrating the 27 existing tenants
onto our generator (not needed under his premise); a full desk-phone provisioning
generator (the 55 rendered files stay; new phones get an interim clone-a-cfg script);
ring groups / queues / forwards / E911 / ARS-toggle for over-cap tenants **if** the
clone shows the free panel refuses those edits (then Day 3–5: `teamBuilder` and
`forwardBuilder` move to the mirror). Anything that does not `diff` to 0 does not ship.

### Day 0 (tonight, 3–4 h) — know before you cancel, and freeze the spec
1. **Baseline fixture from prod, read-only:** `sha256sum` of all 546 files in
   `/etc/asterisk/vitalpbx/`, `database show` dump, `mysqldump --no-data` +
   `--single-transaction` of `ombutel` and `provisioning` → `/root/mirror-baseline-<ts>/`
   on the PBX (also the rollback reference).
2. **Clone:** stand up `/root/pbx-full-brain-20260609-063057/` in a throwaway VM
   (fresh VitalPBX 4.5.3 ISO + restore). Then simulate the lapse: Admin → Add-ons →
   **Revoke License** (and, if it needs the server, delete
   `/var/lib/pbx-licenses/vitalpbx.lic` + restart php-fpm). Record: can the panel
   (a) create an extension in an over-cap tenant, (b) EDIT one, (c) create a ring
   group / queue / forward / inbound route, (d) run Apply Changes — and do the
   `T<t>_*` files stay **sha256-identical** after it, (e) still manage Main / trunks
   / ARS / provisioning. This table is the Day-2 exception list.

### Day 1 (build, ~10–12 h) — the mirror generator, proven against every tenant
1. **Diff harness first**: `scripts/pbx/mirror/diff-tenant` — render tenant *t* to a
   temp dir from the live DB and diff against `/etc/asterisk/vitalpbx/` + the AstDB
   family. Targets: T104/T105/T106 (1 ext) → T5 (4) → T9 (11, virtual devices) →
   T2 (21) read 0 on every file the mirror owns.
2. **Generator** as new endpoints in the helper (Python already runs on the PBX with
   MySQL access; new `/mirror/render` dry-run, `/mirror/tenant-create`,
   `/mirror/extension-add`, `/mirror/device-add`, `/mirror/did-route`): emits the 13
   per-tenant files + `extensions__25-<t>-hints.conf`, writes the table rows above,
   seeds the AstDB keys, chowns to `www-data` 0644, then `pjsip reload` /
   `dialplan reload` / `voicemail reload` / `module reload res_parking` (targeted —
   never `generateConfigurations`).
3. **Grants** for the helper's MySQL user on those tables (a PBX write → Izzy's Run
   button, SQL file, backup first).
4. New extension numbering / passwords: same rules the CSV path used
   (`T<t>_<ext>` + `_1` WebRTC device on profile 12, `vitxi_client` no longer needed
   for anything — but keep the column identical so the diff stays 0).

### Day 2 (wire + prove, ~10 h) — production-ready
1. `apps/api/src/onboarding/pbxTenantBuild.ts`: tenant → extensions → inbound route
   steps call the mirror; trunk / outbound route / ARS stay on the panel in Main
   **only if** Day 0 (e) said they still save; else the mirror emits
   `pjsip__50-1-trunks` blocks too. `addExtensionToTenant()` → mirror. Doorway
   registration for the new DID is already ours.
2. **Real proof on prod**: one throwaway tenant, 2 extensions, a spare DID: app
   registers (`pjsip show endpoint … Avail`), inbound call lands in `connect-menu`,
   outbound call over its own trunk with the right CID, voicemail left and emailed;
   then a panel-made twin of the same tenant on the clone is **byte-identical**.
3. Interim `clone-phone-cfg` for new desk phones (copy same-model
   `<hash>/<mac>.cfg`, swap MAC / account / password) — until the provisioning
   generator lands.
4. Cutover rules written down: tenants are the mirror's, the panel is for Main and
   for reading; **no Apply Changes for tenants, ever**; VitalPBX package updates
   frozen until the harness is re-run.
5. Tests + docs + deploy api; helper install = PBX write (Run button); CLAUDE.md +
   TESTS_RUN.
6. **Cancel only after Day 0's table is read** — the license stays until then.

## 11. DAY 0 DONE (2026-08-18/19): the lapse rehearsal — the free panel refuses ONLY "create tenant"

**Setup (all on loopcom, nothing on the live PBX but reads):** baseline fixture
`/root/pbx-mirror-baseline-20260818/` (sha256 of all 665 `/etc/asterisk` files,
`etc-asterisk.tgz`, `astdb.txt` 17,065 keys, `ombutel` + `provisioning` dumps,
`/var/lib/vitalpbx` incl. static, custom sounds, dpkg list). Offline dev DB:
docker `mirror-db` (MariaDB, 127.0.0.1:3307, root/mirror) with the prod dumps.
**The clone:** docker `vpbx-clone` (privileged systemd Debian 12, panel on
127.0.0.1:8443, `/root/pbx-clone/`): VitalPBX **4.5.3-8** from repo.vitalpbx.com
(prod is 4.5.3-1 — version drift, see below) + the same add-on set + redis, then the
prod `ombutel`/`provisioning` dumps imported over the fresh DB, prod `/etc/asterisk`
and `/var/lib/vitalpbx` copied in, AstDB seeded from the dump, Asterisk started
(162 endpoints). **`/var/lib/pbx-licenses/` is EMPTY = never licensed = Community.**
`pbx-brain` snapshot turned out to be a knowledge bundle, not a restorable backup —
this clone is built from the fresh dumps instead. Panel driven with Connect's REAL
code (`PanelSession`, `addExtensionToTenant`, `createRingGroup`, `createForward`,
`createInboundRoute`, `buildPbxTenant`) via `scripts/pbx/mirror/clone-rehearsal.ts`
through an ssh tunnel (`-L 18443:127.0.0.1:8443`), robot creds read from loopcom.

| Operation on the UNLICENSED clone (prod data, over-cap: 27 tenants / 120 ext) | Result |
|---|---|
| **Create a new tenant** (`class=tenants put/add`, and the tenant step of `buildPbxTenant`) | ⛔ **REFUSED**: *"You have reached maximum number of free tenants. Activate this add-on with a valid license to create unlimited tenants"* — proves the clone IS enforcing Community caps |
| Edit an existing tenant (`put/edit`, added an inbound number) | ✅ OK |
| DID Management assign (`class=did_management put/add`, part of the multi-tenant add-on) | ✅ OK |
| Add extension to over-cap tenant T104 (CSV import `menu4`, Connect's path) | ✅ OK (ext 199 created, no `extensions.max_reached`) |
| Add WebRTC `_1` device `vitxi_client=yes` (`extensions put/edit`) | ✅ OK |
| Ring group create (`teamBuilder.createRingGroup`) | ✅ OK (needs `lastDestination` — form rule, not license) |
| Forward = custom app + custom dest + Apply (`forwardBuilder.createForward`) | ✅ OK |
| Inbound route create (`createInboundRoute`) | ✅ OK |
| Trunk → outbound route → route selection in Main (`buildPbxTenant` steps) | ✅ OK (trunk 132 / route 129 / ARS 221) |
| Apply Changes after the extension add | ✅ regenerated **only T104's 7 files**; all other files sha256-identical to prod |
| `vitalpbx fully-gen-conf` (whole PBX) | ✅ all 27 tenants rendered ("Configuring Tenant: …"); 476 files re-dated, **56 with content diffs, ALL explained by 4.5.3-8 template drift** (`RG_DIAL_OPTIONS`/`AI_TRANSFER_ANNOUNCEMENT`, `include => T<t>_extension-hints`, `sub-toggle-tc-state(…,,no)`, TLS ciphers, `user_agent=VitalPBX`) **or by the same helper-patch reverts prod's Apply does today** (`moh3`→`default`, ring-group MOH). No license effect anywhere |
| **Tenant created by INSERTING ROWS ONLY** (clone T106's rows → tenant 107 with a fresh 16-hex path: `ombu_tenants`, `ombu_tenants_users`(user 45), 21 `ombu_tenant_settings`, `ombu_classes_of_service`, `ombu_dial_profiles`, `ombu_emergency_number_categories`, `ombu_maintenance`, 14 `ombu_numbers`, `ombu_parking_lots`, own `ombu_ars` row) | ✅ **the panel treats it as a real tenant**: `addExtensionToTenant` on it worked (ext 101 + `_1` device), Apply rendered `T107` files, `pjsip show endpoint T107_101_1` exists, AstDB family 67 keys; dialplan **matches T106's after normalising ids** except the CoS/ARS ids (its own) and the DID/emergency blocks I left out. Queuing modules 99/11/8/48 in `ombu_queued_changes` + Apply rendered confbridge/moh/res_parking too |
| NOT tested | extension form add (`mode=add`, Connect never uses it), provisioning add-phone (free cap 20), geo-firewall country count, VitalPBX-Connect device add, and whether an *expired* `.lic` behaves differently from *no* `.lic` (EULA says both = Community) |

**Consequence for the plan — Day 1/2 shrink to ONE new capability:** everything
Connect does today keeps working unlicensed through the existing panel path except
**tenant creation**. So the mirror v1 = **`create_tenant` row-writer** (the table
list above + `ombu_queued_changes` for modules 99/11/8/48/26 + the tenant's Default
inbound route row + `ombu_tenant_dids` for the DID + `outbound_profiles` = the ARS
id) run by the helper (Python on the PBX, MySQL user with INSERT on those tables),
after which `pbxTenantBuild` continues exactly as now (Apply Changes renders the
tenant, CSV import, devices, inbound route). The byte-identical renderer stays as
the verification harness and the fallback, not the critical path.
⚠️ Caveats that stand: clone panel is 4.5.3-8 vs prod 4.5.3-1 (a cap check could
differ between builds — re-run the same rehearsal on prod's version if the repo
still serves 4.5.3-1, or accept the small risk); "expired" vs "never licensed"
untested; robot panel password landed in this session's transcript by a shell
`eval` mistake — **rotate it** (panel user `lOOPCOMAGENT7548`, then update
`/etc/connect-robot/credentials.env` on loopcom and the api env).

## 12. DAY 1 + DAY 2 (2026-08-19): the mirror is BUILT, TESTED ON THE CLONE, api DEPLOYED — helper install + grants are the last two PBX writes

**What shipped (`c2d9fdd9` + `0edf4b00` on `feat/ivr-migration-takeover`; api DEPLOYED and
container-verified at `c2d9fdd9`, health 200):**
- `scripts/pbx/mirror/` — `mirror_writes.py` (**`create_tenant`** row-writer: the exact rows the
  panel writes for a new tenant, derived from T104/105/106; `add_extension`; `add_did`;
  `apply_tenant_fs` for the static/provisioning dirs; embedded provisioning `index.php`),
  `vitalpbx_mirror.py` + `diff_tenant.py` (byte-identical renderer + harness — **T104/T105/T106
  18/18 files + AstDB identical**, T5/T9/T11 down to hand-edited lines/runtime AstDB, T2/T8/T7
  differ only in ring-group/queue/IVR stretch renderers in `mirror_features.py`),
  `compare_tenant_rows.py`, `README.md` (row spec table → columns → values), `clone-rehearsal.ts`
  (drives Connect's REAL build code at the clone), `mirror-grants-20260819.sql`.
- Helper `2026.08.19.1`: **`POST /mirror/tenant-create`** `{name, description, dids[],
  outboundProfileIds[], userId}` → inserts the rows in ONE transaction (`db_conn()`), queues the
  base modules (`BASE_RENDER_MODULES` 99/11/8/48/26/29/1 + the panel's 42/43/110), creates
  `/var/lib/vitalpbx/static/<path>/…` + `provisioning_templates/<path>/{aastra.cfg,index.php}`
  (CAP_CHOWN), returns `{tenantId, name, path, rows, fs}`. Installer ships `mirror_writes.py`
  as a `PYMIRROR` heredoc **with a byte-identity drift guard**, and its grant block now adds
  SELECT+INSERT on the 10 tenant tables + INSERT on `ombu_inbound_routes` / `ombu_destinations`
  / `ombu_queued_changes` / `ombu_settings` for `connect_route_helper@{localhost,127.0.0.1}`.
- api: `pbxTenantBuild.createTenant(…, tenantCreator?, log?)` — with a creator: rows via the
  helper → `s.setTenant(path)` → **the same Apply Changes as before** (renders the tenant from
  the queued modules) → REST resolver confirms → build continues unchanged (CSV import, devices,
  inbound route). ⛔ **If the creator THROWS it falls back LOUDLY to the panel form** (log line
  `⛔ mirror tenant-create failed … falling back to the panel form`) — so the api could ship
  before the helper: while the licence is active the form still works; after the lapse the
  form's own refusal is the visible failure. `setupOrchestrator.resolveMirrorTenantCreator()`
  wires the helper-backed creator whenever a helper is configured for the PBX;
  `PBX_TENANT_CREATE_MODE=panel` forces the old form. `mirrorCreatePbxTenant()` in
  `pbxInboundRouteHelperClient.ts` (90 s).
- Tests: `pbxTenantBuild.test.ts` **37/37** (4 new: creator used → tenants form never posted +
  Apply still runs + build completes; failing creator → panel fallback + loud log; bad path →
  refused; env switch), installer **35/35** (2 new drift/registration guards); api typecheck
  **75 = baseline**.

**Proven on the clone (unlicensed panel, prod data), with Connect's real code:**
`buildPbxTenant` → trunk 133 → outbound route 130 → ARS 224 → **tenant 108 via mirror** (14
tables, dirs created) → Apply → ext 101 + 102 with WebRTC devices → inbound route. Files:
16 (T106 has 17 — the missing one is the empty `manager__50-t-users.conf` stub, module 47
`astmanager_users`, harmless). `pjsip show endpoints`: `T108_101`, `T108_102`, `T108_101_1`,
`T108_102_1` (after copying the DTLS certs into the clone — a clone artefact: **no** `_1`
endpoint of ANY tenant loaded there before). Dialplan **identical to T106's after normalising**
except the second extension, the DID and the (absent) emergency block; hints, voicemail
users, AstDB family (133 keys) all present. Two clone quirks worth knowing: `pjsip reload` is
not a command on Asterisk 20 (`module reload res_pjsip.so`), and a stuck "module reload
already in progress" after `fully-gen-conf` needed an Asterisk restart.

**Day-2 remaining, in order:** (1) ⏳ **PBX writes — Izzy's Run buttons**: scp the installer to
the PBX and run it (backs up nothing itself — back up
`/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py` and the grants first), verify
`curl 127.0.0.1:8757/health` → `2026.08.19.1`, `/opt/connect-pbx-helper/mirror_writes.py`
present, grants applied. (2) ⏳ **Prod acceptance**: one throwaway tenant through the REAL
build with the helper creator (label it "MIRROR TEST — delete me"), watch the log line
`tenant ok (path …, via mirror)` (NOT "via panel"), confirm `T<t>` files rendered, the app
registers, an inbound call reaches `connect-menu`, then delete it (tenant REST delete +
panel two-step for trunk/route/ARS, `_wipe-round2.mts` shape). (3) Cancel the subscription
**only after** (2), and re-check the day after with `select max(...)`-style facts: a new
sign-up says "via mirror" and its files exist.
**Rollback:** `PBX_TENANT_CREATE_MODE=panel` in the api env (needs an api-code deploy to
carry it — env-only changes do not rebuild) or simply the fallback (helper down = panel
form) — while the licence is active, both restore today's behaviour exactly.

⛔ **The robot panel password landed in this session's transcript** (a shell `eval` slip while
reading credentials.env) — rotate it: change the panel user `lOOPCOMAGENT7548`'s password in
VitalPBX, update `/etc/connect-robot/credentials.env` on loopcom (mounted into the api
container) and restart api. Onboarding uses it for every build.
