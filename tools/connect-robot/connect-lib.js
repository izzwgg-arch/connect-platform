'use strict';
/*
 * connect-lib.js — core library for automating the Connect / VitalPBX panel.
 *
 * Design goals (per requirements):
 *   - Each job runs in its OWN isolated session (own cookie jar) so parallel jobs
 *     never collide on the per-session "current tenant" cookie.
 *   - An account POOL (up to 15) so many setups run at once; each job checks out
 *     its own robot account + session, then releases it.
 *
 * Verified so far (login, tenant-switch cookie) are solid. Write operations are
 * built from captured request "recipes" and will be fine-tuned on the first
 * --commit test against the throwaway tenant.
 *
 * Credentials file (/etc/connect-robot/credentials.env), 600 root:
 *   CONNECT_BASE_URL=https://m.connectcomunications.com
 *   CONNECT_ROBOT_1_USER=...   CONNECT_ROBOT_1_PASS=...
 *   ...  up to CONNECT_ROBOT_15_USER / _PASS
 *   (a single legacy CONNECT_ROBOT_USER / _PASS is also accepted as one account)
 */
const fs = require('fs');
const path = require('path');

function loadConfig(envFile = process.env.CONNECT_ENV_FILE || '/etc/connect-robot/credentials.env') {
  const map = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const baseUrl = (map.CONNECT_BASE_URL || '').replace(/\/+$/, '');
  const accounts = [];
  if (map.CONNECT_ROBOT_USER && map.CONNECT_ROBOT_PASS)
    accounts.push({ id: 'robot', user: map.CONNECT_ROBOT_USER, pass: map.CONNECT_ROBOT_PASS });
  for (let i = 1; i <= 50; i++) {
    const u = map[`CONNECT_ROBOT_${i}_USER`], p = map[`CONNECT_ROBOT_${i}_PASS`];
    if (u && p) accounts.push({ id: `robot-${i}`, user: u, pass: p });
  }
  if (!baseUrl) throw new Error(`CONNECT_BASE_URL missing in ${envFile}`);
  if (!accounts.length) throw new Error(`No robot accounts found in ${envFile}`);
  return { baseUrl, accounts };
}

// Present as a real browser — some panels refuse non-browser requests.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const setCookies = res => (typeof res.headers.getSetCookie === 'function')
  ? res.headers.getSetCookie()
  : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);

