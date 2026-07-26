#!/usr/bin/env node
'use strict';
/*
 * provision-tenant.js — full customer provisioning for the Connect/VitalPBX panel.
 * Replicates Izzy's recorded flow EXACTLY (2026-07-26 recording), nothing more, nothing less:
 *   1. Trunk (VoIP.ms, codecs ulaw,alaw,g726,g729)          -> Apply
 *   2. Outbound route (5 patterns, prepend 845 on 7-digit)  -> Apply
 *   3. Route selection (ARS)                                -> Apply
 *   4. Tenant (outbound profile + DID in the form)          -> Apply
 *   5. Per person: extension via CSV (PJSIP, rec+VM on)
 *      + WebRTC device via edit (always)
 *      + virtual device via edit (only if virtual_number)   -> Apply per person
 *   6. Inbound route "Main" (DID -> first extension)        -> Apply
 *
 * Usage:  node provision-tenant.js job.json
 *   job.json = single job object or array of jobs (runs up to pool-size in parallel):
 *   {
 *     "company": "j&j PLumbing",
 *     "voipms": { "user": "344022_xx", "pass": "...", "server": "newyork1.voip.ms" },
 *     "did": "8455577726",
 *     "people": [ { "name": "JOhn", "ext": "101", "email": "x@y.com",
 *                   "virtual_number": "5622096644" } ]   // virtual_number optional
 *   }
 * Every save is checked: panel "success" that carries a hidden error dialog is
 * treated as FAILURE and the real error text is reported. Every object is
 * verified to exist (via the panel itself) before the flow continues.
 */
const fs = require('fs');
const { loadConfig, ConnectSession, Pool } = require('/opt/connect-robot/connect-lib');

const MAIN_TENANT = '2dc3974017c1bc65';
const CODECS = ['ulaw', 'alaw', 'g726', 'g729'];          // recorded order
const PH = '{{row-count-placeholder}}';
const CSV_HEADER = 'mode,extension,ext_name,language,class_of_service,technology,profile_name,device_user,device_password,device_description,devices_emergency_cid_name,devices_emergency_cid_number,virtual_number,ring_device,codecs,max_contacts,features_password,email,did_number,cid_number,call-limit,call_waiting,vm_enabled,vm_password,saycid,sayduration,envelope,attach,delete,ask_password,skip_instructions,outgoing_rec,incoming_rec,external_cid_name,external_cid_number,emergency_cid_name,emergency_cid_number,dial_profile,accountcode,followme_numbers,initial_ringtime,fw_ringtime,ring_strategy,followme-enabled,recname,enable_callee_prompt,internal_numbers_confirmation,dynamic_queues,static_queues,mobile_number,home_number,organization,job_title,send_welcome_email,vitxi_client,mobile_client,notify_missed_calls,callback_on_busy_transfer';

const slugify = c => c.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const decode = t => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0*39;|&apos;/g, "'").replace(/&quot;/g, '"');

class StepError extends Error { constructor(step, msg) { super(`[${step}] ${msg}`); this.step = step; } }

