/** Shared building blocks. Pages compose these; they never hand-roll markup. */
import { esc } from './layout.mjs';

export const ICONS = {
  phone:'<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  msg:'<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 4 12a8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z"/>',
  dev:'<rect x="2" y="4" width="14" height="11" rx="2"/><path d="M2 19h20"/><rect x="17" y="9" width="5" height="10" rx="1.4"/>',
  desk:'<rect x="3" y="10" width="18" height="10" rx="2"/><path d="M7 10V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4M7 14h3M7 17h3"/>',
  route:'<path d="M4 4v6a3 3 0 0 0 3 3h10"/><circle cx="4" cy="4" r="2"/><path d="M20 20v-6a3 3 0 0 0-3-3"/><circle cx="20" cy="20" r="2"/>',
  vm:'<circle cx="6.5" cy="13" r="3.5"/><circle cx="17.5" cy="13" r="3.5"/><path d="M6.5 16.5h11"/>',
  vid:'<rect x="2" y="6" width="13" height="12" rx="2"/><path d="m22 8-7 4 7 4V8z"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  users:'<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/>',
  chart:'<path d="M3 3v18h18"/><path d="m7 15 4-5 3 3 5-7"/>',
  rec:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
  glob:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
  lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
};

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

export const icon = (p) => `<span class="ico" aria-hidden="true"><svg viewBox="0 0 24 24">${p}</svg></span>`;

export const card = (ic, title, body) =>
  `<div class="card">${icon(ic)}<h3>${title}</h3><p>${body}</p></div>`;

export const plainCard = (title, body) => `<div class="card"><h3>${title}</h3><p>${body}</p></div>`;

export const checks = (items) =>
  `<ul class="chk">${items.map((i) => `<li>${CHECK}<span>${i}</span></li>`).join('')}</ul>`;

export const sectionHead = (eyebrow, h2, p, center = false) =>
  `<div class="s-head${center ? ' center' : ''}">${eyebrow ? `<span class="eyebrow">${esc(eyebrow)}</span>` : ''}<h2>${h2}</h2>${p ? `<p>${p}</p>` : ''}</div>`;

export function breadcrumb(crumbs) {
  if (!crumbs || !crumbs.length) return '';
  const items = ['<li><a href="/">Home</a></li>']
    .concat(crumbs.map((c) => `<li>${c[1] ? `<a href="${c[1]}">${esc(c[0])}</a>` : esc(c[0])}</li>`));
  return `<div class="wrap"><nav class="bc" aria-label="Breadcrumb"><ol>${items.join('')}</ol></nav></div>`;
}

export const pageHead = (title, lede, crumbs) =>
  `${breadcrumb(crumbs)}<section class="ph"><div class="wrap"><div class="ph-in"><h1>${title}</h1><p class="lede">${lede}</p></div></div></section>`;

export const cta = (h = 'Ready for a phone system that keeps up?',
                    p = 'Tell us how your business runs and we will send you a written quote.') =>
  `<section><div class="wrap"><div class="cta"><h2>${h}</h2><p>${p}</p>
  <div class="acts"><a class="btn btn-lg btn-on-dark" href="/quote/">Request a Quote</a>
  <a class="btn btn-lg btn-ghost-dark" href="/business-phone/">See the phone system</a></div>
  </div></div></section>`;

const dots = '<span class="dot" style="background:#FF5F57"></span><span class="dot" style="background:#FEBC2E"></span><span class="dot" style="background:#28C840"></span>';

export const chrome = (url, inner) =>
  `<div class="chrome"><div class="chrome-bar">${dots}<span class="chrome-url">${esc(url)}</span></div>${inner}</div>`;

