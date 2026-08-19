# VitalPBX mirror generator (`scripts/pbx/mirror/`)

Replicates VitalPBX 4.5.3's per-tenant output — the `ombutel` rows the panel
writes, the 17 per-tenant conf files under `/etc/asterisk/vitalpbx/`, and the
AstDB keys — with our own code, so the licence-gated panel save path never has
to run for a tenant. Python 3.11, stdlib + `pymysql` only.

| file | what |
|---|---|
| `mirror_writes.py` | **the WRITE side** — `create_tenant`, `add_extension`, `add_did`, `render_and_install`, `insert_extension_surgical`. Dry-run by default (prints an executable MySQL script); `--apply` executes in one transaction. |
| `vitalpbx_mirror.py` | renderer: `load_tenant(conn, t)` → `render_tenant(model)` (17 files) → `render_astdb(model)`; CLI `render --tenant N --out DIR`, `render-astdb --tenant N` |
| `mirror_features.py` | ring groups, queues, IVRs, time groups/conditions, announcements, paging (the stretch renderers) |
| `diff_tenant.py` | the harness: `--tenant N [--baseline-dir …] [--astdb …] [--ignore-hand-edits]` → unified diff per mismatching file + one PASS/FAIL line, exit 0 only when identical |
| `compare_tenant_rows.py` | `--a 106 --b 107` — column-for-column comparison of two tenants' rows across every tenant table (validates the write side against a panel-made tenant) |
| `test_mirror.py` | `python3 -m unittest test_mirror` — pure-text renderers against fixtures cut from the real T104 files, the surgical insert, the AstDB key set, the create_tenant plan |
| `provisioning_index.php.tmpl` | the per-tenant `provisioning_templates/<hash>/index.php` the panel drops (with `TENANT_PATH` placeholder) |

Dev environment (loopcom): `/root/pbx-mirror-dev/mirror/` (this folder), the
offline DB `mirror-db` (MariaDB, `127.0.0.1:3307`, `root`/`mirror`, dbs
`ombutel` + `provisioning`, the 2026-08-18 production dump), the baseline
`/root/pbx-mirror-baseline-20260818/` (`etc-asterisk.tgz` extracted to
`/root/pbx-mirror-dev/etc/asterisk/`, `astdb.txt`).

```
cd /root/pbx-mirror-dev/mirror
python3 diff_tenant.py --tenant 104                      # PASS/FAIL + diffs
python3 diff_tenant.py --tenant 5 --ignore-hand-edits    # drop the hand-baked HD/expiry blocks
python3 mirror_writes.py create-tenant --description "Acme Inc" --did 8455551212 \
        --did-destination 31,29,1 --outbound-profiles 214          # dry run: prints the SQL
python3 mirror_writes.py --apply create-tenant ...                 # executes
python3 mirror_writes.py add-extension --tenant-id 107 --ext 101 --name "Jane" --email j@x.com
python3 mirror_writes.py render-and-install --tenant-id 107 --target-dir /tmp/t107 [--apply]
python3 -m unittest test_mirror
```

---

## 1. `create_tenant` row spec (THE critical deliverable)

Why this matters (coordinator, 2026-08-18): the unlicensed panel still accepts
adding extensions / devices / ring groups / forwards / inbound routes / trunks and
regenerates every tenant; the ONLY refused operation is **creating a new tenant**
("maximum number of free tenants"). So the rows below are what stands between
Connect and the licence.

Derived empirically from tenants **104, 105, 106** (panel-created 2026-08-05,
-06, -18 by the automation user 45) and cross-checked against 101/102 and the 21
older tenants. Every table in `ombutel` that carries a `tenant_id` was counted for
104/105/106; the tables below are exactly the ones that hold rows **at tenant
creation** (before any extension/DID/emergency work). Validated 2026-08-18 by
inserting tenant 107 "mirror_test" into `mirror-db` and running
`compare_tenant_rows.py --a 106 --b 107`: every table identical column-for-column
except the values that must differ (ids/name/path) and the rows the panel adds
LATER (emergency, extra `ombu_numbers` for emergency numbers, the lazily-created
`T<t>_*` dynamic-routing settings). Rendering tenant 107 with `vitalpbx_mirror.py`
and normalising against T106's baseline files gives 0 structural differences.

