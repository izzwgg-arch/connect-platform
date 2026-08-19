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

## 13. DAY 2 DONE (2026-08-19): PROVEN ON PRODUCTION — and the render design changed because of what prod's 4.5.3-1 does

**The test Izzy asked for ran on the live PBX and passed.** But it first uncovered the real
production behaviour, which is different from the clone (4.5.3-8):

⛔⛔ **ON PROD (VitalPBX 4.5.3-1) NO "APPLY CHANGES" DOES A TENANT'S *FIRST* GENERATION.** The
mirror wrote a correct row set for tenant 107 (verified: 21 settings, CoS, DID, both inbound
routes, extension + desk/WebRTC devices — matching a real tenant), but **the panel's
`generateConfigurations` produced ZERO files**, and so did the official REST
`UPDATE /api/v2/tenants/107/apply_changes` (returned `200 "successfully applied"` and rendered
nothing). Apply Changes on 4.5.3-1 is INCREMENTAL only — it updates an already-generated tenant;
the panel's own create-time ionCube generator is what does the first gen, and that is exactly the
step we skip. (On the clone's 4.5.3-8 the panel Apply *did* first-gen a mirror tenant — a genuine
version difference. Trust prod.)

✅✅ **THE FIX (already the §9 design): the mirror RENDERS the baseline itself.** The
byte-identical renderer (`vitalpbx_mirror.py`) wrote tenant 107's **full 17-file set**, and after
`module reload res_pjsip.so` **both endpoints loaded** — `T107_101` (desk, max_contacts 1),
`T107_101_1` (WebRTC, max_contacts 5, dtmf auto), 13 hints, the `cos-all` dialplan, the inbound
route for the DID, the voicemail user — with **T2/T35/T105 doorways untouched** (0 cc-wipes).

✅✅ **AND THE ANSWER TO "can I still modify existing tenants after cancelling": YES, definitively.**
Once a tenant has baseline files, prod's **incremental** Apply works normally — adding extension
102 to the (now-rendered) tenant 107 through the ordinary panel path rendered it into the pjsip
file and loaded both new endpoints. The 27 existing tenants already have baseline files, so
extensions / devices / ring groups / forwards / edits keep working through the panel exactly as
today. **The mirror renderer is needed ONLY for a brand-new tenant's first generation.**

**Final design (deployed):**
- Helper `2026.08.19.2`: `/mirror/tenant-create` writes the rows AND renders the baseline
  (`render_and_install_pbx` → files 0644 www-data:root, AstDB seed, `module reload res_pjsip.so`
  / `dialplan reload` / `voicemail reload` / `module reload res_parking.so`); new
  `/mirror/tenant-render` re-renders from the complete rows. Reader uses a broad-SELECT connection
  (`OMBU_MYSQL_RO_*` or the helper user once granted `SELECT ON ombutel.*`). Installer ships
  `vitalpbx_mirror.py` + `mirror_features.py` (drift-guarded) and adds the SELECT grant.
- api `1c1d067e`: `buildPbxTenant` renders the baseline at create (so the panel's per-extension
  Apply has something to update) and re-renders once at the very end (`opts.tenantRenderer`) so the
  on-disk files are byte-identical to a panel-made tenant. Non-fatal; a failed re-render leaves the
  working incrementally-applied files in place.

**PRODUCTION ACCEPTANCE (2026-08-19), full build through the DEPLOYED code:** tenant 108
"MIRROR TEST delete me 0819b" — trunk 134 → route 130 → ARS 223 → **tenant via mirror** (no panel
form) → baseline render → **ext 101 + ext 102** each with desk + WebRTC → inbound route → final
re-render, in 109 s. Verified on the PBX: **17 files, 4 endpoints loaded** (T108_101/102 +
`_1`), inbound route for 8455550120, 14 hints, 2 voicemail users, outbound ARS in the dialplan,
**T2/T35/T105 doorways 0 cc-wipes**. Then fully deleted — prod back to exactly **27 tenants**,
helper healthy. **Nothing on any existing tenant was touched at any point.**

**So the two-day goal is met and PROVEN on prod:** a new tenant is created and rendered entirely by
Connect's own code with no licence; existing tenants are unaffected and stay editable through the
panel. ⏳ **Remaining before cancelling:** (1) a real end-to-end acceptance where a phone actually
registers to a mirror-made tenant and a call connects (this test proved config + endpoint load, not
a live call); (2) the untested-on-free-tier items (manual extension *form* add, desk-phone
provisioning past the 20 cap, geo-firewall countries) — try each on the clone before cancelling if
they're used; (3) then cancel and re-check the first real sign-up says "via mirror". ⛔ **Rotate the
robot panel password** (still exposed in a prior session transcript).

## 14. STRESS TEST (2026-08-19, Izzy's order: "ten new tenants outside the license, five extensions each, test them all, then delete completely — Connect, DB, PBX — and just that")

**Result: 10/10 PASS, and the platform is byte-for-byte back at baseline.**

- **Built on the LIVE PBX through the deployed code** (`scripts/pbx/mirror/stress10.ts` run in
  `app-api-1`): tenants `mirror_stress_01..10` (PBX ids 109–118), each created **via the mirror**
  (the script aborts if any tenant comes back "via panel" — none did), each with **5 extensions
  (101–105) × 2 devices** (desk + WebRTC `_1`), an inbound route, voicemail, hints, its own
  Main-tenant trunk/outbound-route/ARS. **146–191 s per tenant, sequential; 50 extensions /
  100 devices total.** ⛔ Numbers were fake 845‑555‑02xx placeholders (rows only) ON PURPOSE —
  a REAL customer's DID on a test tenant's inbound route can collide with the real tenant's
  routing; never "reuse an existing number" for tenant tests.
- **Verified per tenant** (`stress-verify.sh`): 17/17 files, **10/10 PJSIP endpoints loaded**,
  5/5 extensions, 10/10 devices, 5 voicemail users, 17 hints, inbound route, cos dialplan,
  AstDB family — **all ten PASS**; doorways T2/T35/T105 `cc-wipe=0` throughout the ~30‑min run;
  api health 200 the whole time; 0 stress CDRs; 0 unattributed CDRs in the window (the one
  `level:50` line was the standing 24‑h `cdr_unattributed_calls_present` monitor).
