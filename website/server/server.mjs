/**
 * Loopcom website server — zero dependencies.
 *
 * Serves the static build and handles two POST endpoints:
 *   /api/quote  — the Request a Quote form
 *   /api/chat   — the chat assistant message relay
 *
 * ⛔ DESIGN RULE: A SUBMISSION IS NEVER LOST.
 * Every accepted submission is written to disk BEFORE any attempt to email it.
 * If SMTP is unconfigured or the send fails, the customer still gets a success
 * response and the lead is on disk to be picked up. Losing a customer's enquiry
 * because a mail server was down is the one failure that is not recoverable.
 */
import { createServer } from 'node:http';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sendMail, smtpConfigured, smtpStatus } from './mailer.mjs';
import { verifyTurnstile, turnstileStatus } from './turnstile.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, '..', 'dist');
const DATA = process.env.LOOPCOM_DATA_DIR || join(ROOT, '..', 'data');
const PORT = Number(process.env.PORT || 8080);
const TO = process.env.LOOPCOM_FORM_TO || 'onboarding@loopcom.net';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ utils */

/** Real client IP. nginx appends the true peer LAST, so take the last entry. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

/** ⛔ Anything that reaches a mail HEADER must not contain CR or LF. */
const headerSafe = (s, max = 200) =>
  String(s || '').replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()) &&
                       String(v).length <= 180;

function normalisePhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

/* -------------------------------------------------------------- rate limit */
const hits = new Map();               // ip -> [timestamps]
const WINDOW_MS = 60 * 60 * 1000;     // 1 hour

/**
 * ⛔ QUOTE AND CHAT GET SEPARATE BUDGETS, AND THAT SEPARATION IS THE POINT.
 * They shared one counter until 2026-08-24, which meant a visitor who sent a
 * few chat messages was then REFUSED when they tried to request a quote — the
 * primary conversion action on the site, disabled by using the chat widget.
 * A conversation is many messages by nature; a quote request is one or two.
 */
/**
 * ⛔ TWO BUDGETS, AND THE SPLIT IS THE WHOLE POINT.
 *
 * MAX_ACCEPTED bounds submissions that actually reach the inbox — that is the
 * thing worth protecting, and it is deliberately tight.
 *
 * MAX_ATTEMPTS bounds everything, including refusals, and is deliberately far
 * looser. Counting a failed attempt against the tight budget locks a real
 * person out for an hour because they mistyped their own email address a few
 * times, which is the most human thing there is. A bot spraying garbage is
 * still stopped, just at a threshold no honest visitor will ever reach.
 */
const MAX_ACCEPTED = { quote: 6, chat: 30 };
const MAX_ATTEMPTS = { quote: 40, chat: 120 };

/**
 * Count an ATTEMPT (any request that got past parsing) and report whether this
 * connection has made too many. Called once per request.
 */
function attemptLimited(ip, kind = 'quote') {
  const now = Date.now();
  const key = 'try|' + kind + '|' + ip;
  const cap = MAX_ATTEMPTS[kind] ?? MAX_ATTEMPTS.quote;
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  const over = arr.length >= cap;
  if (!over) arr.push(now);
  hits.set(key, arr);
  return over;
}

/**
 * Count an ACCEPTED submission — one that is about to be stored and emailed.
 * ⛔ Called only on the success path, never on a refusal.
 */
function acceptLimited(ip, kind = 'quote') {
  const now = Date.now();
  const key = 'ok|' + kind + '|' + ip;
  const cap = MAX_ACCEPTED[kind] ?? MAX_ACCEPTED.quote;
  const arr = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  const over = arr.length >= cap;
  if (!over) arr.push(now);
  hits.set(key, arr);
  return over;
}
setInterval(() => {                    // keep the map from growing forever
  const now = Date.now();
  for (const [k, arr] of hits) {
    const keep = arr.filter((t) => now - t < WINDOW_MS);
    if (keep.length) hits.set(k, keep); else hits.delete(k);
  }
}, 10 * 60 * 1000).unref();

