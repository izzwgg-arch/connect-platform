// LoopCom Works — reskin regression click-through (puppeteer).
// Proves the UI still WORKS after the looks-only pass: real form login, every sidebar
// link, create/edit a client through the real forms, open estimate/invoice/job/PO
// detail + PDF, theme + sidebar toggles persist, global search, logout.
// usage: NODE_PATH=<works>\node_modules node e2e-clicks.js   (env BASE, ITER)
const puppeteer = require('puppeteer');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:3002';
const ITER = Number(process.env.ITER || 1);
const OUT = process.env.OUT || 'C:/Users/izzyw/AppData/Local/Temp/claude/C--dev-projects-Connect-2/fbaca965-807e-413b-b922-09d341685a74/scratchpad/e2e/';
const EMAIL = 'admin@trimpro.com', PASSWORD = 'admin123';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
function rec(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); }

async function open(p, url, sel = 'main, form, h1') {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await p.waitForSelector(sel, { timeout: 120000 }).catch(() => {});
  await sleep(1200);
}
async function noAppError(p) {
  const t = await p.evaluate(() => document.body.innerText);
  return !/Application error|Unhandled Runtime Error|Internal Server Error/i.test(t);
}
async function clickByText(p, text, tag = 'button') {
  const h = await p.evaluateHandle((t, tag) => {
    const els = [...document.querySelectorAll(tag + ', a, [role=button]')];
    return els.find(e => (e.innerText || '').trim().toLowerCase() === t.toLowerCase() && !e.disabled) || null;
  }, text, tag);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  return true;
}
async function typeInto(p, sel, text) {
  await p.waitForSelector(sel, { timeout: 30000 });
  await p.click(sel, { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.type(sel, text, { delay: 5 });
}

(async () => {
  const b = await puppeteer.launch({ executablePath: 'C:/Users/izzyw/.cache/puppeteer/chrome/win64-145.0.7632.76/chrome-win64/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1366, height: 860 });
  const pageErrors = [];
  p.on('pageerror', e => pageErrors.push(e.message));

  for (let it = 1; it <= ITER; it++) {
    console.log(`\n=== iteration ${it}/${ITER} ===`);
    // 1. Real form login
    await open(p, BASE + '/auth/login', 'form');
    await p.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
    await open(p, BASE + '/auth/login', 'form');
    await typeInto(p, '#email', EMAIL);
    await typeInto(p, '#password', PASSWORD);
    await Promise.all([
      p.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {}),
      p.click('button[type=submit]'),
    ]);
    await p.waitForFunction(() => location.pathname.startsWith('/dashboard'), { timeout: 120000 }).catch(() => {});
    rec('login via form → /dashboard', p.url().includes('/dashboard'), p.url());
    await p.waitForSelector('main', { timeout: 120000 }).catch(() => {});
    await sleep(2500);
    rec('dashboard renders without app error', await noAppError(p));
    if (it === 1) await p.screenshot({ path: OUT + 'dashboard.png' });

    // 2. Every sidebar link
    const links = await p.$$eval('aside nav a[href], nav a[href^="/dashboard"]', as => [...new Set(as.map(a => a.getAttribute('href')))].filter(h => h && h.startsWith('/dashboard')));
    rec('sidebar has links', links.length >= 20, `${links.length} links`);
    for (const href of links) {
      try {
        const before = pageErrors.length;
        await open(p, BASE + href);
        const ok = await noAppError(p);
        const hasContent = await p.evaluate(() => document.querySelector('main')?.innerText.trim().length > 20);
        rec(`nav ${href}`, ok && hasContent && pageErrors.length === before, ok ? (hasContent ? '' : 'empty main') : 'app error');
        if (it === 1) await p.screenshot({ path: OUT + 'nav' + href.replace(/[^a-z0-9]+/gi, '_') + '.png' });
      } catch (e) { rec(`nav ${href}`, false, e.message.slice(0, 100)); }
    }

    // 3. Create a client through the real form
    const cname = `E2E Client ${Date.now()}`;
    await open(p, BASE + '/dashboard/clients/new', 'form, #name');
    await typeInto(p, '#name', cname);
    await typeInto(p, '#companyName', 'E2E Millwork LLC');
    await typeInto(p, '#email', `e2e${Date.now()}@example.com`);
    await typeInto(p, '#phone', '(555) 010-2030');
    await Promise.all([
      p.waitForFunction(() => /\/dashboard\/clients\/[a-z0-9]+$/.test(location.pathname), { timeout: 120000 }).catch(() => {}),
      p.click('button[type=submit]'),
    ]);
    await sleep(2000);
    const onDetail = /\/dashboard\/clients\/[a-z0-9]+$/.test(p.url());
    const shows = onDetail && (await p.evaluate(() => document.body.innerText)).includes(cname);
    rec('create client → detail shows name', shows, p.url());
    const clientUrl = p.url();

    // 4. Edit the client and verify after reload
    if (onDetail) {
      await open(p, clientUrl + '/edit', '#name');
      await typeInto(p, '#companyName', 'E2E Millwork LLC (edited)');
      await Promise.all([
        p.waitForFunction((u) => location.href.startsWith(u) && !location.pathname.endsWith('/edit'), { timeout: 120000 }, clientUrl).catch(() => {}),
        p.click('button[type=submit]'),
      ]);
      await sleep(1500);
      await open(p, clientUrl);
      const edited = (await p.evaluate(() => document.body.innerText)).includes('E2E Millwork LLC (edited)');
      rec('edit client → reload shows edit', edited);
    }

    // 5. Detail pages + PDF endpoints via the app's own token
    const token = await p.evaluate(() => localStorage.getItem('accessToken'));
    const ids = await p.evaluate(async (t) => {
      const h = { Authorization: 'Bearer ' + t };
      const g = async (u) => { const r = await fetch(u, { headers: h }); return r.ok ? r.json() : null; };
      const est = await g('/api/estimates?limit=1'); const inv = await g('/api/invoices?limit=1'); const po = await g('/api/purchase-orders?limit=1'); const job = await g('/api/jobs?limit=1');
      const pick = (o, k) => (o && (o[k] || o.data || o.items || [])[0]) || null;
      return { estimate: pick(est, 'estimates')?.id, invoice: pick(inv, 'invoices')?.id, po: pick(po, 'purchaseOrders')?.id, job: pick(job, 'jobs')?.id };
    }, token);
    for (const [kind, id] of Object.entries(ids)) {
      if (!id) { rec(`${kind} detail`, false, 'no record id from list API'); continue; }
      const path = { estimate: '/dashboard/estimates/', invoice: '/dashboard/invoices/', po: '/dashboard/purchase-orders/', job: '/dashboard/jobs/' }[kind] + id;
      await open(p, BASE + path);
      await sleep(1500);
      rec(`${kind} detail renders`, await noAppError(p) && (await p.evaluate(() => document.querySelector('main')?.innerText.length > 50)));
      if (it === 1) await p.screenshot({ path: OUT + kind + '-detail.png' });
      if (kind !== 'job') {
        const api = { estimate: '/api/estimates/', invoice: '/api/invoices/', po: '/api/purchase-orders/' }[kind] + id + '/pdf';
        const r = await p.evaluate(async (u, t) => { const r = await fetch(u, { headers: { Authorization: 'Bearer ' + t } }); const buf = await r.arrayBuffer(); const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 5))); return { status: r.status, type: r.headers.get('content-type'), head, size: buf.byteLength }; }, api, token);
        rec(`${kind} PDF`, r.status === 200 && r.head === '%PDF-', `${r.status} ${r.type} ${r.size}B`);
      }
    }

    // 6. Theme toggle persists across reload
    await open(p, BASE + '/dashboard');
    const clickedTheme = await p.evaluate(() => { const b = document.querySelector('button[aria-label="Switch to dark mode"]'); if (b) { b.click(); return true; } return false; });
    await sleep(500);
    const darkNow = await p.evaluate(() => document.documentElement.classList.contains('dark'));
    await open(p, BASE + '/dashboard');
    const darkAfter = await p.evaluate(() => document.documentElement.classList.contains('dark'));
    rec('theme toggle → dark persists after reload', clickedTheme && darkNow && darkAfter);
    if (it === 1) await p.screenshot({ path: OUT + 'dashboard-dark.png' });
    await p.evaluate(() => { const b = document.querySelector('button[aria-label="Switch to light mode"]'); b && b.click(); });
    await sleep(300);

    // 7. Sidebar collapse persists
    await p.evaluate(() => { const b = document.querySelector('button[aria-label="Collapse sidebar"]'); b && b.click(); });
    await sleep(400);
    const railWidth = await p.evaluate(() => document.querySelector('aside')?.getBoundingClientRect().width || document.querySelector('.lw-sidebar')?.getBoundingClientRect().width);
    await open(p, BASE + '/dashboard');
    const railAfter = await p.evaluate(() => document.querySelector('.lw-sidebar')?.getBoundingClientRect().width);
    rec('sidebar collapse → rail persists after reload', railWidth < 100 && railAfter < 100, `${railWidth}/${railAfter}px`);
    await p.evaluate(() => { const b = document.querySelector('button[aria-label="Expand sidebar"]'); b && b.click(); });
    await sleep(300);

    // 8. Global search returns results
    await p.click('input[placeholder*="Search"]').catch(() => {});
    await p.keyboard.type('E2E', { delay: 20 });
    await sleep(2500);
    const hits = await p.evaluate(() => document.body.innerText.includes('E2E Millwork'));
    rec('global search finds the new client', hits);

    // 9. Logout
    const loggedOut = await clickByText(p, 'Logout');
    await p.waitForFunction(() => location.pathname.startsWith('/auth/login'), { timeout: 60000 }).catch(() => {});
    const tokenGone = await p.evaluate(() => !localStorage.getItem('accessToken'));
    rec('logout → login page, token cleared', loggedOut && p.url().includes('/auth/login') && tokenGone, p.url());
  }

  const pass = results.filter(r => r.ok).length, fail = results.length - pass;
  console.log(`\nTOTAL ${pass} pass / ${fail} fail; page errors: ${pageErrors.length}`);
  if (pageErrors.length) console.log(pageErrors.slice(0, 10).join('\n'));
  fs.writeFileSync(OUT + 'results.json', JSON.stringify({ results, pageErrors }, null, 1));
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