class ConnectSession {
  constructor(baseUrl, account) { this.base = baseUrl; this.account = account; this.jar = {}; this.csrf = null; }
  _merge(res) { for (const c of setCookies(res)) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) this.jar[p.slice(0, i).trim()] = p.slice(i + 1).trim(); } }
  _cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async _fetch(pathPart, opts = {}) {
    opts.redirect = 'manual';
    opts.headers = Object.assign({
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': this.base + '/index.php',
      'Origin': this.base,
      'Cookie': this._cookieHeader(),
    }, opts.headers || {});
    const res = await fetch(this.base + pathPart, opts);
    this._merge(res);
    return res;
  }

  /** Sign in (verified). Throws on bad credentials. */
  async login() {
    await this._fetch('/index.php', { method: 'GET' });                 // prime the sid cookie
    const body = new URLSearchParams({ userid: this.account.user, userpass: this.account.pass, loginForm: '1' });
    const res = await this._fetch('/index.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body });
    let notif = null; try { notif = (JSON.parse(await res.text()).notification) || null; } catch (_) {}
    if (notif && notif.type === 'error') throw new Error(`[${this.account.id}] login rejected: ${notif.title} — ${notif.text}`);
    if (!this.jar.sid) throw new Error(`[${this.account.id}] login failed: no session cookie`);
    // The panel sets the current-tenant cookie (vpbx_tenant) on login — the browser keeps it; so do we.
    this.homeTenant = this.jar.vpbx_tenant || null;
    return this;
  }

  /** Switch which tenant this session operates in — verified: it's just a cookie. */
  setTenant(tenantPathHash) { this.jar.vpbx_tenant = tenantPathHash; this.csrf = null; return this; }

  /** Security token needed by module saves. Loaded from a module's rendered form. */
  async ensureCsrf(moduleClass = 'tenants') {
    const body = new URLSearchParams({ class: moduleClass, method: 'getContent', mode: 'read' });
    const raw = await (await this._fetch('/index.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body })).text();
    let src = raw; try { const j = JSON.parse(raw); if (j.html) src = j.html; } catch (_) {}
    const m = src.match(/value=["']([a-f0-9]{20,64})["'][^>]{0,60}name=["']csfr_token["']/i)   // value before name (this panel)
      || src.match(/name=["']csfr_token["'][^>]{0,120}value=["']([a-f0-9]{20,64})["']/i)         // name before value (fallback)
      || src.match(/form-group-csfr_token["'][^>]{0,40}value=["']([a-f0-9]{20,64})["']/i);
    this.csrf = m ? m[1] : null;
    return this.csrf;
  }

  /** Generic urlencoded module POST -> parsed panel JSON response. */
  async post(fields, { dryRun = false } = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.append(k, v == null ? '' : String(v));
    if (dryRun) return { dryRun: true, wouldPost: body.toString() };
    const res = await this._fetch('/index.php', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: !(json && json.notification && json.notification.type === 'error'), json, text: text.slice(0, 1500) };
  }

  // ---- captured operations (recipes) -------------------------------------
  /** Assign a DID (phone number) to a tenant. Carries its own tenant id (works from Main). */
  assignDid({ did, tenantId, description = '' }, opts = {}) {
    return this.post({ class: 'did_management', method: 'put', mode: 'add', did: String(did).replace(/\D/g, ''), description, tenant: String(tenantId) }, opts);
  }

  /** Create a tenant. assignToUserId => Option B (assign the new tenant to the robot user). */
  async createTenant(o, opts = {}) {
    const csfr_token = await this.ensureCsrf();
    const f = { class: 'tenants', method: 'put', mode: 'add', csfr_token, name: o.name, description: o.description || '', prefix: o.prefix || '', enabled: 'yes' };
    if (o.assignToUserId) { f.assign_to_existing_user = 'yes'; f.user_id = o.assignToUserId; } // exact field/value: confirm on first test
    else { f.user_email = o.userEmail; f.user_password = o.userPassword; f.full_name = o.fullName; f.role = o.role || ''; }
    return this.post(f, opts);
  }

  /** Bulk-import extensions from a CSV into the CURRENT tenant (call setTenant first). */
  async importExtensionsCsv(csvPath, { dryRun = false } = {}) {
    const csfr_token = await this.ensureCsrf();
    if (dryRun) return { dryRun: true, wouldUpload: path.basename(csvPath), fields: { class: 'menu4', method: 'put', mode: 'add', csfr_token: '(token)', csv: '(file)' } };
    const fd = new FormData();
    fd.append('class', 'menu4'); fd.append('method', 'put'); fd.append('mode', 'add'); fd.append('csfr_token', csfr_token);
    fd.append('csv', new Blob([fs.readFileSync(csvPath)], { type: 'text/csv' }), path.basename(csvPath));
    const res = await this._fetch('/index.php', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: fd });
    let json = null; const text = await res.text(); try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, ok: !(json && json.notification && json.notification.type === 'error'), json, text: text.slice(0, 1500) };
  }
}

/** Async account pool: acquire() -> logged-in isolated session; release() returns the account. */
class Pool {
  constructor(baseUrl, accounts) { this.base = baseUrl; this.freeAccts = accounts.slice(); this.waiters = []; }
  get size() { return this.freeAccts.length; }
  async acquire() {
    const acct = this.freeAccts.shift() || await new Promise(r => this.waiters.push(r));
    return new ConnectSession(this.base, acct).login();
  }
  release(session) {
    const w = this.waiters.shift();
    if (w) w(session.account); else this.freeAccts.push(session.account);
  }
  /** Run many job(fn(session)) tasks with at most `accounts` in flight at once. */
  async runAll(tasks) {
    return Promise.all(tasks.map(async task => {
      const s = await this.acquire();
      try { return { ok: true, result: await task(s) }; }
      catch (e) { return { ok: false, error: e.message }; }
      finally { this.release(s); }
    }));
  }
}

module.exports = { loadConfig, ConnectSession, Pool };