/* ------------------------------------------------------------ body parsing */
const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // ⛔ Do NOT req.destroy() here. Destroying the socket kills the
        // connection before the 413 can be written, so the browser sees a
        // network error instead of our message. Stop reading, let the handler
        // answer, and only then close.
        req.pause();
        reject(new Error('too_large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse urlencoded or multipart/form-data into a plain object of strings/arrays. */
function parseForm(buf, contentType) {
  const out = {};
  const put = (k, v) => {
    if (k in out) { out[k] = [].concat(out[k], v); } else { out[k] = v; }
  };
  if (/application\/x-www-form-urlencoded/i.test(contentType || '')) {
    for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) put(k, v);
    return out;
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return out;
  const boundary = '--' + (m[1] || m[2]).trim();
  const parts = buf.toString('binary').split(boundary);
  for (const part of parts) {
    if (!part || part === '--\r\n' || part.trim() === '--') continue;
    const idx = part.indexOf('\r\n\r\n');
    if (idx === -1) continue;
    const head = part.slice(0, idx);
    let value = part.slice(idx + 4);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    const nameM = /name="([^"]*)"/i.exec(head);
    if (!nameM) continue;
    if (/filename="/i.test(head)) continue;      // ⛔ files are never accepted
    put(nameM[1], Buffer.from(value, 'binary').toString('utf8'));
  }
  return out;
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const list = (v) => (v == null ? [] : [].concat(v));

/* -------------------------------------------------------------- persistence */
async function persist(kind, record) {
  await mkdir(DATA, { recursive: true });
  const line = JSON.stringify(record) + '\n';
  await appendFile(join(DATA, `${kind}.jsonl`), line, 'utf8');
}

/** Operational log. ⛔ Never writes message bodies or personal detail. */
async function opLog(entry) {
  await mkdir(DATA, { recursive: true }).catch(() => {});
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await appendFile(join(DATA, 'submissions.log'), line, 'utf8').catch(() => {});
  console.log('[form]', JSON.stringify(entry));
}

/* ------------------------------------------------------------- email bodies */
/**
 * ⛔ ONLY SAYS ANYTHING WHEN THE CHECK DID NOT CONFIRM A PERSON.
 * A banner on every single email is noise that gets ignored, and an ignored
 * banner is the same as no banner on the one email where it matters.
 * 'verified' and 'off' are silent; 'unavailable' is the one worth seeing.
 */
function humanCheckNoteHtml(d) {
  if (d.humanCheck === 'verified' || d.humanCheck === 'off' || !d.humanCheck) return '';
  return '<p style="margin:0 0 16px;padding:10px 12px;background:#FFF6E5;border:1px solid #F0C97A;border-radius:6px;font-size:13.5px;color:#5A3E00">' +
    '<b>Robot check did not run.</b> Cloudflare could not be reached, so this was accepted without verification. Treat it with the usual care.</p>';
}
function humanCheckNoteText(d) {
  if (d.humanCheck === 'verified' || d.humanCheck === 'off' || !d.humanCheck) return '';
  return 'NOTE: robot check did not run (Cloudflare unreachable) — accepted unverified.';
}

function quoteEmail(d) {
  const row = (k, v) => v ? `<tr><td style="padding:6px 12px 6px 0;color:#4A5F76;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#071A2F"><b>${esc(v)}</b></td></tr>` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#071A2F;max-width:640px">
<h2 style="font-size:19px;margin:0 0 4px">New quote request</h2>
<p style="color:#4A5F76;margin:0 0 18px;font-size:14px">${esc(d.receivedAt)} &middot; reference ${esc(d.ref)}</p>
${humanCheckNoteHtml(d)}
<table style="border-collapse:collapse;font-size:14.5px">
${row('Business', d.business_name)}${row('Industry', d.industry)}
${row('People', d.seats)}${row('Locations', d.locations)}
${row('Current provider', d.current_provider)}${row('Keep numbers', d.porting)}
${row('Answer on', d.devices.join(', '))}
${row('Interested in', d.interests.join(', '))}
</table>
${d.notes ? `<p style="margin:18px 0 4px;color:#4A5F76;font-size:13px">Notes</p><div style="white-space:pre-wrap;background:#F5F8FC;border:1px solid #E2EAF2;border-radius:6px;padding:12px;font-size:14.5px">${esc(d.notes)}</div>` : ''}
<h3 style="font-size:15px;margin:22px 0 6px">Contact</h3>
<table style="border-collapse:collapse;font-size:14.5px">
${row('Name', d.contact_name)}${row('Email', d.email)}${row('Phone', d.phoneDisplay)}
</table>
<p style="margin:18px 0 0;font-size:13px;color:#4A5F76">
Consent to reply: <b>${d.consent_reply ? 'yes' : 'no'}</b><br>
Consent to SMS: <b>${d.consent_sms ? 'yes' : 'no'}</b><br>
Submitted from ${esc(d.ip)}
</p></div>`;

  const text = [
    'New quote request', `${d.receivedAt} — reference ${d.ref}`, humanCheckNoteText(d), '',
    `Business:         ${d.business_name}`, `Industry:         ${d.industry}`,
    `People:           ${d.seats}`, `Locations:        ${d.locations}`,
    `Current provider: ${d.current_provider || '—'}`, `Keep numbers:     ${d.porting}`,
    `Answer on:        ${d.devices.join(', ') || '—'}`,
    `Interested in:    ${d.interests.join(', ') || '—'}`, '',
    'Notes:', d.notes || '—', '',
    'Contact', `  Name:  ${d.contact_name}`, `  Email: ${d.email}`, `  Phone: ${d.phoneDisplay}`, '',
    `Consent to reply: ${d.consent_reply ? 'yes' : 'no'}`,
    `Consent to SMS:   ${d.consent_sms ? 'yes' : 'no'}`,
    `Submitted from ${d.ip}`,
  ].join('\n');

  return {
    subject: headerSafe(`Quote request — ${d.business_name} (${d.seats})`, 160),
    html, text,
  };
}

function chatEmail(d) {
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;color:#071A2F;max-width:640px">
<h2 style="font-size:19px;margin:0 0 4px">Website message</h2>
<p style="color:#4A5F76;margin:0 0 18px;font-size:14px">${esc(d.receivedAt)} &middot; reference ${esc(d.ref)}</p>
${humanCheckNoteHtml(d)}
<div style="white-space:pre-wrap;background:#F5F8FC;border:1px solid #E2EAF2;border-radius:6px;padding:14px;font-size:15px">${esc(d.message)}</div>
<p style="margin:18px 0 0;font-size:13.5px;color:#4A5F76">
Reply to: <b>${esc(d.email)}</b><br>
Sent from page: ${esc(d.page)}<br>
Submitted from ${esc(d.ip)}</p></div>`;
  const text = ['Website message', `${d.receivedAt} — reference ${d.ref}`, humanCheckNoteText(d), '', d.message, '',
    `Reply to: ${d.email}`, `Page: ${d.page}`, `From ${d.ip}`].join('\n');
  return { subject: headerSafe(`Website message from ${d.email}`, 160), html, text };
}

/* --------------------------------------------------------------- endpoints */
function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(b),
    'cache-control': 'no-store',
  });
  res.end(b);
}

