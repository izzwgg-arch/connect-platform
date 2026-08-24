/**
 * Page shell: <head>, navigation, footer, chat assistant.
 * Everything SEO-related is generated here so no page can forget it.
 */
import { COMPANY, SITE, NAV, FOOTER, CHAT_ENDPOINT, TURNSTILE_SITE_KEY } from './site.mjs';

/**
 * The Cloudflare Turnstile widget.
 *
 * ⛔ Turnstile writes its token into a hidden input named
 * "cf-turnstile-response" INSIDE THE ENCLOSING <form>. Both of our forms are
 * submitted with new FormData(form), so the token travels automatically — do
 * not "helpfully" append it by hand as well, or the server sees two values.
 *
 * ⛔ appearance="interaction-only" renders NOTHING unless a challenge is
 * genuinely required. It is used in the chat panel, where a permanent widget
 * would dominate a small surface. The quote form shows the widget, because on
 * a form a business buyer is about to hand real details to, visible evidence
 * that the submission is protected is worth the space it costs.
 *
 * ⛔ refresh-expired="auto" matters here: a Turnstile token dies after five
 * minutes, and the quote form is long enough that a careful person will take
 * longer than that. Without it their submission is refused for a reason that
 * has nothing to do with anything they did.
 */
export function turnstileWidget(action, appearance) {
  if (!TURNSTILE_SITE_KEY) return '';
  return `<div class="cf-turnstile" data-sitekey="${TURNSTILE_SITE_KEY}" data-action="${action}"` +
    ` data-appearance="${appearance || 'always'}" data-refresh-expired="auto" data-theme="light"></div>`;
}

export const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LOGO_IMG =
  '<img src="/assets/img/loopcom-wordmark-80.png" ' +
  'srcset="/assets/img/loopcom-wordmark-80.png 1x, /assets/img/loopcom-wordmark-160.png 2x" ' +
  'width="152" height="27" alt="Loopcom">';

const FOOTER_LOGO_IMG =
  '<img src="/assets/img/loopcom-wordmark-160.png" width="169" height="30" alt="Loopcom">';

/** Organization + WebSite JSON-LD. ⛔ Only facts verified against public records. */
function orgJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': SITE.origin + '/#organization',
        name: COMPANY.name,
        legalName: COMPANY.legalName,
        url: SITE.origin + '/',
        logo: SITE.origin + '/assets/img/loopcom-wordmark-160.png',
        telephone: COMPANY.phoneE164,
        email: COMPANY.quoteEmail,
        address: {
          '@type': 'PostalAddress',
          streetAddress: COMPANY.addressLines[0],
          addressLocality: COMPANY.locality,
          addressRegion: COMPANY.region,
          postalCode: COMPANY.postalCode,
          addressCountry: COMPANY.country,
        },
        contactPoint: [{
          '@type': 'ContactPoint',
          telephone: COMPANY.phoneE164,
          email: COMPANY.quoteEmail,
          contactType: 'sales',
          areaServed: 'US',
          availableLanguage: 'English',
        }],
      },
      {
        '@type': 'WebSite',
        '@id': SITE.origin + '/#website',
        url: SITE.origin + '/',
        name: COMPANY.name,
        publisher: { '@id': SITE.origin + '/#organization' },
        inLanguage: 'en-US',
      },
    ],
  });
}

function breadcrumbJsonLd(crumbs, url) {
  if (!crumbs || !crumbs.length) return null;
  const items = [{ name: 'Home', item: SITE.origin + '/' }];
  crumbs.forEach((c) => items.push({ name: c[0], item: c[1] ? SITE.origin + c[1] : SITE.origin + url }));
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem', position: i + 1, name: it.name, item: it.item,
    })),
  });
}

function nav(currentUrl) {
  const links = NAV.map((n) => {
    const cur = currentUrl === n.href ? ' aria-current="page"' : '';
    return `<a href="${n.href}"${cur}>${esc(n.label)}</a>`;
  }).join('');

  const mobileLinks = NAV.map((n) => `<li><a href="${n.href}">${esc(n.label)}</a></li>`).join('');

  return `<header class="nav">
  <div class="nav-in">
    <a class="logo" href="/" aria-label="Loopcom home">${LOGO_IMG}</a>
    <nav class="nav-links" aria-label="Main">${links}</nav>
    <div class="nav-cta">
      <a class="btn btn-quiet" href="/contact/">Contact</a>
      <a class="btn btn-pri" href="/quote/">Request a Quote</a>
      <button class="burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-menu">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
    </div>
  </div>
  <div class="mobile-menu" id="mobile-menu" data-open="false">
    <ul>${mobileLinks}</ul>
    <div class="m-cta">
      <a class="btn btn-pri btn-lg" href="/quote/">Request a Quote</a>
      <a class="btn btn-quiet btn-lg" href="/contact/">Contact</a>
    </div>
  </div>
</header>`;
}

