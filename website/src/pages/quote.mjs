import { COMPANY, QUOTE_OPTIONS as Q, FORM_ENDPOINT } from '../site.mjs';
import { pageHead } from '../ui.mjs';
import { esc } from '../layout.mjs';

const sel = (id, label, opts, req) =>
  `<div class="fld"><label for="${id}">${label}${req ? '<span class="req" aria-hidden="true">*</span>' : ''}</label>
   <select id="${id}" name="${id}"${req ? ' required' : ''}>
   ${opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
   </select><span class="err" id="${id}-err"></span></div>`;

const optGrid = (name, items) =>
  `<div class="opts">${items.map(([v, t, s]) =>
    `<label class="opt"><input type="checkbox" name="${name}" value="${esc(v)}">
     <span class="t">${esc(t)}<small>${esc(s)}</small></span></label>`).join('')}</div>`;

export const quote = {
  url: '/quote/',
  title: 'Request a Quote',
  description:
    'Tell us about your business and how you use the phone. We reply with a written quote covering service, numbers, handsets and setup. No account is created.',
  crumbs: [['Request a quote', null]],
  body: `
${pageHead('Request a quote',
  'Tell us about your business and how you use the phone. We will send a written quote covering everything &mdash; service, numbers, handsets and setup.',
  [['Request a quote', null]])}

<section><div class="wrap"><div class="qf">
<form id="quote-form" method="post" action="${FORM_ENDPOINT}" novalidate>

  <!-- spam trap: real people never fill this, it is off-screen and not focusable -->
  <div class="hp" aria-hidden="true">
    <label for="website_url">Leave this field empty</label>
    <input type="text" id="website_url" name="website_url" tabindex="-1" autocomplete="off">
  </div>
  <input type="hidden" name="form_started" id="form_started" value="">

  <fieldset class="fset">
    <legend><span class="n">01</span> Your business</legend>
    <p class="hint">Enough for us to size the system properly.</p>
    <div class="frow">
      <div class="fld"><label for="business_name">Business name<span class="req" aria-hidden="true">*</span></label>
        <input type="text" id="business_name" name="business_name" autocomplete="organization" required maxlength="120">
        <span class="err" id="business_name-err"></span></div>
      ${sel('industry', 'Industry', Q.industries, false)}
    </div>
    <div class="frow">
      ${sel('seats', 'People who need a phone', Q.seatBands, true)}
      ${sel('locations', 'Locations', Q.locationBands, false)}
    </div>
  </fieldset>

  <fieldset class="fset">
    <legend><span class="n">02</span> How you use your phones</legend>
    <p class="hint">Tell us what you have today and where your calls need to go.</p>
    <div class="frow">
      <div class="fld"><label for="current_provider">Current phone provider</label>
        <input type="text" id="current_provider" name="current_provider" maxlength="120" placeholder="Who provides your service today?"></div>
      ${sel('porting', 'Do you want to keep your numbers?', Q.portingChoices, false)}
    </div>
    <div class="fld"><label id="devices-label">Where do your team need to answer?</label>
      <div role="group" aria-labelledby="devices-label" style="margin-top:4px">${optGrid('devices', Q.devices)}</div>
    </div>
  </fieldset>

  <fieldset class="fset">
    <legend><span class="n">03</span> What you are looking for</legend>
    <p class="hint">Pick anything that matters to you. We will cover it in the quote.</p>
    <div role="group" aria-label="Features you are interested in">${optGrid('interests', Q.interests)}</div>
    <div class="fld" style="margin-top:20px"><label for="notes">Anything else we should know?</label>
      <textarea id="notes" name="notes" maxlength="4000" placeholder="Tell us how calls are handled today, what is not working, or anything specific you need."></textarea></div>
  </fieldset>

  <fieldset class="fset">
    <legend><span class="n">04</span> Where to send it</legend>
    <div class="frow">
      <div class="fld"><label for="contact_name">Your name<span class="req" aria-hidden="true">*</span></label>
        <input type="text" id="contact_name" name="contact_name" autocomplete="name" required maxlength="120">
        <span class="err" id="contact_name-err"></span></div>
      <div class="fld"><label for="email">Email<span class="req" aria-hidden="true">*</span></label>
        <input type="email" id="email" name="email" autocomplete="email" required maxlength="180" inputmode="email">
        <span class="help">We send your quote here.</span>
        <span class="err" id="email-err"></span></div>
    </div>
    <div class="fld" style="max-width:330px"><label for="phone">Phone number<span class="req" aria-hidden="true">*</span></label>
      <input type="tel" id="phone" name="phone" autocomplete="tel" required maxlength="30" inputmode="tel">
      <span class="err" id="phone-err"></span></div>

    <div class="chks" style="margin-top:22px">
      <div class="chkr">
        <input type="checkbox" id="consent_reply" name="consent_reply" value="yes" required>
        <label for="consent_reply" class="t"><b>Required</b>I agree that Loopcom may use these details to prepare and send my quote and to contact me about this request.</label>
      </div>
      <div class="chkr">
        <input type="checkbox" id="consent_sms" name="consent_sms" value="yes">
        <label for="consent_sms" class="t"><b>Optional</b>Loopcom may text me about this quote at the number above. Message and data rates may apply. Reply STOP to opt out. Consent is not a condition of purchase.</label>
      </div>
    </div>
    <span class="err" id="consent_reply-err" style="margin-top:8px"></span>
  </fieldset>

  <div class="form-foot">
    <p style="font-size:13.4px;color:var(--ink-3);max-width:330px">No account is created and we never ask for payment details.</p>
    <button class="btn btn-pri btn-lg" type="submit" id="quote-submit">Send my request</button>
  </div>
  <div class="form-status" id="quote-status" role="status" aria-live="polite"></div>

  <noscript><p class="note" style="margin-top:20px">This form works without JavaScript. Your details are checked on our server when you submit.</p></noscript>
</form>
</div></div></section>`,
};