/** Shared spam checks. Returns a reason string, or null when it looks human. */
function spamReason(f, ip, kind = 'quote') {
  if (headerSafe(first(f.website_url) || first(f.company) || '')) return 'honeypot';
  const started = Number(first(f.form_started) || 0);
  if (started && Date.now() - started < 2500) return 'too_fast';
  if (attemptLimited(ip, kind)) return 'rate_limited';
  return null;
}

async function handleQuote(req, res, f, ip) {
  const spam = spamReason(f, ip);
  if (spam) {
    await opLog({ kind: 'quote', outcome: 'refused', reason: spam, ip });
    if (spam === 'rate_limited') {
      return json(res, 429, { ok: false, message: 'Too many requests from this connection. Please try again shortly, or call us.' });
    }
    // Silently accept honeypot/too-fast: telling a bot why it failed helps it.
    return json(res, 200, { ok: true });
  }

  const business_name = headerSafe(first(f.business_name), 120);
  const contact_name = headerSafe(first(f.contact_name), 120);
  const email = headerSafe(first(f.email), 180);
  const phone = normalisePhone(first(f.phone));
  const consent_reply = !!first(f.consent_reply);

  const errors = {};
  if (!business_name) errors.business_name = 'Enter your business name.';
  if (!contact_name) errors.contact_name = 'Enter your name.';
  if (!isEmail(email)) errors.email = 'Enter an email address we can reply to.';
  if (!phone) errors.phone = 'Enter a complete 10-digit phone number.';
  if (!consent_reply) errors.consent_reply = 'We need your agreement in order to reply to you.';

  if (Object.keys(errors).length) {
    await opLog({ kind: 'quote', outcome: 'invalid', fields: Object.keys(errors), ip });
    return json(res, 400, { ok: false, message: 'Please check the highlighted fields.', errors });
  }

  // ⛔ AFTER field validation ON PURPOSE. A Turnstile token is single-use, so
  // verifying before validation would burn the visitor's token on an honest
  // typo and make their corrected resubmission fail for an unrelated reason.
  const human = await verifyTurnstile(first(f['cf-turnstile-response']), ip);
  if (!human.allow) {
    await opLog({ kind: 'quote', outcome: 'refused', reason: 'turnstile_' + human.outcome, detail: human.detail, ip });
    return json(res, 403, {
      ok: false,
      code: 'human_check_failed',
      message: 'We could not confirm this was sent by a person. Refresh the page and try once more, or email onboarding@loopcom.net or call (845) 723-1213.',
    });
  }

  const rec = {
    ref: randomUUID().slice(0, 8).toUpperCase(),
    receivedAt: new Date().toISOString(),
    humanCheck: human.outcome,
    business_name, contact_name, email,
    phone, phoneDisplay: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`,
    industry: headerSafe(first(f.industry), 80),
    seats: headerSafe(first(f.seats), 40),
    locations: headerSafe(first(f.locations), 40),
    current_provider: headerSafe(first(f.current_provider), 120),
    porting: headerSafe(first(f.porting), 80),
    devices: list(f.devices).map((v) => headerSafe(v, 40)),
    interests: list(f.interests).map((v) => headerSafe(v, 40)),
    notes: String(first(f.notes) || '').slice(0, 4000),
    consent_reply, consent_sms: !!first(f.consent_sms),
    ip,
  };

  if (acceptLimited(ip, 'quote')) {
    await opLog({ kind: 'quote', outcome: 'refused', reason: 'accept_rate_limited', ip });
    return json(res, 429, { ok: false, message: 'We already have several requests from this connection in the last hour. Give us a little time to reply to those first, or call (845) 723-1213.' });
  }

  // ⛔ Persist BEFORE emailing. The lead survives any mail failure.
  await persist('quotes', rec);

  const mail = quoteEmail(rec);
  let delivery = 'not_configured';
  if (smtpConfigured()) {
    try {
      await sendMail({ to: TO, replyTo: `${rec.contact_name} <${rec.email}>`, ...mail });
      delivery = 'sent';
    } catch (e) {
      delivery = 'failed';
      await opLog({ kind: 'quote', outcome: 'email_failed', ref: rec.ref, error: String(e && e.message).slice(0, 200), ip });
    }
  }
  await opLog({ kind: 'quote', outcome: 'accepted', ref: rec.ref, delivery, ip });
  return json(res, 200, { ok: true, ref: rec.ref });
}

async function handleChat(req, res, f, ip) {
  const spam = spamReason(f, ip, 'chat');
  if (spam) {
    await opLog({ kind: 'chat', outcome: 'refused', reason: spam, ip });
    if (spam === 'rate_limited') {
      return json(res, 429, { ok: false, message: 'Too many messages from this connection. Please try again shortly.' });
    }
    return json(res, 200, { ok: true });
  }

  const message = String(first(f.message) || '').trim().slice(0, 4000);
  const email = headerSafe(first(f.email), 180);
  if (!message) return json(res, 400, { ok: false, message: 'Type a message first.' });
  if (!isEmail(email)) return json(res, 400, { ok: false, message: 'Add an email address so we can reply.' });

  const human = await verifyTurnstile(first(f['cf-turnstile-response']), ip);
  if (!human.allow) {
    await opLog({ kind: 'chat', outcome: 'refused', reason: 'turnstile_' + human.outcome, detail: human.detail, ip });
    return json(res, 403, {
      ok: false,
      code: 'human_check_failed',
      message: 'We could not confirm this was sent by a person. Reload the page and try again, or email onboarding@loopcom.net.',
    });
  }

  const rec = {
    ref: randomUUID().slice(0, 8).toUpperCase(),
    receivedAt: new Date().toISOString(),
    humanCheck: human.outcome,
    message, email,
    page: headerSafe(first(f.page), 120) || '/',
    ip,
  };
  if (acceptLimited(ip, 'chat')) {
    await opLog({ kind: 'chat', outcome: 'refused', reason: 'accept_rate_limited', ip });
    return json(res, 429, { ok: false, message: 'We already have several messages from this connection in the last hour. We will reply to those first.' });
  }

  await persist('messages', rec);

  const mail = chatEmail(rec);
  let delivery = 'not_configured';
  if (smtpConfigured()) {
    try {
      await sendMail({ to: TO, replyTo: rec.email, ...mail });
      delivery = 'sent';
    } catch (e) {
      delivery = 'failed';
      await opLog({ kind: 'chat', outcome: 'email_failed', ref: rec.ref, error: String(e && e.message).slice(0, 200), ip });
    }
  }
  await opLog({ kind: 'chat', outcome: 'accepted', ref: rec.ref, delivery, ip });
  return json(res, 200, { ok: true, ref: rec.ref });
}

/* ------------------------------------------------------------ static files */
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = join(DIST, safe);
  if (!file.startsWith(DIST)) { res.writeHead(400).end('Bad request'); return; }

  if (!existsSync(file)) {
    const nf = join(DIST, '404.html');
    if (existsSync(nf)) {
      const body = await readFile(nf);
      res.writeHead(404, { 'content-type': MIME['.html'], 'content-length': body.length });
      return res.end(body);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }

  const ext = extname(file).toLowerCase();
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream' };
  // HTML must stay fresh so a deploy is never stale; hashed assets could be
  // immutable, but these are not hashed, so a short cache is the honest choice.
  headers['cache-control'] = ext === '.html'
    ? 'no-cache'
    : (ext === '.png' || ext === '.ico' || ext === '.woff2')
      ? 'public, max-age=604800'
      : 'public, max-age=3600';
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

/* -------------------------------------------------------------------- main */
const server = createServer(async (req, res) => {
  const url = req.url || '/';
  const ip = clientIp(req);
  try {
    if (req.method === 'POST' && (url === '/api/quote' || url === '/api/chat')) {
      let buf;
      try { buf = await readBody(req); }
      catch {
        res.setHeader('connection', 'close');
        return json(res, 413, { ok: false, message: 'That message is too large. Please shorten it and try again.' });
      }
      const f = parseForm(buf, req.headers['content-type']);
      return url === '/api/quote'
        ? await handleQuote(req, res, f, ip)
        : await handleChat(req, res, f, ip);
    }
    if (req.method === 'GET' && url === '/api/health') {
      return json(res, 200, { ok: true, smtp: smtpStatus(), uptime: Math.round(process.uptime()) });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' }).end('Method not allowed');
      return;
    }
    await serveStatic(req, res, url);
  } catch (err) {
    // ⛔ Never leak a stack trace to a visitor.
    console.error('[error]', err && err.stack ? err.stack : err);
    if (!res.headersSent) json(res, 500, { ok: false, message: 'Something went wrong at our end.' });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`loopcom website listening on 127.0.0.1:${PORT}`);
  console.log(`  dist: ${DIST}`);
  console.log(`  data: ${DATA}`);
  console.log(`  form recipient: ${TO}`);
  console.log(`  smtp: ${smtpStatus()}`);
});
