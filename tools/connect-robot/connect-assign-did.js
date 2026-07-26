#!/usr/bin/env node
/*
 * connect-assign-did.js
 * ---------------------------------------------------------------------------
 * Assign a phone number (DID) to a tenant in the Connect / VitalPBX panel by
 * replaying the panel's own internal save request (the public API can't do it).
 *
 * SAFETY:
 *   - Reads the robot login from a locked file, never hard-coded:
 *       /etc/connect-robot/credentials.env  (CONNECT_BASE_URL / CONNECT_ROBOT_USER / CONNECT_ROBOT_PASS)
 *   - By default it runs a DRY RUN: it logs in and prints exactly what it WOULD
 *     send, but does NOT change anything. It only makes a real change when you
 *     pass --commit. This makes accidental writes impossible.
 *
 * USAGE (on the Connect server):
 *   node connect-assign-did.js --did 8455551234 --tenant 2 --desc "Test"
 *        ^ dry run: shows what it would do, changes nothing
 *   node connect-assign-did.js --did 8455551234 --tenant 2 --desc "Test" --commit
 *        ^ actually assigns the number to tenant #2
 *
 * Captured request contract (reverse-engineered read-only):
 *   LOGIN:  POST /index.php   userid, userpass, loginForm=1        -> sets session cookie
 *   ASSIGN: POST /index.php   class=did_management, method=put, mode=add,
 *                             did=<10 digits>, description=<text>, tenant=<numeric id>
 */

'use strict';
const fs = require('fs');

const ENV_FILE = process.env.CONNECT_ENV_FILE || '/etc/connect-robot/credentials.env';

// ---- tiny .env loader (KEY=VALUE per line) --------------------------------
function loadEnv(path) {
  const out = {};
  let text;
  try { text = fs.readFileSync(path, 'utf8'); }
  catch (e) { fail(`Cannot read credentials file at ${path}. Create it first (see setup notes). [${e.code}]`); }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

// ---- parse CLI args --------------------------------------------------------
function parseArgs(argv) {
  const a = { commit: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--commit') a.commit = true;
    else if (k === '--did') a.did = argv[++i];
    else if (k === '--tenant') a.tenant = argv[++i];
    else if (k === '--desc') a.desc = argv[++i];
    else fail(`Unknown argument: ${k}`);
  }
  return a;
}

// ---- cookie jar helpers ----------------------------------------------------
function mergeCookies(jar, res) {
  let set = [];
  if (typeof res.headers.getSetCookie === 'function') set = res.headers.getSetCookie();
  else { const raw = res.headers.get('set-cookie'); if (raw) set = [raw]; }  // older Node fallback
  for (const c of set) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return jar;
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---- main ------------------------------------------------------------------
(async () => {
  const env = loadEnv(ENV_FILE);
  const BASE = (env.CONNECT_BASE_URL || '').replace(/\/+$/, '');
  const USER = env.CONNECT_ROBOT_USER;
  const PASS = env.CONNECT_ROBOT_PASS;
  if (!BASE || !USER || !PASS) fail('credentials.env must set CONNECT_BASE_URL, CONNECT_ROBOT_USER, CONNECT_ROBOT_PASS');

  const args = parseArgs(process.argv);
  if (!args.did || !args.tenant) fail('Required: --did <10 digits> --tenant <numeric tenant id>  [--desc "text"] [--commit]');
  const did = String(args.did).replace(/\D/g, '');           // keep digits only, matches stored format
  if (did.length < 7) fail(`--did looks wrong ("${args.did}"): expected plain digits like 8455551234`);
  const tenant = String(args.tenant);
  const desc = args.desc || '';

  const jar = {};

  // 1) prime a session cookie
  const home = await fetch(`${BASE}/index.php`, { method: 'GET', redirect: 'manual' });
  mergeCookies(jar, home);

  // 2) log in
  const loginBody = new URLSearchParams({ userid: USER, userpass: PASS, loginForm: '1' });
  const login = await fetch(`${BASE}/index.php`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader(jar) },
    body: loginBody,
  });
  mergeCookies(jar, login);
  const loginText = await login.text().catch(() => '');
  let notif = null;
  try { notif = (JSON.parse(loginText).notification) || null; } catch (_) { /* not JSON */ }
  if (notif && notif.type === 'error')
    fail(`Login rejected by panel: ${notif.title} — ${notif.text}. Check CONNECT_ROBOT_USER / CONNECT_ROBOT_PASS in ${ENV_FILE} (must be a valid panel login).`);
  const sessionCookie = jar['sid'] || jar['PHPSESSID'];   // panel uses 'sid'
  console.log(`[login] status=${login.status} sessionCookie=${sessionCookie ? 'yes' : 'no'} -> ${sessionCookie && !notif ? 'OK' : 'CHECK'}`);
  if (!sessionCookie) fail('No session cookie after login — the login likely failed (contract changed).');

  // 3) build the assign-DID request
  const assignBody = new URLSearchParams({
    class: 'did_management', method: 'put', mode: 'add',
    did, description: desc, tenant,
  });

  console.log('\n[assign] would POST to ' + BASE + '/index.php');
  console.log('         ' + assignBody.toString());

  if (!args.commit) {
    console.log('\nDRY RUN — nothing was changed. Re-run with --commit to actually assign.');
    return;
  }

  // 4) commit
  const assign = await fetch(`${BASE}/index.php`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookieHeader(jar),
    },
    body: assignBody,
  });
  const out = await assign.text();
  console.log(`\n[assign] status=${assign.status}`);
  console.log('[assign] response: ' + out.slice(0, 1000));
})().catch(e => fail(e.stack || String(e)));
