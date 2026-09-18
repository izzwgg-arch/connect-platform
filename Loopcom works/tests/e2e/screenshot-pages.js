// Renders the running Works dev server headlessly and screenshots pages in both themes.
// usage: NODE_PATH=<works>\node_modules node shot-app.js [pages...]   (set MSYS_NO_PATHCONV=1 under Git Bash)
const puppeteer = require('puppeteer');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3001';
const OUT = process.env.OUT || 'C:/Users/izzyw/AppData/Local/Temp/claude/C--dev-projects-Connect-2/fbaca965-807e-413b-b922-09d341685a74/scratchpad/shots/';
const EMAIL = process.env.LW_EMAIL || 'admin@trimpro.com';
const PASSWORD = process.env.LW_PASSWORD || 'admin123';
const SETTLE = Number(process.env.SETTLE || 4000);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The dashboard keeps an SSE notification stream open, so "network idle" never
// happens; wait for DOM + a settle time instead.
async function open(p, url, sel) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 240000 });
  await p.waitForSelector(sel, { timeout: 240000 }).catch(() => {});
  await sleep(SETTLE);
}

(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Users/izzyw/.cache/puppeteer/chrome/win64-145.0.7632.76/chrome-win64/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 860, deviceScaleFactor: 1 });
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  const pages = process.argv.slice(2).length ? process.argv.slice(2) : ['/dashboard'];

  await open(p, BASE + '/auth/login', 'form');
  await p.screenshot({ path: OUT + 'login-light.png' });
  await p.evaluate(() => { try { localStorage.setItem('lw-theme', 'dark'); } catch (e) {} });
  await open(p, BASE + '/auth/login', 'form');
  await p.screenshot({ path: OUT + 'login-dark.png' });
  await p.evaluate(() => { try { localStorage.setItem('lw-theme', 'light'); } catch (e) {} });

  // programmatic login (seeded local dev account) — the same request the form sends
  const res = await p.evaluate(async (email, password) => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, clientType: 'web' }) });
    const j = await r.json();
    if (!r.ok) return { ok: false, status: r.status, j };
    localStorage.setItem('accessToken', j.accessToken); localStorage.setItem('refreshToken', j.refreshToken); localStorage.setItem('user', JSON.stringify(j.user));
    return { ok: true };
  }, EMAIL, PASSWORD);
  console.log('login', JSON.stringify(res));
  if (!res.ok) { await b.close(); process.exit(1); }

  for (const theme of ['light', 'dark']) {
    await p.evaluate((t) => { try { localStorage.setItem('lw-theme', t); } catch (e) {} }, theme);
    for (const path of pages) {
      const name = path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
      try {
        await open(p, BASE + path, 'main');
        await p.screenshot({ path: `${OUT}${name}-${theme}.png`, fullPage: false });
        const txt = await p.evaluate(() => document.body.innerText.slice(0, 200).replace(/\s+/g, ' '));
        console.log(theme, path, '->', txt.slice(0, 90));
      } catch (e) { console.log('ERR', theme, path, e.message.slice(0, 120)); }
    }
  }
  console.log('errors:', errs.length ? errs.slice(0, 15).join('\n') : 'none');
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