function footer() {
  const cols = FOOTER.map((c) =>
    `<div><h4>${esc(c.heading)}</h4><ul>${
      c.links.map((l) => `<li><a href="${l[1]}">${esc(l[0])}</a></li>`).join('')
    }</ul></div>`).join('');

  return `<footer class="ft">
  <div class="wrap">
    <div class="ft-g">
      <div>
        <div class="ft-lo">${FOOTER_LOGO_IMG}</div>
        <p class="ft-co">Business phone, messaging and video for companies across the United States.</p>
        <p class="ft-reg">${esc(COMPANY.legalName)}<br>${COMPANY.addressLines.map(esc).join('<br>')}<br>
          <a href="tel:${COMPANY.phoneE164}">${esc(COMPANY.phoneDisplay)}</a></p>
      </div>
      ${cols}
    </div>
    <div class="ft-bot">
      <div>&copy; ${COMPANY.foundedYear} ${esc(COMPANY.legalName)}. All rights reserved.</div>
      <div><a href="/legal/terms/">Terms</a> &middot; <a href="/legal/privacy/">Privacy</a> &middot; <a href="/e911/">Emergency calling</a></div>
    </div>
  </div>
</footer>`;
}

/**
 * Chat assistant.
 * ⛔ It is a MESSAGE RELAY, not an AI that answers. It never claims to be one.
 * Anything typed here is emailed to the same address the quote form uses.
 */
function chat() {
  return `<button class="chat-btn" type="button" id="chat-btn" aria-expanded="false" aria-controls="chat-panel" aria-label="Open chat">
  <svg class="b" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0 1 4 12a8.4 8.4 0 0 1 8.4-8.4h.5A8.4 8.4 0 0 1 21 11.5z"/></svg>
  <svg class="x" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
</button>
<div class="chat-panel" id="chat-panel" data-open="false" role="dialog" aria-modal="false" aria-label="Message Loopcom">
  <div class="chat-head">
    <b>Message Loopcom</b>
    <span>We reply by email, usually the same business day.</span>
  </div>
  <div class="chat-log" id="chat-log" role="log" aria-live="polite">
    <div class="msg msg-bot">Hello. Tell us what you need and it goes straight to our team &mdash; pricing, support, or anything else.</div>
  </div>
  <div class="chat-quick" id="chat-quick">
    <button type="button" data-q="I would like a quote for a business phone system.">Get a quote</button>
    <button type="button" data-q="I am an existing customer and need support with:">Support</button>
    <button type="button" data-q="I have a question about moving our numbers to Loopcom.">Moving numbers</button>
    <button type="button" data-q="I am interested in a custom system built for our business.">Custom build</button>
  </div>
  <form class="chat-form" id="chat-form" novalidate>
    <label class="hp" for="chat-company">Company (leave blank)</label>
    <input class="hp" type="text" id="chat-company" name="company" tabindex="-1" autocomplete="off">
    <textarea id="chat-message" name="message" placeholder="Type your message&hellip;" required aria-label="Your message"></textarea>
    <input type="email" id="chat-email" name="email" placeholder="Your email, so we can reply" required aria-label="Your email address" autocomplete="email">
    ${turnstileWidget('chat', 'interaction-only')}
    <div class="chat-send">
      <button class="btn btn-pri" type="submit">Send message</button>
    </div>
    <p class="chat-note" id="chat-note">We use your email only to reply to this message.</p>
  </form>
</div>`;
}

/**
 * Render a full page.
 * @param {{url:string,title:string,description:string,body:string,
 *          crumbs?:Array,extraJsonLd?:string,noindex?:boolean}} p
 */
export function page(p) {
  const canonical = SITE.origin + p.url;
  const title = p.title.endsWith(SITE.titleSuffix) ? p.title : p.title + SITE.titleSuffix;
  const bc = breadcrumbJsonLd(p.crumbs, p.url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(p.description)}">
<link rel="canonical" href="${canonical}">
${p.noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large">'}
<meta name="theme-color" content="${SITE.themeColor}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(COMPANY.name)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE.origin}${SITE.ogImage}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:locale" content="${SITE.locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(p.description)}">
<meta name="twitter:image" content="${SITE.origin}${SITE.ogImage}">
<link rel="icon" href="/assets/img/favicon.ico" sizes="any">
<link rel="icon" href="/assets/img/favicon-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/assets/img/favicon-180.png">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/css/site.css">
<script type="application/ld+json">${orgJsonLd()}</script>
${bc ? `<script type="application/ld+json">${bc}</script>` : ''}
${p.extraJsonLd ? `<script type="application/ld+json">${p.extraJsonLd}</script>` : ''}
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
${nav(p.url)}
<main id="main">
${p.body}
</main>
${footer()}
${chat()}
${TURNSTILE_SITE_KEY ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
<script src="/assets/js/site.js" defer></script>
</body>
</html>`;
}