/** Product UI, reproduced from the portal's own tokens. Contains no customer data. */
export function appMock() {
  return chrome('app.loopcom.net/dashboard', `<div class="app">
  <div class="app-side">
    <div class="lbl">Workspace</div>
    <div class="it on"><i></i>Overview</div><div class="it"><i></i>Call history</div>
    <div class="it"><i></i>Voicemail</div><div class="it"><i></i>Messages</div>
    <div class="it"><i></i>Contacts</div><div class="it"><i></i>Meetings</div>
    <div class="lbl">Phone system</div>
    <div class="it"><i></i>Extensions</div><div class="it"><i></i>Auto attendant</div>
    <div class="it"><i></i>Queues</div><div class="it"><i></i>Desk phones</div>
  </div>
  <div class="app-main">
    <div class="app-h"><b>Overview</b><span class="badge">Today</span></div>
    <div class="kpis">
      <div class="kpi"><div class="k">Calls</div><div class="v">148</div><div class="d">&#9650; 12%</div></div>
      <div class="kpi"><div class="k">Answered</div><div class="v">94%</div><div class="d">&#9650; 3%</div></div>
      <div class="kpi"><div class="k">Avg answer</div><div class="v">6s</div><div class="d">&#9660; 2s</div></div>
      <div class="kpi"><div class="k">Voicemail</div><div class="v">3</div><div class="d" style="color:var(--ink-3)">unheard</div></div>
    </div>
    <div class="rows">
      <div class="row"><span class="av">RS</span><span class="nm">Reception</span><span class="mono">ext 101</span><span class="tag">On a call</span></div>
      <div class="row"><span class="av">DS</span><span class="nm">Dispatch</span><span class="mono">ext 104</span><span class="tag b">Available</span></div>
      <div class="row"><span class="av">SA</span><span class="nm">Sales queue</span><span class="mono">2 waiting</span><span class="tag g">Ring group</span></div>
      <div class="row"><span class="av">WH</span><span class="nm">Warehouse</span><span class="mono">ext 118</span><span class="tag g">Do not disturb</span></div>
    </div>
  </div>
</div>`);
}

export function menuMock() {
  return chrome('app.loopcom.net/auto-attendant', `<div style="padding:20px;background:var(--paper)">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <b style="font-family:var(--fd);font-size:15px">Main menu</b><span class="badge">Business hours</span></div>
  <div class="rows">
    <div class="row"><span class="mono" style="font-weight:600;color:var(--signal);min-width:16px">1</span><span class="nm">Sales</span><span class="tag b">Ring group</span></div>
    <div class="row"><span class="mono" style="font-weight:600;color:var(--signal);min-width:16px">2</span><span class="nm">Support</span><span class="tag b">Queue &middot; 4 agents</span></div>
    <div class="row"><span class="mono" style="font-weight:600;color:var(--signal);min-width:16px">3</span><span class="nm">Accounts</span><span class="tag g">Extension 106</span></div>
    <div class="row"><span class="mono" style="font-weight:600;color:var(--signal);min-width:16px">0</span><span class="nm">Reception</span><span class="tag g">Extension 101</span></div>
  </div></div>`);
}

export function callsMock() {
  return chrome('app.loopcom.net/calls', `<div style="padding:18px;background:var(--paper)"><div class="rows">
  <div class="row"><span class="av">&#8601;</span><span class="nm">(845) 555-0142</span><span class="mono">2m 14s</span><span class="tag">Answered &middot; ext 101</span></div>
  <div class="row"><span class="av">&#8599;</span><span class="nm">(917) 555-0188</span><span class="mono">6m 02s</span><span class="tag">Answered &middot; ext 104</span></div>
  <div class="row"><span class="av">&#8601;</span><span class="nm">(212) 555-0117</span><span class="mono">0m 48s</span><span class="tag b">Voicemail</span></div>
  <div class="row"><span class="av">&#8601;</span><span class="nm">(845) 555-0163</span><span class="mono">3m 31s</span><span class="tag">Answered &middot; Sales queue</span></div>
  <div class="row"><span class="av">&#8599;</span><span class="nm">(646) 555-0129</span><span class="mono">1m 07s</span><span class="tag g">No answer</span></div>
</div></div>`);
}

/**
 * Testimonials band. Renders NOTHING when there are no verified testimonials,
 * so an empty list leaves a complete, honest page rather than a gap.
 */
export function testimonials(items) {
  if (!items || !items.length) return '';
  const quote = (t) => `<figure class="tm">
  <svg class="tm-q" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H6a3 3 0 0 0-3 3v3h4v4H3v-4m14-6h-3a3 3 0 0 0-3 3v3h4v4h-4v-4"/></svg>
  <blockquote><p>${t.quote}</p></blockquote>
  <figcaption><b>${t.name}</b><span>${t.role}${t.company ? ', ' + t.company : ''}</span></figcaption>
</figure>`;
  return `<section class="s-mist"><div class="wrap">
  ${sectionHead('Customers', 'What businesses say.', '', true)}
  <div class="g g${Math.min(items.length, 3)}">${items.map(quote).join('')}</div>
</div></section>`;
}