Order of inserts (ids captured as MySQL session variables in the dry-run script):

| # | table | columns → values | notes |
|---|---|---|---|
| 1 | `ombu_tenants` | `name`=slug (lowercase, non-alnum→`_`, e.g. `matamim_h8gmrh`), `description`=display name, `default`='no', `path`=**fresh unique 16 lowercase-hex** (`secrets.token_hex(8)`, checked against the table), `prefix`=NULL, `enabled`='yes' | `tenant_id` auto (or explicit). `path` is the AstDB family, the `/var/lib/vitalpbx/static/<path>` dir, the voicemail `tenant:` tag |
| 2 | `ombu_tenants_users` | `user_id`=creating panel user (45 = `lOOPCOMAGENT7548`, role 9), `tenant_id`, `default`='no' | the panel grants the creator access; `default` stays 'no' (a user's default tenant is unchanged) |
| 3 | `ombu_tenant_settings` ×21 | `addons`='' · `allow_recordings`='yes' · `allowed_outbound_routes`='' · `allowed_tenant_trunks`='' · `calls_limit`='' · `cid_name`='' · `cid_number`='' · `conferences`='' · `disable_trunks_prefix`='no' · `extensions`='' · `inbound_calls_limit`='' · `ivrs`='' · `mfa_allowed`='no' · `outbound_profiles`='' (csv of Main-tenant `ombu_ars` ids when known, e.g. `214`) · `parking_lots`='' · `queues`='' · `restricted_cid`='disabled' · `shared_trunks`='' · `timezone`='system' · `trunks`='' · `vpbx_devices`='' | composite PK (tenant_id,name); values are **empty strings, never NULL**. Older tenants (2–9) carry a 22nd row `emergency_trunks`='' — not written by the current panel. `extensions`/`queues`/… are per-tenant limits ('' = unlimited); `calls_limit` → AstDB `allowed_sim_calls` ('' → 0) |
| 4 | `ombu_classes_of_service` | `cos`='all', `description`='All Permissions', `feature_code_category_id`=NULL, `ars_id`=NULL, `dialrule_id`=NULL, `allowed_calls_by`=NULL, `private`='no', `billing_app_id`=NULL, `default`='yes', `tenant_id` | its auto id (105 for T104) is what `Gosub(sub-set-call-vars,s,1(<hash>,${EXTENSION},**105**,T104_cos-all,T104_ARS-all))` carries, what every `ombu_extensions.class_of_service_id` points at, and the AstDB `classes_of_service/105/*` + `classes_of_service/T104_cos-all : 105` keys |
| 5 | `ombu_dial_profiles` | `name`='Default', `music_group_id`=NULL, `allow_parking`='called', `allow_transfer`='called', `call_screening`='disabled', `ringing_tone`='yes', `custom_options`=NULL, `default`='yes' | → AstDB `dial_options : ktr`; every extension's `dial_profile_id` |
| 6 | `ombu_maintenance` | `cdr_preservation`=60, `recordings_preservation`=60, `voicemail_preservation`=30, `sms_preservation`=NULL, `logger_preservation`=NULL, `recordings_clear_less_nseconds`=5, `convert_recordings`='no', `conversion_quality`=16, `maintenance_cron`=NULL, `enabled`='yes', `default`='no' | |
| 7a | `ombu_destinations` | `category_id`=24, `module_id`=11, `index`='1' | the parking lot's timeout destination: category 24 = "terminate call", **module_id = the module that OWNS the reference** (11 = parking), index '1' = hangup |
| 7b | `ombu_parking_lots` | `extension`='700', `description`='Default Parking', `destination_id`=↑, `parkingtime`=45, `comebacktoorigin`='yes', `comebackdialtime`=20, `parkedplay`='caller', `parkpos`=10, `parkedcalltransfers`='no', `parkedcallreparking`='no', `parkedcallhangup`='no', `findslot`='first', `music_group_id`=NULL, `defpark`='yes', `announce_space_number`='yes', `record`='no' | renders `[parking-<t>]` (slots 701–710), the `[T<t>_ext-parking]` contexts and the 10 park hints. NB rendered `comebacktoorigin=no` + `comebackcontext=parking-<t>-callback` regardless of the DB 'yes' — the panel routes the comeback through its own callback context |
| 7c | `ombu_numbers` ×11 | `module_id`=11, `number`='700'…'710' | the panel's used-number registry (uniqueness of extensions/parking/custom apps/emergency numbers per tenant). Every extension later adds (1,`<ext>`); custom apps (9,`<ext>`); emergency (119,`<num>`) |
| 8 | `ombu_ars` | `description`='none', `default`='yes', `tenant_id` | the tenant's own empty outbound profile — renders as `[ARS-<id>]` with only the `i` exten. The *usable* profiles (`ARS-214` etc.) are Main-tenant (tenant 1) rows the panel still creates fine (trunk + outbound route + ARS in Main); pass their ids as `outbound_profile_ids` |
| 9a | `ombu_destinations` | `category_id`=31, `module_id`=29, `index`='1' | "verify DID" pseudo-destination for the Default inbound route → `Goto(verify-did,${CALL_DESTINATION},1)` |
| 9b | `ombu_inbound_routes` | `cos_id`=NULL, `description`='Default', `routing_method`='default', `did`=NULL, `channel_id`=NULL, `cid_management_id`=NULL, `cid_lookup_id`=NULL, `cid_number`=NULL, `destination_id`=↑, `language`='en', `music_group_id`=NULL, `alertinfo`=NULL, `enablerecording`='no', `digits_to_take`=NULL, `prepend`=NULL, `append`=NULL, `faxdetection`='no', `drop_anon_calls`='no', `detectiontime`=**NULL**, `fax_destination_id`=NULL, `privacyman`='no', `pmminlength`=10, `pmmaxretries`=3 | renders `exten => _[+*#0-9A-Za-z].,1,NoOp(INBOUND_ROUTE: Default)` |
| 10 | `ombu_queued_changes` ×3 | `module_id` = 42 (iax_settings), 43 (sip_settings), 110 (pjsip_settings) | the panel's own "pending Apply Changes" bookkeeping; every tenant carries exactly these three |
| 11 | `ombu_settings` ×2 | (108, `T<t>_reload_dialplan`, 'no'), (96, `T<t>_reload`, 'no') | needs the numeric id → `CONCAT('T', @tenant_id, '_reload')` in the script. Present for every live tenant. (T106 also has four `T<t>_{delete_used_records,digits_match,expiration_time,only_missed_calls}` module-128 rows; T104/T105 do NOT — created lazily; the renderer falls back to the un-prefixed global rows, values identical) |
| 12 | optional DID (`add_did`): `ombu_tenant_dids` (`did`, `description`='') + `ombu_destinations` (category of the target, module 29, index = target id — e.g. `(1,29,<extension_id>)` ring an extension, `(33,29,<cc_id>)` Connect doorway; default `(31,29,'1')` verify-DID until repointed) + `ombu_inbound_routes` (as 9b but `description`='Main', `did`=…, `detectiontime`=**5**) | |

NOT written, verified absent on 101/102/104/105/106: `ombu_ami_users` (0 rows on
those tenants), anything in the `provisioning` DB (its `settings` table has one
row, tenant 1; `templates`/`devices` are per phone), `ombu_users`/roles,
`ombu_music_groups`, `ombu_pickup_groups`, `ombu_feature_code_categories`,
emergency tables (Connect's E911 step adds those through the panel later:
`ombu_emergency_number_categories` + `_numbers` + `_locations` + `_trunks` +
`ombu_numbers` module 119).

Filesystem side the panel creates at save time (emitted as shell lines after the
SQL in the dry run): `/var/lib/vitalpbx/static/<path>/{moh,recordings,pdf,
voicemail,pictures,default_recordings,dictations,fax,reminders}` (2775; owners
per dir as in the baseline tar: top+dictations/fax/reminders `asterisk:www-data`,
moh/recordings/default_recordings `www-data:asterisk`, rest `www-data:www-data`)
and `/var/lib/vitalpbx/provisioning/provisioning_templates/<path>/{aastra.cfg,
index.php}` (`#Aastra Dummy File`, and the per-tenant `index.php` that pins
`$devTenant->path === "<path>"` — template in this folder).

### `add_extension` row spec (panel extension form / CSV import; the panel path still works, so second)

`ombu_extensions` (`extension`, `name`, `language`='en', `email`, `class_of_service_id`=tenant default CoS,
`dial_profile_id`=tenant default profile, `call_limit`=0, `internal_cid`=`"<name>" <<ext>>`, `external_cid`=NULL,
`emergency_cid`=NULL, `ringtime`=0, `nospy`='no', `enabled_pa`='no', `answermode`='disable',
`mailbox`=`<ext>@<slug>-voicemail`, `accountcode`=NULL, `features_password`=8 random alnum, `portal_password`=NULL,
`sendcid`='yes', `generate_hints`='no', `hot_desking`='no', `secretary`=NULL, `music_group_id`=1,
`rec_on_demand`='no', `internal_rec`='no', `outgoing_rec`='yes', `incoming_rec`='yes', `dictate_enable`='no',
`dictate_format`='wav', `dictate_auto_send`='no', `absent_secretary`='no', `lock`='no', `call_waiting`='yes',
`dynamic_external_cid`='no', `cid_on_diversions`='caller', `pinless`='no', `dynamic_routing`='no',
`sms_number_id`=NULL, `notify_missed_calls`=NULL, `callback_on_busy_transfer`='no')
· `ombu_numbers` (1, `<ext>`)
· `ombu_devices` desk: (`profile_id`=1, `user`=`<ext>`, `secret`, `description`=`Device <ext>`, `ring_device`='yes',
`technology`='pjsip', `assigned_exten`=`<ext>`, `vitxi_client`='no', `send_welcome_email`='no', `mobile_client`='no',
cid/dispatchable NULL) + `ombu_pjsip_devices` (`codecs`=NULL, `dtmfmode`='rfc4733', `max_contacts`=1, deny/permit `0.0.0.0/0`)
· `ombu_devices` WebRTC: (`profile_id`=12, `user`=`<ext>_1`, same secret on every live row, `description`=`<name>`,
`assigned_exten`=NULL, `vitxi_client`='yes') + `ombu_pjsip_devices` (`dtmfmode`='rfc2833' → renders `dtmf_mode=auto`, `max_contacts`=5)
· `ombu_extensions_vm` (`password`=`<ext>`, `context`=`<slug>-voicemail`, `skip_instructions`='no', `attach`/`saycid`/`sayduration`/`envelope`='yes',
`delete`/`hidefromdir`/`dialout`/`callback`/`create_hint`='no', `ask_password`='yes', `enabled`='yes', greetings/operator NULL, `ai_transcription`='no')
· `ombu_followme` (`music_group_id`=1, `followme_numbers`=NULL, `ringtime`=30, `initial_ringtime`=0, `ring_strategy`='one_by_one',
five `*_prompt_id`=1, `recname`/`enable_callee_prompt`/`internal_numbers_confirmation`='no')
· `ombu_extension_diversions` ×9 (BOSS, PEA, FWM, DND, CC, CFI, CFB, CFN, CFU — `enable`='no', destination/time_group NULL)
· `ombu_extensions_contact_info` (all NULL). No `ombu_extension_pea` (table empty platform-wide), no `ombu_users`.

---

## 2. Harness status (PASS/FAIL table) — see §5, filled in as the renderer progresses

## 3. Discovered mapping (table → template field) — see §4

_(sections 3–5 are appended below once the renderer pass is complete)_
