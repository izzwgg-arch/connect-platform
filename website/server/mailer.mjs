/**
 * Minimal SMTP client — zero dependencies.
 *
 * Speaks enough SMTP to submit one message through a provider such as Google
 * Workspace: EHLO, STARTTLS, AUTH LOGIN, MAIL FROM, RCPT TO, DATA.
 *
 * ⛔ Configuration comes from the environment only. Never commit credentials.
 *   LOOPCOM_SMTP_HOST   e.g. smtp.gmail.com
 *   LOOPCOM_SMTP_PORT   587 (STARTTLS) or 465 (implicit TLS)
 *   LOOPCOM_SMTP_USER   the mailbox, e.g. onboarding@loopcom.net
 *   LOOPCOM_SMTP_PASS   an app password
 *   LOOPCOM_SMTP_FROM   optional; defaults to "Loopcom Website <USER>"
 */
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { randomUUID } from 'node:crypto';

const CFG = () => ({
  host: process.env.LOOPCOM_SMTP_HOST || '',
  port: Number(process.env.LOOPCOM_SMTP_PORT || 587),
  user: process.env.LOOPCOM_SMTP_USER || '',
  pass: process.env.LOOPCOM_SMTP_PASS || '',
  from: process.env.LOOPCOM_SMTP_FROM || '',
});

export function smtpConfigured() {
  const c = CFG();
  return Boolean(c.host && c.user && c.pass);
}

export function smtpStatus() {
  const c = CFG();
  if (!c.host) return 'not configured (LOOPCOM_SMTP_HOST unset)';
  if (!c.user || !c.pass) return `host ${c.host} set, credentials missing`;
  return `configured: ${c.user} via ${c.host}:${c.port}`;
}

/** Strip anything that could forge a header. */
const hdr = (s, max = 400) =>
  String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/** RFC 2047 encode when a header carries non-ASCII. */
function encodeHeader(s) {
  const v = hdr(s);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  return '=?UTF-8?B?' + Buffer.from(v, 'utf8').toString('base64') + '?=';
}

/** Extract a bare address from "Name <a@b.c>" or "a@b.c". */
function bareAddress(s) {
  const v = hdr(s, 320);
  const m = /<([^>]+)>/.exec(v);
  return (m ? m[1] : v).trim();
}

class SmtpSession {
  constructor(sock) { this.sock = sock; this.buf = ''; this.queue = []; this._wire(); }

  _wire() {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (d) => {
      this.buf += d;
      let idx;
      // a reply is complete when a line reads "NNN " (space, not hyphen)
      while ((idx = this.buf.indexOf('\r\n')) !== -1) {
        const line = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        this.lines = (this.lines || []).concat(line);
        if (/^\d{3} /.test(line)) {
          const reply = this.lines.join('\n');
          this.lines = [];
          const w = this.queue.shift();
          if (w) w.resolve(reply);
        }
      }
    });
  }

  read() { return new Promise((resolve, reject) => { this.queue.push({ resolve, reject }); }); }

  async cmd(text, expect) {
    if (text !== null) this.sock.write(text + '\r\n');
    const reply = await this.read();
    const code = Number(reply.slice(0, 3));
    if (expect && !expect.includes(code)) {
      throw new Error(`SMTP ${code}: ${reply.split('\n')[0].slice(0, 160)}`);
    }
    return reply;
  }

  upgrade(host) {
    return new Promise((resolve, reject) => {
      const plain = this.sock;
      plain.removeAllListeners('data');
      const tls = tlsConnect({ socket: plain, servername: host }, () => resolve(tls));
      tls.once('error', reject);
    });
  }
}

function openSocket(cfg) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    if (cfg.port === 465) {
      const s = tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host }, () => {
        s.removeListener('error', onErr); resolve({ sock: s, secure: true });
      });
      s.once('error', onErr);
      s.setTimeout(20000, () => { s.destroy(new Error('smtp connect timeout')); });
    } else {
      const s = createConnection({ host: cfg.host, port: cfg.port }, () => {
        s.removeListener('error', onErr); resolve({ sock: s, secure: false });
      });
      s.once('error', onErr);
      s.setTimeout(20000, () => { s.destroy(new Error('smtp connect timeout')); });
    }
  });
}

/**
 * Send one message.
 * ⛔ Callers must never retry this blindly — a duplicate enquiry is confusing,
 * and the caller has already persisted the record to disk regardless.
 */
export async function sendMail({ to, subject, html, text, replyTo }) {
  const cfg = CFG();
  if (!smtpConfigured()) throw new Error('smtp_not_configured');

  const fromHeader = cfg.from || `Loopcom Website <${cfg.user}>`;
  const envelopeFrom = bareAddress(cfg.from || cfg.user);
  const envelopeTo = bareAddress(to);

  const { sock, secure } = await openSocket(cfg);
  let session = new SmtpSession(sock);

  try {
    await session.cmd(null, [220]);
    await session.cmd(`EHLO loopcom.net`, [250]);

    if (!secure) {
      await session.cmd('STARTTLS', [220]);
      const tls = await session.upgrade(cfg.host);
      session = new SmtpSession(tls);
      await session.cmd(`EHLO loopcom.net`, [250]);
    }

    await session.cmd('AUTH LOGIN', [334]);
    await session.cmd(Buffer.from(cfg.user, 'utf8').toString('base64'), [334]);
    await session.cmd(Buffer.from(cfg.pass, 'utf8').toString('base64'), [235]);

    await session.cmd(`MAIL FROM:<${envelopeFrom}>`, [250]);
    await session.cmd(`RCPT TO:<${envelopeTo}>`, [250, 251]);
    await session.cmd('DATA', [354]);

    const boundary = 'lc_' + randomUUID().replace(/-/g, '');
    const lines = [
      `From: ${encodeHeader(fromHeader.replace(/<.*>/, '')).trim()} <${bareAddress(fromHeader)}>`,
      `To: <${envelopeTo}>`,
      `Subject: ${encodeHeader(subject)}`,
      replyTo ? `Reply-To: ${encodeHeader(replyTo.replace(/<.*>/, '')).trim()} <${bareAddress(replyTo)}>` : null,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@loopcom.net>`,
      'MIME-Version: 1.0',
      'Auto-Submitted: auto-generated',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(html || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      '',
      `--${boundary}--`,
      '',
    ].filter((l) => l !== null);

    // dot-stuffing: a line that is a single "." would end DATA early
    const body = lines.join('\r\n').replace(/\r\n\./g, '\r\n..');
    session.sock.write(body + '\r\n.\r\n');
    await session.cmd(null, [250]);

    await session.cmd('QUIT', [221]).catch(() => {});
    session.sock.end();
    return true;
  } catch (e) {
    try { session.sock.destroy(); } catch { /* already gone */ }
    throw e;
  }
}