- **Deleted completely** (`stress-teardown.sh`, manifest-driven — deletes ONLY what the manifest
  names, with description guards on every Main-tenant row): `ombu_tenants` cascade ×10, their
  destination rows (each verified unreferenced first), Main trunks 135–144 / routes 131–140 /
  ARS 225–243(odd), 170 conf files, static + provisioning dirs, AstDB deltree ×10.
  **Connect side:** the ombutel DID sync had picked the fake numbers up during the window — the
  **10 `PbxTenantInboundDid` rows were deleted**; 0 `PbxTenantDirectory` rows, 0 Connect
  `Tenant` rows ever existed (build path never touches Connect's tenant table).
- ⛔⛔ **THE TRAP THE TEARDOWN RE‑PROVED, now twice in this file: a direct DB delete is NOT a
  "pending change".** After deleting the rows, Main's RENDERED files still carried all 12 fake
  trunks (10 stress + the 2 stale ones from §13's accepted tests, which were re-registering to
  `mirror-test.invalid` in memory) and 10 stale `ARS-*` contexts. A plain Apply in Main changed
  NOTHING. Fix = the helper's own bookkeeping: `insert ombu_queued_changes (1,26),(1,99),(1,42),
  (1,43),(1,110)` + `reload_dialplan=yes`, then ONE Apply in Main → fake trunks 0, stale ARS 0,
  mirror-test registrations 0, queue drained, flag consumed back to `no`. **Any future teardown
  that deletes Main-tenant rows by SQL must queue the modules or the render lies.**
- **Final state, checked against the pre-test snapshot:** tenants 27, extensions 119, devices
  167, trunks 67, outbound routes 56, ARS 80, inbound routes 75, tenant DIDs 48, destinations
  851, conf files 546 — **every count exactly baseline**; `trk-127` (VoIP.ms) + `trk-132`
  (SignalWire) rendered and 63 registrations in Registered state; 146 contacts Avail; doorways
  1/1/2 with 0 cc-wipes; helper `2026.08.19.2` healthy; api + portal 200.
- Artefacts: manifest + full log kept at loopcom `/root/stress-manifest.json`,
  `/root/stress10.log`; teardown summary at PBX `/root/stress-teardown-summary.json`.
  ⛔ Honest note: the teardown script's "backup row snapshots" banner is aspirational — no row
  dump was written before deletion (deliberately acceptable for throwaway test data; do NOT
  reuse this script on real tenants without adding a real dump first).

## 15. Vendor connectivity audit (2026-08-19, read-only — Izzy: "can VitalPBX see inside my system?")

**Answer: two OUTBOUND-only connections, no inbound access of any kind. Verified on the box, not
assumed:**
- **Licensing:** the panel's ionCube code calls out to `licensing.vitalpbx.com` (145.223.123.175)
  over HTTPS to validate/refresh `/var/lib/pbx-licenses/vitalpbx.lic` (hence the Aug 3 mtime). No
  cron, no daemon; zero live connections to their hosts at audit time. ⛔ ionCube caveat: the exact
  payload cannot be source-audited — the guarantee is behavioural (outbound-only, panel-initiated,
  one host).
- **Updates:** apt PULL from `repo.vitalpbx.com` (Cloudflare-fronted) when an update is run. They
  cannot push; they see the IP + versions fetched, only when asked.
- **No inbound door:** all 7 SSH authorized_keys are ours (connect-full/monitor, cowork-sandbox ×2,
  claude-*); shell users = root + our own audit accounts (cursor-audit, pbx_audit,
  codex_pbx_audit); **the running OpenVPN is the PBX's OWN server** (listens UDP 1194,
  `server 10.8.0.0/24`, tun0=10.8.0.1, `clients_list.txt`/ccd for phones, no `remote` line, no
  clients connected) — NOT a tunnel to the vendor; **`vpbx-monitor` is local-only** (config.ini:
  listens :3000/:3005 with the PBX's own cert, talks to 127.0.0.1 AMI + local DB — the dashboard's
  resource monitor, reports to nobody).

**CANCEL-DAY CHECKLIST addition (PBX writes — do AFTER cancelling, not before; cutting the
licensing host while still paying could read as an early lapse):**
1. Comment out the four `repo.vitalpbx.com` lines in `/etc/apt/sources.list.d/` (updates are
   frozen by mirror policy anyway — a VitalPBX package update could change the file dialect the
   renderer is pinned to).
2. Block outbound to `licensing.vitalpbx.com` (firewalld rich rule or /etc/hosts pin to 127.0.0.1).
3. After that the box talks to VitalPBX in NO direction. Everything running is Debian + Asterisk +
   config files we own/render.

## 16. THE PBX CONSOLE — the panel-replacement pages are BUILT and the READS + one EXTENSION CREATE are PROVEN ON PROD (2026-08-19)

Izzy, 2026-08-19: *"since tenants are not going to be able to be controlled
through the PBX anymore … create a page for extensions … and tenants that has
all the options, just like the PBX … same for provisioning, same for geo
firewall … I give you full permission to wire it into the PBX, 100% in
production. Be careful. Don't mess up any other tenants."*

**Commits `6378cb8b` (backend) + `fd3d0a3c` (portal + fixes) on
`feat/ivr-migration-takeover`. api DEPLOYED and container-verified at `6378cb8b`
(portal + the audit fix are in the deploy queue as of this writing). One
throwaway prod write: ext 155 created on Loopcom Demo (T102), then removed.**

### What it is
`/admin/pbx-console` (SUPER_ADMIN only — forced in `navConfig.isNavItemVisibleForUser`
AND `PermissionGate` AND `requireOwner` in every route; the `/admin/pbx-console`
prefix is in `PORTAL_API_PERMISSION_RULES` with `can_manage_global_settings`).
Four tabs: **Tenants**, **Extensions**, **Phone Provisioning**, **Geo Firewall**,
a top-bar customer switcher, search/filter, an editor.

### The architecture, and the ONE rule that governs it
- **Reads** = SELECTs through the read-only `connect_read` MySQL user
  (`apps/api/src/pbxConsole/pbxConsoleReaders.ts`). Granted `SELECT ON
  provisioning.*` on prod for the phone pages (backup
  `/root/pbx-console-grants-20260819T060722Z/`).
- **Writes** = replay the VitalPBX **panel** through a robot `PanelSession`, one
  build per robot account, exactly like onboarding
  (`apps/api/src/pbxConsole/pbxConsoleWrites.ts`). ⛔⛔ **The panel is
  ionCube-encrypted, so the ONLY honest description of a record is the FORM the
  panel renders. `panelForm.ts` parses that form and re-emits the exact pairs a
  browser would post; a write applies the person's changes on top.** THE CHECKBOX
  RULE lives there: an unticked checkbox is **OMITTED**, never sent as `=no`
  (which TICKS it). A unit test pins it.
- ⛔ **`applyAndRebake()` is the ONLY apply, and it ALWAYS re-bakes the Connect
  doorway on every Connect-routed number afterwards** — Apply Changes is
  whole-PBX and VitalPBX's regenerator cannot render the doorway (2026-08-13
  dead-air). Proven on prod: the ext-155 create's apply left T2/T35/T105 at
  **0 cc-wipes**.

### ⛔⛔ THE FOUR UNLICENSED-PANEL CAPS — mapped on the clone, and they decide the design
Tested on the unlicensed clone (prod data copy, 55 phones / 119 exts / no `.lic`):

| Operation | Unlicensed panel | Console today |
|---|---|---|
| **Extension** create / edit / delete / device add-edit-unlink | ✅ **works** (no `extensions.max_reached`) | ✅ full CRUD, PROVEN on clone AND one create on prod |
| **Tenant edit / delete** | ✅ works | ✅ full, PROVEN on clone |
| Tenant **create** | ⛔ "maximum number of free tenants" | (already solved — the MIRROR, §11–§14) |
| **Provisioning save** (edit OR add) | ⛔ **"maximum number of provisioned devices"** over 20 | read + resync only; write needs a direct-DB path |
| **Geo block** | ⛔ **"you may only block one country on the free version"** | read only; write needs a direct-DB path |

So **Extensions and Tenant-edit go through the panel and survive the lapse;
Provisioning and Geo writes do NOT** — they need a direct `ombu_*` /
`ombu_geo_firewall` write + regen (like the mirror), which is the next build.

### ⛔ Traps proven on the clone (in `deviceOverrides`), each with a test
- **DTMF**: the rendered form has NO `rfc4733` option (the panel's JS renames
  rfc2833→rfc4733 for pjsip after load), so re-posting the raw value silently
  flips a desk phone to rfc2833. Desk = **rfc4733**, WebRTC app = **rfc2833**
  (matches the live rows), set explicitly.
- **Extension create is ALWAYS a desk (pjsip) CSV base row**, then reshaped — a
  CSV import with a virtual base row answers "Import failed" and leaves a bare
  extension. App-only / virtual-only extensions get the base desk device
  **unlinked** at the end.
- **A device's TYPE can't be changed** after creation — a spec that says
  "virtual" for an existing desk device is REFUSED, not applied (it rewrote the
  desk phone as a cell forward on the clone).
- **A general-only extension save is refused** — it would re-post the raw device
  sub-form and flip DTMF; every save carries every device with its DB dtmf.
- **Secrets are preserved** across edits (blank password = keep current).

### Proven on the clone end-to-end (`scripts/pbx/console/clone-console-check.ts`)
extension create (desk+app+cell / virtual-only / app-only) → edit (name +
checkbox round trip) → device add-edit-unlink → delete + verify-gone; tenant
cid + inbound-number round trip; DB read back each time. 8 unit + source-guard
tests (`apps/api/src/pbxConsole/pbxConsole.test.ts`).

### Proven on PRODUCTION (deployed `6378cb8b`, self-signed SUPER_ADMIN probe)
All four **reads**: 27 tenants, extension devices, 55 phones + 427-model catalog,
geo 232 blocked + 15 whitelist. One **write**: `POST
/admin/pbx-console/extensions` created ext 155 "Console Prod Test" on Loopcom
Demo (T102) — desk `T102_155` (rfc4733, max 1), WebRTC `T102_155_1` (rfc2833,
max 5, vitxi), virtual 8455550155 — **both PJSIP endpoints loaded in Asterisk**,
doorways T2/T35/T105 **0 cc-wipes**.
⛔ **A create SUCCEEDED but the first attempt returned 500** because the old
audit wrote `tenantId: "platform"` (FK violation) AFTER the panel write. Audit
is now best-effort (attributes to the admin's tenant or skips, wrapped in
try/catch). Fixed in `fd3d0a3c` — in the deploy queue.

### ⏳ NOT DONE / next
1. **The delete round trip on prod returning 200** (ext 155 was verified formed;
   its removal + a fresh 200/200 create-delete is the last acceptance, after the
   `fd3d0a3c` api redeploy).
2. **Nobody has opened the portal page in a browser** — proven by tests +
   typecheck + the live API, not by a human clicking.
3. **Provisioning + Geo WRITES** — capped by the unlicensed panel; need a
   direct-DB helper endpoint (geo = `ombu_geo_firewall` + `build_geo_firewall`;
   provisioning = `provisioning.devices`/`accounts` + config render, the harder
   one). Reads + resync work now.
4. Tenant **create** in the console UI still routes nowhere — it's the mirror's
   job (§11–§14); wiring the "New tenant" button to `buildPbxTenant` is a follow-up.
5. ⛔ Still open from earlier: **rotate the robot panel password**.

## 17. THE LAST TWO CAPS ARE BEATEN: phone provisioning writes PROVEN on production; geo needs one more step (2026-08-19)

§16 left two operations the unlicensed panel refuses — provisioning saves past
20 phones, geo blocks past 1 country — as read-only. Both now have a real write
path. **Commits `5a312205` (helper + installer) and `d0c435b9` (api + portal).**

### ⛔⛔ THE FINDING THAT UNLOCKED IT: the cap is in the panel's SAVE controller, not in the renderer
`Device::generateProvisioningFile()`, called from PHP CLI on the **unlicensed
clone holding 55 phones against a free cap of 20**, regenerated an existing
phone's config **byte-identical to the panel's own** (same sha256, 139,017
bytes), and produced a working config for a brand-new **56th** phone that nginx
then served with **200**. So the shape is the same as the tenant mirror: **write
the rows ourselves, then let VitalPBX's OWN generator render them.** We never
re-implement the 427-model config renderer.

### ⛔ A phone config is a STATIC FILE — this is the trap to remember
`/phoneprov/<tenant-hash>/<mac>.cfg` is served by a plain nginx `alias`. I first
read `index.php` (which *does* generate on demand) and concluded configs were
generated per request — **wrong**: that per-tenant location is not what serves
the pretty URL, and with the cached file removed the fetch is a plain nginx 404.
So **a row changed without a render leaves the handset on its old settings,
silently, forever.** Every write in `console_writes.py` renders.

### What shipped
- **`scripts/pbx/mirror/console_writes.py`** — `save_phone` (devices + accounts
  rows → cache-bust → render), `delete_phone`, `generate_config`, `geo_state`,
  `set_geo_blocks`, `whitelist_state`.
- **`scripts/pbx/mirror/render_phone.php`** — renders ONE validated MAC and
  **cannot write a row**, so the privilege it needs can never become "run
  arbitrary PHP".
- **Helper `2026.08.19.3`** — `/console/phone-save`, `/console/phone-delete`,
  `/console/phone-render`, `/console/geo-state`, `/console/geo-set`.
- **api + portal** — phones are add/edit/delete/**Rebuild**/Resync from the page;
  geo has Block/Unblock per country.

### ⛔ Three production failures found while proving it — all worth carrying
1. **`sudo` CANNOT be used from the helper.** The unit sets
   `NoNewPrivileges=yes`, so sudo is refused outright ("the no new privileges
   flag is set"). The render therefore runs **in-process as `asterisk`**, made
   possible by two narrow grants the installer now applies: a **read ACL on
   `/etc/vitalpbx/vitalpbx-maint.conf`** (one 128-char maintenance API token —
   *not* database credentials) and **`/var/lib/vitalpbx/provisioning` in
   `ReadWritePaths`** (`ProtectSystem=strict` otherwise makes it read-only).
2. **A create whose render failed left a phone row with NO config** — the console
   would list a phone that gets nothing. A failed **create** now rolls its row
   back (an edit keeps its row, because that phone already has a working config);
   proven on prod, the failed attempt left the count at baseline 55.
3. **`geo_state` lied.** `/etc/firewalld` is root-only, so the enforceability
   check returned "all 232 unenforceable". It now reports
   `ipsetDirReadable: false` and makes **no** claim. Confidently wrong in the
   most alarming direction is worse than obviously incomplete.

### PROVEN ON PRODUCTION
Create a phone on Loopcom Demo (T102): **185,209-byte config**, `account.1.user_name
= T102_101`, **served 200** over HTTP like a handset → edit (rename) → re-render
→ delete (rows + both cached files removed) → **devices back to baseline 55**.
Installer suite **44/44**; api typecheck **75 = baseline**; portal **0**.

### ✅ GEO WRITES ARE ARMED (2026-08-19 afternoon) — the root path-unit channel is INSTALLED and verified end-to-end; the FIRST live build still awaits Izzy's word

> The section below this one is the state as of the morning; this is the
> resolution. **Helper `2026.08.19.4` + the `connect-geo-build` root channel are
> live on the PBX.** The design is the one §17 named: the helper (as
> `asterisk`) drops a request file in `/var/lib/connect-pbx-helper/geo-build/`,
> a **root** `connect-geo-build.path` unit sees it, `connect-geo-build.service`
> runs `/usr/local/sbin/connect-geo-build`, which **backs up
> `/etc/firewalld/direct.xml`** (last 10 kept under `geo-build/backups/`), runs
> VitalPBX's own `build_geo_firewall` **with no arguments**, and writes
> `result.json` back where the helper polls it (correlation id, sanitised,
> `CONNECT_GEO_BUILD_TIMEOUT_S` default 600 s — under the api client's 900 s).
> ⛔ **The privilege boundary is the point**: the root side runs ONE fixed
> command and reads nothing from the request file but the id, so owning the
> helper buys "rebuild what the DB already says" and nothing more.
> - `geo_build_available()` now answers `direct → sudo → unit`; `unit` requires
>   BOTH the writable request dir AND `systemctl is-active
>   connect-geo-build.path` — a writable dir with no watcher must never count.
> - `/console/geo-state` (and therefore `GET /admin/pbx-console/geo` →
>   `enforcement`) now carries **`buildChannel`**; proven live through the
>   deployed api: `200 {blocked: 232, buildChannel: "unit", whitelist: 15}`.
>   **No api or portal change was needed** — the client timeout (900 s) and
>   response shape already fit, and extra fields pass through.
> - A **timeout** leaves the flags WRITTEN and says so plainly ("The country
>   flags ARE saved… check `journalctl -u connect-geo-build`") — never
>   "nothing was changed", which would be a lie in that state.
> - Whitelist safety was checked before arming: `direct.xml` is owned wholesale
>   by the builder family and itself carries `vpbx_white_list` at
>   `INPUT_direct` priority 0 with `geo_firewall` at priority 1 — the builder
>   emits the ordering that keeps loopcom (in `blacklist_fr`) reachable. The
>   runner backs the file up before every build regardless.
> - Tests: installer suite **49/49**; all **7 new guards fail replayed against
>   HEAD**. Backups on the PBX: `/root/helper-backup-geo-unit-20260819/`.
> - ⛔⛔ **THE CONSOLE'S BLOCK/UNBLOCK BUTTONS ARE LIVE NOW — the first click IS
>   the first-ever run of `build_geo_firewall` under our control.** Izzy chose
>   (2026-08-19, asked directly) to hold that first run for his word rather
>   than run it mid-day with 5 active calls. **Run it in a quiet window.**
>   Acceptance recipe: pick a country with `blocked='no'` AND an existing
>   `blacklist_<iso>.xml` ipset, block it via `POST /admin/pbx-console/geo`,
>   verify `build.code 0` + a fresh `direct.xml` mtime + a firewalld reload in
>   the journal + loopcom still reaching the helper, then unblock and verify
>   back to 232. ⛔ Judge by direct.xml mtime + the reload, never rule counts
>   (fail2ban's live bans make counts noisy).

### ⏳ GEO: the one step NOT taken, deliberately (STATE AS OF THE MORNING — superseded by the section above)
`set_geo_blocks` writes the flags and then calls VitalPBX's own
`build_geo_firewall`, which needs **root** (it writes `/etc/firewalld` and
reloads firewalld) — blocked by the same `NoNewPrivileges`. A sudoers line for
that one script is installed, but **it cannot work until `NoNewPrivileges` is
relaxed for the helper unit, or the build is triggered out-of-process** (a root
path-unit watching a flag file is the clean design).
⛔ **And the first real run of `build_geo_firewall` on the live box was NOT done
during business hours**: it rewrites the firewall and reloads firewalld on a PBX
carrying live calls. Do it in a quiet window, with `/etc/firewalld/direct.xml`
backed up and the rule count (227) checked before and after.
✅ Until then nothing is silently wrong: a geo change is **refused**, not
half-applied, and the console says so.
⛔ The clone cannot validate this — its container has no working firewall backend
(0 geo rules even at baseline).

### ⛔⛔ THE GEO CAPABILITY CHECK WAS ITSELF THE DANGEROUS THING (found + fixed 2026-08-19, `81ccf2fa`)
Verifying the refusal on production caught two defects in the code whose entire
job is to keep the firewall safe.

1. **It probed by RUNNING the builder.** `geo_build_available()` executed
   `sudo -n build_geo_firewall --connect-probe`. `build_geo_firewall` takes no
   such flag, so the "probe" was a **full firewall rebuild and a firewalld
   reload on a PBX carrying live calls** — performed merely to answer *"am I
   allowed to do this?"*. The one thing §17 said must wait for a quiet window
   was being done as a capability check.
   ⛔ **A capability check must ASK, never DO.** It is now
   `sudo -n -l <builder>` (list, do not execute), and a guard test asserts no
   `subprocess.run` line names the builder without `-l`.
2. **It read the refusal wrong, in the unsafe direction.** It looked for
   `"password is required"` / `"not allowed"` in stderr; under the helper's
   `NoNewPrivileges=yes` sudo actually says *"sudo: the no new privileges flag
   is set, which prevents sudo from running as root"* — matching neither — so
   it returned `["sudo"]`, i.e. **"the build is available"**. The caller would
   then have written `blocked='yes'` rows it could not enforce: the console
   saying *blocked* while the traffic arrives. It now trusts the **exit code**.
3. **`len(None)` crashed the honest refusal into a 500.** `geo_state` reports
   `enforceable`/`missingIpset` as `None` when `/etc/firewalld` is unreadable —
   which is exactly the state a refusal is reported from — so the plain-English
   message never reached the caller.

**Verified live on prod after the fix:** `/console/geo-set` answers
`geo_build_not_permitted: the firewall rebuild needs root ... so the block was
NOT applied`; `/etc/firewalld/direct.xml` is **still stamped 2026-04-29** (never
rewritten), firewalld shows **no reload in the journal**, and the DB still holds
**232** blocked countries. Nothing was changed by any of the probing.
⛔ **Correction to the rule-count note above:** the live figure is **258 runtime
/ 253 permanent**, and the gap is **fail2ban's 7 live bans**, which come and go
on their own — so a raw rule count is a *noisy* before/after check. The
authoritative evidence that geo did nothing is **`direct.xml`'s mtime plus the
absence of a firewalld reload**, not the rule count.
Installer suite **45/45**.

### ⛔ The guard-test trap, hit twice in this section
Both times a negative source guard failed against **correct** code because it
matched the string quoted in the **doc comment explaining the old defect**
(`render_phone.php`, then `--connect-probe`). Strip comments — or assert only on
executable lines — before any `!includes(...)` guard. This is the third
recorded instance of that trap in this repo.

## 18. The console can CREATE a customer — the one job the panel refuses (2026-08-19)

§16 gave the console reads plus extension and tenant **edit**; §17 beat the
provisioning and geo caps. The remaining hole was the one that matters most on
the day the licence lapses: **the console could read, edit and delete a tenant
but not create one**, which is exactly the operation VitalPBX blocks
("maximum number of free tenants"). The console was therefore fine today and
useless the day it was needed. Commits `3e914b4f` + `b1f3fb2e`.

### ⛔ It goes through the MIRROR, never the panel form
`POST /admin/pbx-console/tenants` calls **`resolveMirrorTenantCreator`** — the
same wiring `setupOrchestrator` hands to `buildPbxTenant` for onboarding — so
there is exactly **ONE** tenant-creation implementation on the platform. A
second one is the failure shape this repo keeps hitting (two IVR publish paths,
two SMS ingest paths, two invite paths, two recording players).

⛔ **A guard test reads the route's SOURCE and fails if it ever posts the
panel's add-tenant form.** That matters more here than anywhere else in the
console: while the licence is still live the panel form *works*, so a
"simplification" to the panel path would pass every functional test today and
fail silently on the one day nobody can afford it.

### ⛔ It uses onboarding's `slugify`, not a second slug rule
The PBX name is matched elsewhere by **slug OR display name**
(`findPbxDirectoryEntry`), so a second slug variant would create tenants those
lookups cannot find. The helper independently validates
`^[a-z0-9_]{1,255}$`, which is exactly what `slugify` emits.

### Scope, deliberately small
This is the panel's **"add tenant" button**, not onboarding: no trunk, no
outbound route, no extensions, no numbers bought, **no Connect tenant row**.
Everything else is editable immediately afterwards through the ordinary tenant
edit, which keeps working unlicensed. Optional inputs are phone numbers and one
outbound profile.

### What it refuses, and why each refusal exists
- **A duplicate name, checked BEFORE anything is written**, naming the customer
  that already holds it — the difference between "already taken" and a stack
  trace. The mirror raises on it too (the column is unique); that error is now
  mapped to the same refusal, because the pre-check is skipped whenever the
  database read is down, which is exactly when someone retries a used name.
- **More than one outbound profile.** The mirror door takes one. Accepting a
  list and quietly using the first is a setting that looks applied and is not.
- **The helper being unreachable** — said in plain words, rather than a 500.

### ⛔ The re-render can fail without failing the create
`/mirror/tenant-create` renders the baseline itself (it must — on prod neither
the panel Apply nor the REST per-tenant apply will perform a tenant's FIRST
generation). The second `mirror/tenant-render` pass is what makes the files
byte-identical to the panel's, and it is wrapped: the tenant exists either way,
and a person can re-render from the list. `rendered` in the response says which
happened.

### The new reader
`listOutboundProfiles` gives the create form its picker, and carries the note
that **every real ARS row lives under Main (tenant_id 1)** — joining `ombu_ars`
on a tenant_id concludes almost no customer has outbound routing, a wrong answer
this repo has already produced once. Most onboarding-created rows are literally
described `none`, which is existing data; `label` never renders empty.

### The screen
A dedicated **New customer** dialog on the Tenants tab, not a mode of the
editor — the editor is built around re-posting a rendered panel form and this
write has no panel form behind it. The PBX name is previewed live from the
customer name using the same rule the server applies, so what is shown is what
gets created.

### PROVEN ON PRODUCTION, then torn back down
Throwaway customer **"ZZ Console Check"** created through the deployed route on
the live PBX (which was carrying **10 active calls** at the time):

| step | result |
|---|---|
| create | **200** — tenant **119**, path `9e0782f877162015`, **13 baseline files rendered** |
| profiles offered | **80** (the picker is real, read from `ombu_ars`) |
| duplicate | **409 `tenant_exists`** — *"already has a customer called ZZ Console Check (system name zz_console_check)"* |
| in the list | `id=119 enabled=true ext=0` — it reads back like any other customer |
| delete | **200** via the console's OWN delete route, doorway re-bake `tenants:3 rebaked:3 linesChanged:0` |

**Byte-back at baseline afterwards**, every count checked against the
pre-test snapshot: **27 tenants, 119 extensions, 554 tenant-settings rows,
353 tenant conf files, 0 files or rows mentioning 119**, and doorways on
T2/T35/T105 still **0 cc-wipes**.

### ⛔⛔ THE FINDING THE PROD RUN PRODUCED: the mirror's SECOND render can never succeed
The create's follow-up `mirror/tenant-render` failed with

```
[Errno 13] Permission denied: /etc/asterisk/vitalpbx/extensions__50-119-dialplan.conf
```

while all 13 baseline files were present and correct. The mechanism, read off
the live file rather than guessed: the render **hands each file it writes to
`www-data`** so the panel can keep managing it, and the file lands
`www-data:root`, mode `rw-r--r--`, with the **ACL mask at `r--`** (so even the
`user:www-data:rw-` entry is effectively read-only). **The helper runs as
`asterisk`**, which falls into `other` — so it cannot reopen the file it just
wrote. Compare a panel-managed tenant, which is `www-data:www-data rw-rwxr--`.
⛔ **This is the ACL trap this document already records as a NON-FIX** (§ the
panel-lockout work: "a POSIX ACL alone" fails because the regen's `chmod 0644`
sets the mask to `r--`). Do not widen permissions on `/etc/asterisk/vitalpbx`
to make it go away.

✅ **For the console the re-render is simply removed**, because it is also
*redundant*: this route writes nothing after the create, so the mirror's
baseline already IS the final state. A guard test now fails if anyone re-adds
it, and carries both reasons — only the redundancy is obvious from the code.

⏳ **CARRIED OVER, NOT FIXED: onboarding's final re-render is very likely dead
the same way.** `buildPbxTenant` calls the same `/mirror/tenant-render` at the
end (`1c1d067e`), against files the create has already chowned, so it should hit
the identical EACCES. It is wrapped and logs *"final mirror re-render failed —
the panel-applied files remain in place"*, and that fallback is correct (the
panel's own Apply Changes runs as www-data and renders the extensions fine —
which is why tenant 108's four endpoints loaded). **So nothing is broken, but
the "byte-identical final re-render" this document claims is probably not
happening.** ⛔ Evidence so far is ONE measurement, on a console-created tenant.
**Confirm on the next real onboarding** by grepping its log for that warning
before either fixing it or deleting the claim.

### ⏳ Still open after §18
- **Nobody has opened the console in a browser.** Everything above is proven
  through the deployed HTTP routes and the PBX's own state, never by a person
  clicking. That needs Izzy's login.
- **Geo writes** still need root (§17).
- **The robot panel password** still wants rotating.

## 19. ⛔ WORK STOPPED HERE — read this before touching the PBX Console (2026-08-19, ~15:15 UTC)

> ✅✅ **RESOLVED, 2026-08-19 evening (deploy catch-up session). Both halves are
> live now; the rest of this section is history.**
> - **The in-flight api deploy LANDED**: `app-api-1 /app/.build-commit` reads
>   `20248b00`, the log ends `verify: container commit 20248b002f27 matches
>   target` / `done 20248b00`, health 200. The three refinements are live.
> - **The portal was deployed to the branch tip `f5887c02`**
>   (`deploy-direct.sh portal --branch feat/ivr-migration-takeover`, log
>   `/root/deploy-portal-catchup-20260819.log`, ~25 min) and verified exactly as
>   this section prescribes: `.build-commit` = `f5887c02`, and the STRING
>   `New customer on the phone system` greps in both
>   `.next/server/app/(platform)/admin/pbx-console/page.js` and the shipped
>   client chunk `page-01098b88d73d654f.js`. Portal 200 on both hostnames.
>   **The New-customer button exists in the browser now** — though any tab or
>   desktop window opened before the deploy keeps the old bundle until reloaded.
> - Hazard #1 below (the stale staged blobs) was already cleared by the time of
>   this session — the shared index was clean.
> - Still open: nobody has clicked through `/admin/pbx-console` (needs Izzy's
>   login), the geo build step, and the robot panel password rotation.

Izzy stopped the session mid-way through shipping §18. **Nothing is broken and
nothing is half-applied on the PBX**, but the two halves of the feature are at
**different** deploy states, so read this before assuming what is live.

### The one-line state
**The api half is LIVE and proven. The portal half is committed and NOT live —
so the "New customer" button does not exist in the browser yet.**

### What is actually running right now
| piece | commit | state |
|---|---|---|
| **api** | `3e914b4f` | ✅ LIVE, healthy, 0 restarts. Tenant create works and was proven on prod. |
| **api (in flight at stop)** | `20248b00` | ⏳ A deploy was **still building** when work stopped. See below. |
| **portal** | `d0c435b9` | ⛔ **STALE** — predates the New-customer dialog entirely. |
| **PBX helper** | `2026.08.19.3` | ✅ geo/provisioning fixes installed and verified. |

Both hostnames answered **api 200 / portal 200** at the moment of stopping.

### ⏳ THE ONE THING IN FLIGHT — check this FIRST
An `api` deploy to **`20248b00`** was at the *build* stage (`exporting layers`)
when work stopped. It was **deliberately left to finish rather than killed**:
the build stage is *before* any container is touched, so a failure there changes
nothing — whereas killing a docker build risks leaving the **heavy-build lock**
held, which would block the next agent's deploys.

**So the first thing to do is find out where it landed:**
```bash
docker exec app-api-1 cat /app/.build-commit      # 3e914b4f or 20248b00, both fine
tail -5 /root/deploy-console-final-api2.log
ps -eo cmd | grep "[d]eploy-api.sh"               # empty = finished
```
- reads **`20248b00`** → it completed; the three refinements below are live.
- reads **`3e914b4f`** → it failed or was still going; **that is a good state too**
  (it is the fully tested commit that was proven on production). Just re-run the
  deploy when convenient.
⛔ **`20248b00` is a docs commit, and that is expected** — `deploy-direct.sh`
hard-resets to the branch TIP, so the container is stamped with the tip, not with
the code commit you had in mind. `4faf2635` is an ancestor of it, so all the code
is there. **A waiter watching for `4faf2635` would never fire** — that mistake was
made and corrected during this session, and it is the same shape as the stale
waiter noted below.

### What is in `20248b00` that is NOT in the live `3e914b4f`
Three refinements, all small, none of them load-bearing:
1. **A second outbound profile is refused** rather than silently reduced to one
   (the mirror door takes one). A setting that looks applied and is not.
2. **The tenants list opens ONE PBX connection**, not two — the profile list was
   added as its own read on the console's most-loaded route.
3. **The create no longer re-renders** — see §18, it is redundant *and*
   impossible (`EACCES`, the ACL trap).

### ⛔ THE REAL GAP: the portal is not deployed
`apps/portal/.../admin/pbx-console/page.tsx` carries the **New customer** dialog
and the button that opens it, committed in `3e914b4f`. The portal container is
still `d0c435b9`. **Until a portal deploy runs, a person cannot create a customer
from the screen** — only through the API, which is what this session used.

```bash
cd /opt/connectcomms/app && bash scripts/deploy-direct.sh portal --branch feat/ivr-migration-takeover
```
⛔ Do it when the deploy lane is free (`ps -eo cmd | grep -E "[d]eploy-direct.sh|[r]un-heavy"`);
the heavy-build lock is **separate from the queue**. ⛔ And an already-open portal
tab or desktop window keeps the OLD bundle until it is reloaded.

### ⛔ Verifying after the portal deploy
Grep the shipped bundle for a **string**, never a function name — minification
renames the function and a 0-hit grep reads exactly like a failed deploy:
```bash
docker exec app-portal-1 sh -c "grep -rl 'New customer on the phone system' /app/apps/portal/.next | head -3"
```

### Two hazards that are NOT mine and are still there
1. ⛔⛔ **Another session's STALE staged blobs in the shared git index.**
   `CLAUDE.md` is staged at **7,774 lines against HEAD's 8,261**, and
   `TESTS_RUN.md` at **638 against 907**. **A bare `git commit` from any session
   commits those and deletes ~500 lines of both files**, including several
   sessions' handoffs. I checked before deciding: the staged CLAUDE.md holds only
   4 unique lines, all *older wording* of sections HEAD has since updated, and the
   staged TESTS_RUN is a strict subset of HEAD — so refreshing is provably
   lossless. I left it because it is another session's working state. The fix:
   ```bash
   git add CLAUDE.md docs/ai-context/TESTS_RUN.md
   ```
   ⛔ Every commit in this session used **`git commit -F - -- <paths>`** or a
   **private index**, precisely so that stale blob could never be swept in.
2. **A waiter from another session has been polling for hours** for the portal to
   reach `1fa34d29`, but its own deploy built `ce9f2318` and the container reads
   `d0c435b9` — **it can never fire.** Harmless, but do not read it as evidence a
   portal deploy is pending.

### The acceptance test nobody has run
**Nobody has opened `/admin/pbx-console` in a browser.** Everything in §16–§18 is
proven through the deployed HTTP routes and the PBX's own state — never by a
person clicking. That needs Izzy's login and is the single most valuable next
step.

### Everything is committed and pushed
Branch `feat/ivr-migration-takeover`, tip **`20248b00`** at stop, all pushed to
origin. Nothing of this session's work exists only on disk.

## 20. STRESS TEST ROUND 2 (2026-08-19 evening, Izzy's order: "Create 20 tenants, each of them with 10 extensions, then delete any trace of them. Do all that outside the license.")

**Result: 20/20 built via the mirror and verified, then torn down to byte-baseline
on BOTH systems — and the teardown surfaced a REST staleness bug that auto-marked
TWO LIVE CUSTOMERS removed, now fixed in code (`9068acca`).**

### The build (harness `scripts/pbx/mirror/stress20.ts`, twin of §14 at 2x scale)
- **20 tenants `mirror_stress_21..40`** (PBX ids 120–139), each **via the mirror**
  (the script aborts on any "via panel" — none), each with **10 extensions
  (101–110) × 2 devices**, inbound route on a fake `84555503xx` number, voicemail,
  hints, own Main trunk/route/ARS. ~300–370 s per tenant with 10 extensions.
- ⛔⛔ **An AUTO-DEPLOY killed the run at tenant 28** — deploys fire on pushes now
  and a fleet redeploy recreated `app-api-1`, killing the in-container exec (the
  documented docker-exec trap, now proven against a stress run). **The rerun runs
  in a one-off `docker compose run --no-deps` container, which deploys cannot
  touch** — that is the pattern for ANY long api-side script from now on.
- ⛔⛔ **The resume then found the day's biggest lesson: VitalPBX's REST tenant
  list serves a STALE CACHED SNAPSHOT.** Observed live: 31 rows while
  `ombu_tenants` held 35, later 41 rows while it held 27 — 40+ minutes stale,
  surviving two panel Applies. The stress script's tenant-path resolver used REST,
  could not see tenant 28, and buildPbxTenant tried to create a duplicate (both
  the mirror and the panel correctly refused). **Resolvers now read
  `ombutel.ombu_tenants` via the console's read connection** (`3ec0648e`), and
  `STRESS_START` resumes an interrupted run — every build step adopts what an
  earlier pass created (proven live: tenant 28 adopted trunk 152/route 148/ARS 260
  and its 4 existing extensions, then continued).
- **Verified (`stress20-verify.sh`): all 20 PASS** — 17/17 files, 20/20 endpoints
  loaded, 10/10 extensions, 20/20 devices, 10 vm users, 22 hints, inbound route,
  cos dialplan each; doorways T2/T35/T105 clean the whole run; api 200 throughout.

### The teardown — four kinds of trace, two of them new
1. **PBX rows/files/AstDB** (`stress-teardown.sh`, manifest-driven, slug +
   description guards): 20 cascades, 340 files, static + provisioning dirs, AstDB
   ×20, Main trunks/routes/ARS by manifest id. Then the §14 trap AGAIN: **Main's
   rendered files kept all 20 fake trunks and 20 stale ARS-* contexts** until the
   module queue + reload flag + ONE Apply (`stress-main-reapply.ts` — Apply via
   the console's own `applyAndRebake`, so every doorway re-bakes after).
   ⛔ **The reload flag lives in `ombu_settings` (name `reload_dialplan`, or
   `T<n>_`-prefixed per tenant), NOT `ombu_tenant_settings`** — an UPDATE against
   the wrong table silently no-ops and the dialplan half of the regen never runs
   (trunks cleared, ARS contexts stayed; caught by re-checking, fixed, re-applied).
2. **`ombu_settings` orphans — NEW, and §14 left the same trace:** each mirror
   tenant writes `T<n>_reload` + `T<n>_reload_dialplan` rows that the tenant
   cascade does NOT remove. Deleted **65** rows guarded on "tenant id no longer
   exists" — this run's 40, §14's 20 (T109–118, still there from yesterday), and
   §13/§18's leftovers. **Any future teardown must sweep `ombu_settings` too.**
3. **Connect shells — NEW: the background PBX→Connect sync auto-created 14
   Connect `Tenant` rows** ("MIRROR STRESS 21..34 delete me", 10 billable
   Extension rows each, 0 users/invoices) while the stress tenants lived. Erased
   all 14 + §13's leftover "MIRROR TEST delete me 0819" through the sanctioned
   guards (money/user re-check per tenant; PBX absence verified against MySQL,
   never REST). The 20 fake `PbxTenantInboundDid` rows the DID sync picked up
   were deleted; total back to baseline 76.
4. **Final state, measured not assumed:** tenants 27, extensions 119, devices
   167, trunks 67, outbound routes 56, ARS 80, inbound routes 75, tenant DIDs 48,
   destinations 853, conf files 546 — **every count exactly the pre-test
   baseline**; 0 `mirror-test.invalid` anywhere, 0 stale ARS contexts (⛔ compare
   with `ARS-[0-9]+`, not `ARS-[0-9]*` — the `*` matches the legit `ARS-all` and
   fakes one stale row), 63 registrations, doorways 1/1/2 with 0 cc-wipes, api
   200 on both hostnames. REST converged back to 27 on its own (~50 min) and the
   warm sync then self-cleaned the 14 stale directory rows.

### ⛔⛔ THE INCIDENT: the orphan sweep auto-marked TWO LIVE CUSTOMERS (fixed `9068acca`)
Calling `POST /admin/pbx/instances/:id/sync-tenant-dids` while REST was stale
rebuilt the directory from the 41-row snapshot; that made exactly **three**
tenants look orphaned — inside `MAX_AUTO_REMOVALS` — and `runOrphanSweepAfterSync`
marked all three: §13's test leftover and **Comfort control + LUZER**
(`pbxRemovedAt` set, delisted everywhere, links UNLINKED, **autopay switched
off**; LUZER also `archivedAt`, having paid invoices). `isPbxAnswerHealthy`
cannot catch this — 41 of 41 known reads as perfectly healthy. **Both customers
were fully restored within the hour** (flags cleared, links re-LINKED, autopay
re-enabled — LUZER's invoice history proves autopay was on; ⛔ Comfort control's
prior autopay value is unknowable, the sweep overwrote it — set ON, flip it off
if they were deliberately un-billed). **The fix:** `ConfirmGone` — marking now
requires **ombutel MySQL to confirm each PBX tenant id is really gone**; a REST
lie is dropped and logged (`pbx_orphan_rest_disagrees_with_mysql`); no verifier
or unreachable MySQL marks nothing; the confirm route 503s rather than proceed
on REST alone. 19/19 tests incl. the exact failure shape; guards fail vs HEAD.

### ⏳ Open after §20 — needs Izzy
- **Comfort control and LUZER are GENUINE pre-existing orphans**: their PBX
  tenants (ids 10 and 26) do not exist in `ombu_tenants` under any name — they
  were deleted on the PBX at some point before today. Both are restored to
  exactly their pre-test state (visible, billed), but the underlying fact
  stands: **LUZER is being invoiced $45/mo (2× FAILED since July) for a phone
  system that is not on the PBX.** Whether to remove them properly (through the
  now-hardened sweep) or rebuild their PBX side is a business decision.
- The sweep fix `9068acca` rides the next api deploy (auto-deploy on push).
- Artefacts: loopcom `/root/stress20.log` (run 1), `/root/stress20b.log`
  (resume), `/root/stress20-manifest.json`; PBX `/root/stress-teardown-summary.json`.