// ---------- low-level panel helpers -----------------------------------------
async function post(s, pairs) {
  const body = new URLSearchParams();
  for (const [k, v] of pairs) body.append(k, v == null ? '' : String(v));
  const res = await s._fetch('/index.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { json, text };
}
function dialogErrors(r) {   // panel hides errors inside "success" + action:dialog
  if (!(r.json && r.json.action === 'dialog')) return null;
  const items = (r.json.html || '').match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
  const errs = items.map(x => decode(x.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return errs.length ? errs.join(' | ') : 'panel returned an error dialog';
}
function assertSaved(step, r) {
  const dlg = dialogErrors(r);
  if (dlg) throw new StepError(step, dlg);
  if (r.json && r.json.notification && r.json.notification.type === 'error')
    throw new StepError(step, decode(r.json.notification.text || 'error'));
  if (!(r.json && r.json.state === 'success')) throw new StepError(step, 'unexpected response: ' + r.text.slice(0, 200));
}
async function apply(s, step) {
  const r = await post(s, [['call', 'generateConfigurations'], ['data', '0']]);
  if (!(r.json && r.json.state === 'success')) throw new StepError(step, 'Apply Changes failed: ' + r.text.slice(0, 200));
}
async function loadForm(s, cls, mode, data) {
  const pairs = [['class', cls], ['method', 'getContent'], ['mode', mode]];
  if (data != null) pairs.push(['data', String(data)]);
  const { text } = await post(s, pairs);
  try { const j = JSON.parse(text); if (j.html != null) return j.html; } catch (_) {}
  return text;
}
function findOption(html, matcher) {  // -> value of first <option> whose text matches
  for (const m of html.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    if (matcher(decode(m[2]).trim(), m[1])) return m[1];
  }
  return null;
}
// Read a rendered form back as [name,value] pairs, exactly as a browser would submit it:
// unchecked checkboxes are OMITTED, multi-selects contribute one pair per selected option.
function parseFormPairs(html) {
  const pairs = [];
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0]; const n = (tag.match(/name=["']([^"']+)["']/i) || [])[1];
    if (!n || n.includes('{{')) continue;
    const type = ((tag.match(/type=["']([^"']+)["']/i) || [])[1] || 'text').toLowerCase();
    const val = (tag.match(/value=["']([^"']*)["']/i) || [])[1] || '';
    if (type === 'checkbox' || type === 'radio') { if (/\bchecked\b/i.test(tag)) pairs.push([n, val || '1']); }
    else pairs.push([n, val]);
  }
  for (const m of html.matchAll(/<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    const n = m[1]; if (n.includes('{{')) continue;
    const isMulti = /\bmultiple\b/i.test(m[0]); let any = false;
    for (const o of m[2].matchAll(/<option\b[^>]*>/gi)) {
      if (/\bselected\b/i.test(o[0])) { pairs.push([n, (o[0].match(/value=["']([^"']*)["']/i) || [])[1] || '']); any = true; if (!isMulti) break; }
    }
    if (!any && !isMulti) pairs.push([n, (m[2].match(/<option[^>]*value=["']([^"']*)["']/i) || [])[1] || '']);
  }
  return pairs;
}
const upsert = (pairs, k, v) => { const i = pairs.findIndex(([n]) => n === k); if (i >= 0) pairs[i] = [k, v]; else pairs.push([k, v]); };
const drop = (pairs, ...keys) => pairs.filter(([n]) => !keys.includes(n));

// ---------- flow steps (field sets are the recorded ones, verbatim) ----------
async function createTrunk(s, co, vm) {
  const csrf = await s.ensureCsrf('trunks');
  const p = [
    ['trunk_mode', 'visual'], ['class', 'trunks'], ['method', 'put'], ['mode', 'add'], ['csfr_token', csrf],
    ['technology', 'pjsip'], ['description', co], ['tenant_trunk_id', '2'], ['class_of_service_id', ''], ['cos_id_current', ''],
    ['ringtimer', '90'], ['dial_profile_id', '1'], ['profile_id', '1'], ['music_group_id', ''],
  ];
  for (const c of CODECS) p.push(['codecs[]', c]);
  p.push(
    ['dtmfmode', 'rfc4733'], ['simultaneous_calls', ''], ['nat', ''], ['get_did_from', ''], ['get_cid_from', ''],
    ['trunk_cid_name', ''], ['trunk_cid_number', ''], ['overwrite_cid', 'no'], ['dial_prefix', ''],
    ['outgoing[username]', vm.user], ['outgoing_settings', ''], ['outgoing[host]', vm.server], ['outgoing[port]', ''], ['outgoing[secret]', ''],
    ['outgoing[insecure]', ''], ['outgoing[type]', '1'], ['outgoing[transport]', '1'], ['outgoing[contacts]', ''],
    ['outgoing[match]', vm.server], ['outgoing[qualify_frequency]', '30'], ['outgoing[qualify_timeout]', '3'], ['outgoing[max_contacts]', '2'],
    ['outgoing[defaultuser]', vm.user], ['outgoing[remotesecret]', vm.pass], ['outgoing[fromuser]', vm.user], ['outgoing[fromdomain]', vm.server],
    ['outgoing[trunk]', '1'], ['outgoing[qualify]', '1'], ['outgoing[outbound_proxy]', ''], ['outgoing[contact_header]', vm.user], ['outgoing[match_header]', ''],
    ['incoming[username]', ''], ['incoming_settings', ''], ['incoming[host]', ''], ['incoming[secret]', ''], ['incoming[remotesecret]', ''],
    ['incoming[insecure]', ''], ['incoming[trunk]', '1'], ['incoming[qualify]', '1'],
    ['register', ''], ['custom_sip_register', ''], ['custom_iax_register', ''],
    ['outgoing[outbound_registration]', ''], ['outgoing[client_uri]', `sip:${vm.user}@${vm.server}`], ['outgoing[server_uri]', 'sip:' + vm.server],
    ['outgoing[contact_user]', ''], ['outgoing[max_retries]', '10'], ['outgoing[expiration]', '3600'], ['outgoing[retry_interval]', '60'], ['outgoing[forbidden_retry_interval]', '10'],
    ['dial_string', ''],
    [`trkcustom[${PH}][type]`, 'friend'], [`trkcustom[${PH}][param]`, ''], [`trkcustom[${PH}][value]`, ''], [`trkcustom[${PH}][enabled]`, '1'],
    ['trkcustom[0][type]', 'friend'], ['trkcustom[0][param]', ''], ['trkcustom[0][value]', ''], ['trkcustom[0][enabled]', '1'],
    [`trk-headers[${PH}][param]`, ''], [`trk-headers[${PH}][value]`, ''], ['trk-headers[0][param]', ''], ['trk-headers[0][value]', ''],
    [`rules[${PH}][prepend]`, ''], [`rules[${PH}][prefix]`, ''], [`rules[${PH}][pattern]`, ''], [`rules[${PH}][enabled]`, '1'],
    ['rules[0][prepend]', ''], ['rules[0][prefix]', ''], ['rules[0][pattern]', ''], ['rules[0][enabled]', '1'],
  );
  assertSaved('trunk', await post(s, p));
  await apply(s, 'trunk');
  const h = await loadForm(s, 'trunk_group', 'add');
  const id = findOption(h, t => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new StepError('trunk', `trunk "${co}" not found in outbound-route form after create`);
  return id;
}
async function createOutboundRoute(s, co, did, trunkId) {
  const csrf = await s.ensureCsrf('trunk_group');
  const p = [
    ['class', 'trunk_group'], ['method', 'put'], ['mode', 'add'], ['csfr_token', csrf],
    ['description', co], ['trklist[]', trunkId], ['pin_list_id', ''], ['csv', ''],
    ['cid_name', co], ['cid_number', did], ['overwrite_cid', 'if_not_provided'],
    [`trkpattern[${PH}][prepend]`, ''], [`trkpattern[${PH}][prefix]`, ''], [`trkpattern[${PH}][pattern]`, ''], [`trkpattern[${PH}][cid_pattern]`, ''],
    ['trkpattern[0][prepend]', '845'], ['trkpattern[0][prefix]', ''], ['trkpattern[0][pattern]', 'nxxxxxx'], ['trkpattern[0][cid_pattern]', ''],
    ['trkpattern[1][prepend]', ''], ['trkpattern[1][prefix]', ''], ['trkpattern[1][pattern]', 'nxxnxxxxxx'], ['trkpattern[1][cid_pattern]', ''],
    ['trkpattern[2][prepend]', ''], ['trkpattern[2][prefix]', ''], ['trkpattern[2][pattern]', '1nxxnxxxxxx'], ['trkpattern[2][cid_pattern]', ''],
    ['trkpattern[3][prepend]', ''], ['trkpattern[3][prefix]', ''], ['trkpattern[3][pattern]', '+1nxxnxxxxxx'], ['trkpattern[3][cid_pattern]', ''],
    ['trkpattern[4][prepend]', ''], ['trkpattern[4][prefix]', ''], ['trkpattern[4][pattern]', '011.'], ['trkpattern[4][cid_pattern]', ''],
    ['mod_dest', ''], ['destination', ''], ['destination_custom', ''],
  ];
  assertSaved('outbound-route', await post(s, p));
  await apply(s, 'outbound-route');
  const h = await loadForm(s, 'ars', 'add');
  const id = findOption(h, t => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new StepError('outbound-route', `route "${co}" not found in route-selection form after create`);
  return id;
}
async function createRouteSelection(s, co, routeId) {
  const csrf = await s.ensureCsrf('ars');
  assertSaved('route-selection', await post(s, [
    ['class', 'ars'], ['method', 'put'], ['mode', 'add'], ['csfr_token', csrf], ['description', co],
    [`members[${PH}][outbound_route_id]`, ''], [`members[${PH}][time_group_id]`, ''], [`members[${PH}][enabled]`, '1'],
    ['members[0][outbound_route_id]', routeId], ['members[0][time_group_id]', ''], ['members[0][enabled]', '1'],
  ]));
  await apply(s, 'route-selection');
  const h = await loadForm(s, 'tenants', 'add');
  const id = findOption(h, t => t.toLowerCase() === co.toLowerCase());
  if (!id) throw new StepError('route-selection', `selection "${co}" not found in tenant form after create`);
  return id;
}
async function createTenant(s, co, slug, did, arsId) {
  const csrf = await s.ensureCsrf('tenants');
  assertSaved('tenant', await post(s, [
    ['class', 'tenants'], ['method', 'put'], ['mode', 'add'], ['csfr_token', csrf],
    ['name', slug], ['description', co], ['prefix', ''], ['enabled', '1'],
    ['assign_to_existing_user', ''], ['user_id', '45'], ['user_email', ''], ['user_password', ''], ['full_name', ''], ['role', '4'],
    ['startapp', 'dashboard'], ['startapp_custom', ''], ['send_welcome_email', '1'],
    ['settings[extensions]', ''], ['settings[trunks]', ''], ['settings[queues]', ''], ['settings[ivrs]', ''],
    ['settings[conferences]', ''], ['settings[parking_lots]', ''], ['settings[vpbx_devices]', ''], ['settings[allow_recordings]', ''],
    ['recordings_preservation', '60'], ['voicemail_preservation', '30'], ['cdr_preservation', '60'],
    ['outbound_profiles[]', arsId], ['restricted_cid', 'disabled'], ['calls_limit', ''], ['inbound_calls_limit', ''],
    ['cid_name', ''], ['cid_number', ''],
    [`inbound_numbers[${PH}][did]`, ''], [`inbound_numbers[${PH}][description]`, ''],
    ['inbound_numbers[0][did]', did], ['inbound_numbers[0][description]', ''],
    ['settings[timezone]', 'system'],
  ]));
  await apply(s, 'tenant');
  // find the new tenant's path hash (scan every 16-hex option for slug or company)
  const h = await loadForm(s, 'tenants', 'read');
  let path = null;
  for (const m of h.matchAll(/value=["']([a-f0-9]{16})["'][^>]*>([\s\S]{0,120}?)</gi)) {
    const t = decode(m[2]).trim().toLowerCase();
    if (t === slug || t === co.toLowerCase()) { path = m[1]; break; }
  }
  if (!path) { // fallback: any 16-hex token adjacent to the slug anywhere in the page
    const m = h.match(new RegExp('([a-f0-9]{16})[^a-f0-9]{0,200}?' + slug, 'i')) || h.match(new RegExp(slug + '[^a-f0-9]{0,200}?([a-f0-9]{16})', 'i'));
    if (m) path = m[1];
  }
  if (!path) throw new StepError('tenant', `tenant "${slug}" created but its path was not found — cannot switch into it`);
  return path;
}
async function importExtension(s, person) {
  const cols = CSV_HEADER.split(',');
  const rowOf = o => cols.map(c => o[c] != null ? String(o[c]) : '').join(',');
  const csv = CSV_HEADER + '\n' + rowOf({
    mode: 'add', extension: person.ext, ext_name: person.name, class_of_service: 'all',
    technology: 'pjsip', profile_name: 'Default PJSIP Profile', device_user: person.ext,
    email: person.email || '', outgoing_rec: 'yes', incoming_rec: 'yes', vm_enabled: 'yes',
  }) + '\n';
  const csrf = await s.ensureCsrf('menu4');
  const fd = new FormData();
  fd.append('class', 'menu4'); fd.append('method', 'put'); fd.append('mode', 'add'); fd.append('csfr_token', csrf);
  fd.append('csv', new Blob([csv], { type: 'text/csv' }), 'import_extensions.csv');
  const res = await s._fetch('/index.php', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
  let j = null; try { j = JSON.parse(await res.text()); } catch (_) {}
  const note = (j && j.notification && j.notification.text) || '';
  if (!/completed successfully/i.test(note)) throw new StepError('extension-import', `ext ${person.ext}: ${note || 'import failed'}`);
}
async function extensionId(s, ext) {  // same lookup the panel makes for inbound-route destinations
  const { text } = await post(s, [['class', 'inbound_route'], ['method', 'getDestinationChildOptions'], ['mode', 'view'],
    ['data[selected]', '1'], ['data[parent]', 'inbound_route-mod_dest'], ['data[child]', 'inbound_route-destination']]);
  let h = text; try { const j = JSON.parse(text); h = typeof (j.html || j.options) === 'string' ? (j.html || j.options) : JSON.stringify(j); } catch (_) {}
  h = h.replace(/\\"/g, '"').replace(/\\\//g, '/');
  for (const m of h.matchAll(/value=["'](\d+)["'][^>]*>([^<]*)/gi)) {
    if (new RegExp('(^|\\D)' + ext + '(\\D|$)').test(m[2])) return m[1];
  }
  throw new StepError('extension-import', `extension ${ext} not visible in destination list after import`);
}
async function addDevice(s, extId, person, kind) {
  const h = await loadForm(s, 'extensions', 'edit', extId);
  let pairs = parseFormPairs(h);
  pairs = drop(pairs, 'dynamic_queues[]', 'static_queues[]');
  upsert(pairs, 'class', 'extensions'); upsert(pairs, 'method', 'put'); upsert(pairs, 'mode', 'edit');
  upsert(pairs, 'device_id', 'new'); upsert(pairs, 'ring_device', 'yes'); upsert(pairs, 'dev_description', person.name);
  if (kind === 'webrtc') {
    const webrtcProfile = findOption(h, t => /webrtc/i.test(t)) || '12';
    upsert(pairs, 'technology', 'pjsip'); upsert(pairs, 'profile_id', webrtcProfile);
    upsert(pairs, 'user', person.ext + '_1'); upsert(pairs, 'max_contacts', '5'); upsert(pairs, 'vitxi_client', '1');
  } else { // virtual — recorded: no profile/vitxi/max_contacts, dtmf rfc2833
    pairs = drop(pairs, 'profile_id', 'vitxi_client', 'max_contacts');
    upsert(pairs, 'technology', 'virtual'); upsert(pairs, 'number', person.virtual_number);
    upsert(pairs, 'user', person.ext + '_2'); upsert(pairs, 'dtmfmode', 'rfc2833');
  }
  assertSaved(`device-${kind}`, await post(s, pairs));
  // verify the device is now on the extension
  const h2 = await loadForm(s, 'extensions', 'edit', extId);
  const marker = kind === 'webrtc' ? person.ext + '_1' : person.virtual_number;
  if (!h2.includes(marker)) throw new StepError(`device-${kind}`, `device not found on extension ${person.ext} after save`);
}
async function createInboundRoute(s, did, destExtId, co) {
  const csrf = await s.ensureCsrf('menu29');
  assertSaved('inbound-route', await post(s, [
    ['class', 'inbound_route'], ['method', 'put'], ['mode', 'add'], ['csfr_token', csrf],
    ['routing_method', 'default'], ['description', 'Main'], ['did', did], ['cid_number', ''],
    ['cid_management_id', ''], ['cid_lookup_id', ''], ['language', 'en'], ['music_group_id', ''], ['alertinfo', ''],
    ['pmmaxretries', '3'], ['pmminlength', '10'], ['detectiontime', '5'],
    ['fax_mod_dest', ''], ['fax_destination', ''], ['fax_destination_custom', ''],
    ['mod_dest', '1'], ['destination', destExtId], ['digits_to_take', '1'], ['cos_id', ''], ['prepend', ''], ['append', ''],
  ]));
  await apply(s, 'inbound-route');
}

// ---------- one whole job ----------------------------------------------------
async function provision(s, job, log = console.log) {
  const co = job.company, slug = slugify(co);
  if (!co || !job.did || !job.voipms || !job.voipms.user || !job.voipms.pass || !job.voipms.server)
    throw new StepError('input', 'job needs company, did, voipms{user,pass,server}');
  if (!Array.isArray(job.people) || !job.people.length) throw new StepError('input', 'job needs at least one person');

  s.setTenant(MAIN_TENANT);
  const trunkId = await createTrunk(s, co, job.voipms);            log(`[${co}] trunk ok (id ${trunkId})`);
  const routeId = await createOutboundRoute(s, co, job.did, trunkId); log(`[${co}] outbound route ok (id ${routeId})`);
  const arsId = await createRouteSelection(s, co, routeId);        log(`[${co}] route selection ok (id ${arsId})`);
  const path = await createTenant(s, co, slug, job.did, arsId);    log(`[${co}] tenant ok (path ${path})`);

  s.setTenant(path);
  let firstExtId = null;
  for (const person of job.people) {
    await importExtension(s, person);
    const extId = await extensionId(s, person.ext);
    if (!firstExtId) firstExtId = extId;
    await addDevice(s, extId, person, 'webrtc');                   // always: PJSIP + WebRTC
    if (person.virtual_number) await addDevice(s, extId, person, 'virtual');
    await apply(s, 'extensions');
    log(`[${co}] extension ${person.ext} ${person.name} ok (id ${extId}${person.virtual_number ? ', +virtual' : ''})`);
  }
  await createInboundRoute(s, job.did, firstExtId, co);            log(`[${co}] inbound route ok`);
  return { company: co, slug, tenantPath: path, trunkId, routeId, arsId, firstExtId };
}

// ---------- CLI --------------------------------------------------------------
if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) { console.error('usage: node provision-tenant.js job.json'); process.exit(2); }
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jobs = Array.isArray(spec) ? spec : [spec];
    const cfg = loadConfig();
    const pool = new Pool(cfg.baseUrl, cfg.accounts);
    const results = await pool.runAll(jobs.map(job => async s => provision(s, job)));
    let failed = 0;
    results.forEach((r, i) => {
      if (r.ok) console.log(`DONE  ${jobs[i].company}:`, JSON.stringify(r.result));
      else { failed++; console.error(`FAILED ${jobs[i].company}: ${r.error}`); }
    });
    process.exit(failed ? 1 : 0);
  })().catch(e => { console.error('FATAL', e.message); process.exit(1); });
}
module.exports = { provision };