export const quoteThanks = {
  url: '/quote/thank-you/',
  title: 'Thank you — your request is with us',
  description: 'Your quote request has been received by Loopcom.',
  noindex: true,
  crumbs: [['Request a quote', '/quote/'], ['Thank you', null]],
  body: `
${pageHead('Thank you &mdash; we have your request.',
  'A member of the Loopcom team will reply by email, usually the same business day.',
  [['Request a quote', '/quote/'], ['Thank you', null]])}
<section><div class="wrap" style="max-width:680px">
  <div class="note"><b>What happens next.</b> We read what you sent, put together a written quote covering service, numbers, handsets and setup, and email it to the address you gave us. If anything is unclear we will ask before quoting rather than guess.</div>
  <p style="margin-top:24px">If it is urgent, call us on <a class="tlink" href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a>.</p>
  <div style="margin-top:30px"><a class="btn btn-pri" href="/">Back to the homepage</a></div>
</div></section>`,
};

export const notFound = {
  url: '/404.html',
  title: 'Page not found',
  description: 'That page could not be found.',
  noindex: true,
  body: `
<section style="padding:110px 0"><div class="wrap" style="text-align:center;max-width:560px">
  <p class="num" style="font-family:var(--fd);font-size:80px;font-weight:800;color:var(--line-2);line-height:1">404</p>
  <h1 style="font-size:33px;margin:10px 0 14px">We could not find that page.</h1>
  <p class="lede" style="margin-bottom:30px">It may have moved, or the link may be wrong. These are the places people usually want.</p>
  <div style="display:flex;gap:11px;justify-content:center;flex-wrap:wrap">
    <a class="btn btn-pri" href="/">Home</a>
    <a class="btn btn-quiet" href="/business-phone/">Phone system</a>
    <a class="btn btn-quiet" href="/support/">Support</a>
    <a class="btn btn-quiet" href="/quote/">Request a Quote</a>
  </div>
</div></section>`,
};
