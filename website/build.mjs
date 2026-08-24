/**
 * Loopcom website build — zero dependencies.
 *
 *   node build.mjs            → writes dist/
 *   node build.mjs --check    → builds, then verifies the output
 *
 * Deliberately no framework: this site ships no JS bundle, so there is no
 * supply chain in the serving path and nothing to keep patched.
 */
import { mkdir, writeFile, rm, cp, readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE, COMPANY } from './src/site.mjs';
import { page } from './src/layout.mjs';
import * as M from './src/pages/marketing.mjs';
import * as P2 from './src/pages/product2.mjs';
import * as Q from './src/pages/quote.mjs';
import * as L from './src/pages/legal.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = join(ROOT, 'dist');
const PUBLIC = join(ROOT, 'public');

/** Every page, in sitemap order. */
const PAGES = [
  M.home, M.businessPhone, M.apps, M.deskPhones, M.messaging, P2.tenDlc,
  M.meetings, M.reporting, P2.custom, M.solutions, P2.e911, P2.security,
  M.about, M.support, M.contact, Q.quote,
  L.legalIndex, L.terms, L.privacy, L.aup, L.messagingTerms, L.cpni, L.accessibility,
  Q.quoteThanks, Q.notFound,
];

/** Pages that belong in the sitemap: indexable, real URLs. */
const indexable = (p) => !p.noindex && !p.url.endsWith('.html');

function outPath(url) {
  if (url.endsWith('.html')) return join(DIST, url.replace(/^\//, ''));
  return join(DIST, url.replace(/^\//, ''), 'index.html');
}

async function copyDir(src, dest) {
  await cp(src, dest, { recursive: true });
}

function sitemap() {
  const urls = PAGES.filter(indexable).map((p) => {
    // homepage highest, product pages next, legal lowest
    const pr = p.url === '/' ? '1.0' : p.url.startsWith('/legal/') ? '0.3' : '0.8';
    return `  <url><loc>${SITE.origin}${p.url}</loc><changefreq>monthly</changefreq><priority>${pr}</priority></url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function robots() {
  return `User-agent: *
Allow: /
Disallow: /quote/thank-you/

Sitemap: ${SITE.origin}/sitemap.xml
`;
}

function webmanifest() {
  return JSON.stringify({
    name: COMPANY.name,
    short_name: COMPANY.name,
    start_url: '/',
    display: 'browser',
    background_color: '#FFFFFF',
    theme_color: SITE.themeColor,
    icons: [
      { src: '/assets/img/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { src: '/assets/img/favicon-180.png', sizes: '180x180', type: 'image/png' },
      { src: '/assets/img/favicon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }, null, 2);
}

async function build() {
  if (existsSync(DIST)) await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await copyDir(PUBLIC, DIST);

  let n = 0;
  const seen = new Set();
  for (const p of PAGES) {
    if (seen.has(p.url)) throw new Error(`Duplicate page url: ${p.url}`);
    seen.add(p.url);
    if (!p.title || !p.description) throw new Error(`Page ${p.url} is missing a title or description`);
    if (p.description.length > 165) {
      console.warn(`  ! ${p.url} meta description is ${p.description.length} chars (>165)`);
    }
    const html = page(p);
    const out = outPath(p.url);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, html, 'utf8');
    n++;
  }

  await writeFile(join(DIST, 'sitemap.xml'), sitemap(), 'utf8');
  await writeFile(join(DIST, 'robots.txt'), robots(), 'utf8');
  await writeFile(join(DIST, 'site.webmanifest'), webmanifest(), 'utf8');

  console.log(`built ${n} pages -> dist/`);
  return n;
}

/* ------------------------------ verification ------------------------------ */
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

async function check() {
  const files = (await walk(DIST)).filter((f) => f.endsWith('.html'));
  const problems = [];
  const titles = new Map();

  // build the set of URLs that actually exist
  const have = new Set(['/404.html']);
  for (const p of PAGES) have.add(p.url);

  for (const f of files) {
    const html = await readFile(f, 'utf8');
    const rel = '/' + relative(DIST, f).replace(/\\/g, '/').replace(/index\.html$/, '');

    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const desc = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
    const canon = (html.match(/<link rel="canonical" href="([^"]*)"/) || [])[1] || '';
    const h1s = html.match(/<h1[\s>]/g) || [];

    if (!title) problems.push(`${rel}: no <title>`);
    if (!desc) problems.push(`${rel}: no meta description`);
    if (!canon) problems.push(`${rel}: no canonical`);
    if (h1s.length !== 1) problems.push(`${rel}: ${h1s.length} <h1> (want exactly 1)`);
    if (title) {
      if (titles.has(title)) problems.push(`${rel}: duplicate <title> shared with ${titles.get(title)}`);
      else titles.set(title, rel);
    }
    if (/<img(?![^>]*\balt=)/.test(html)) problems.push(`${rel}: an <img> has no alt attribute`);
    if (/http:\/\/(?!localhost)/.test(html)) problems.push(`${rel}: contains an insecure http:// URL`);

    // internal links must resolve to a page we generated
    const links = [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]);
    for (const href of links) {
      if (href.startsWith('/assets/') || href.startsWith('/api/')) continue;
      if (href === '/sitemap.xml' || href === '/robots.txt' || href === '/site.webmanifest') continue;
      if (!have.has(href)) problems.push(`${rel}: broken internal link -> ${href}`);
    }
  }

  console.log(`\nchecked ${files.length} html files`);
  if (problems.length) {
    console.log('PROBLEMS:');
    for (const p of problems) console.log('  - ' + p);
    process.exitCode = 1;
  } else {
    console.log('no problems found: titles, descriptions, canonicals, single H1, alt text, internal links all OK');
  }
}

const n = await build();
if (process.argv.includes('--check')) await check();
