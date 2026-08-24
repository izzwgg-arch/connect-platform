import { COMPANY, LEGAL_EFFECTIVE, LEGAL_VERSION } from '../site.mjs';
import { pageHead, plainCard } from '../ui.mjs';
import { esc } from '../layout.mjs';

const E = COMPANY.supportEmail;
const ADDR = COMPANY.addressOneLine;
const LEGAL = COMPANY.legalName;

/** Build a legal document page with an auto-numbered ToC. */
function legalDoc({ url, title, seoTitle, description, lede, sections }) {
  const body = sections.map((s, i) => `<h2 id="s${i + 1}">${i + 1}. ${esc(s[0])}</h2>${s[1]}`).join('');
  const toc = sections.map((s, i) => `<li><a href="#s${i + 1}">${esc(s[0])}</a></li>`).join('');
  return {
    url,
    title: seoTitle || title,
    description,
    crumbs: [['Legal', '/legal/'], [title, null]],
    body: `
${pageHead(esc(title), lede, [['Legal', '/legal/'], [title, null]])}
<section><div class="wrap"><div class="split legal-split" style="grid-template-columns:1fr 250px;align-items:start;gap:48px">
  <div class="legal-body">
    <div class="legal-meta">
      <div><b>Effective</b>${esc(LEGAL_EFFECTIVE)}</div>
      <div><b>Last updated</b>${esc(LEGAL_EFFECTIVE)}</div>
      <div><b>Version</b>${esc(LEGAL_VERSION)}</div>
    </div>
    ${body}
  </div>
  <nav class="toc" aria-label="On this page"><h4>On this page</h4><ol>${toc}</ol></nav>
</div></div></section>`,
  };
}

export const legalIndex = {
  url: '/legal/',
  title: 'Legal & Compliance',
  description:
    'Loopcom terms of service, privacy policy, acceptable use policy, emergency calling policy, messaging terms, CPNI notice and accessibility statement.',
  crumbs: [['Legal', null]],
  body: `
${pageHead('Legal', 'Our terms, policies and the notices that apply to telephone service.', [['Legal', null]])}
<section><div class="wrap"><div class="g g2">
  <div class="card"><h3><a href="/legal/terms/">Terms of service &rarr;</a></h3><p>The agreement between your business and Loopcom.</p></div>
  <div class="card"><h3><a href="/legal/privacy/">Privacy policy &rarr;</a></h3><p>What we collect, why, how long we keep it and who we share it with.</p></div>
  <div class="card"><h3><a href="/legal/acceptable-use/">Acceptable use policy &rarr;</a></h3><p>What the service may and may not be used for.</p></div>
  <div class="card"><h3><a href="/e911/">Emergency calling &rarr;</a></h3><p>How 911 works and your responsibility for the registered address.</p></div>
  <div class="card"><h3><a href="/legal/messaging/">Messaging terms &rarr;</a></h3><p>Terms for texting, consent and opt-out handling.</p></div>
  <div class="card"><h3><a href="/legal/cpni/">CPNI notice &rarr;</a></h3><p>How we protect information about your calling.</p></div>
  <div class="card"><h3><a href="/legal/accessibility/">Accessibility &rarr;</a></h3><p>Our approach and how to report a barrier.</p></div>
</div></div></section>`,
};

export const terms = legalDoc({
  url: '/legal/terms/',
  title: 'Terms of Service',
  seoTitle: 'Terms of Service',
  description: `The agreement between your business and ${LEGAL} for telephone, messaging and related communications services.`,
  lede: `The agreement between your business and ${LEGAL} for telephone, messaging and related services.`,
  sections: [
    ['Parties', `<p>These terms are an agreement between ${LEGAL}, with its principal place of business at ${ADDR} (&ldquo;Loopcom&rdquo;, &ldquo;we&rdquo;), and the business that subscribes to the service (&ldquo;you&rdquo;). They apply from the date service begins.</p>`],
    ['The service', '<p>Loopcom provides interconnected voice over IP telephone service, business messaging, video meetings and related software to businesses. It is not offered as a residential telephone service.</p>'],
    ['Emergency calling', '<p>911 calling on Loopcom differs materially from traditional telephone service and depends on your internet connection and electrical power. You must keep your registered address current and inform everyone who uses the service of these limitations. Full details are in the <a href="/e911/">Emergency Calling policy</a>, which forms part of these terms.</p>'],
    ['Your responsibilities', '<p>You are responsible for use of the service on your account, including by your staff. That includes obtaining any consent required before calling or messaging, honouring opt-out requests, keeping credentials secure, and providing accurate information for regulatory registrations.</p>'],
    ['Acceptable use', '<p>Use of the service is subject to the <a href="/legal/acceptable-use/">Acceptable Use Policy</a>. We may suspend service where use presents a risk of harm, fraud or regulatory breach, and will tell you why.</p>'],
    ['Messaging', '<p>Messaging is additionally subject to the <a href="/legal/messaging/">Messaging Terms</a>, including registration requirements imposed by mobile carriers.</p>'],
    ['Numbers', '<p>Telephone numbers assigned to you are subject to numbering rules and are not property. You may transfer numbers away in accordance with applicable rules and we will not obstruct a valid request.</p>'],
    ['Charges and payment', '<p>Charges, the billing period and payment terms are set out in your quote and order, together with applicable taxes, fees and regulatory surcharges.</p>'],
    ['Service availability', '<p>We aim to provide continuous service but do not warrant uninterrupted or error-free operation. The service depends on your internet connection, your power supply and networks operated by third parties. Any committed service level applies only where stated in writing in your order.</p>'],
    ['Suspension and termination', '<p>Either party may terminate in accordance with the term stated in your order. We may suspend service for non-payment, for use in breach of these terms, or where required by law or a regulator.</p>'],
    ['Liability', '<p>Nothing in these terms excludes liability that cannot lawfully be excluded. Subject to that, the limitations set out in your order apply.</p>'],
    ['Changes', '<p>We may update these terms. Material changes will be notified in advance and the effective date above updated. Previous versions are retained and available on request.</p>'],
    ['Governing law and contact', `<p>These terms are governed by the law stated in your order. Questions may be sent to <a href="mailto:${E}">${E}</a> or by post to the address above.</p>`],
  ],
});

export const privacy = legalDoc({
  url: '/legal/privacy/',
  title: 'Privacy Policy',
  description: 'What information Loopcom collects, why, how long we keep it and the choices you have.',
  lede: 'What information Loopcom collects, why, how long we keep it and the choices you have.',
  sections: [
    ['Who we are', `<p>${LEGAL}, ${ADDR}. Questions about this policy may be sent to <a href="mailto:${E}">${E}</a>.</p>`],
    ['Information we collect', '<p>Account and contact details for your business and its users; information you provide when requesting a quote or sending us a message; records of calls and messages carried on the service, including numbers, times and durations; voicemail and, where enabled, call recordings and transcripts; and technical information from the applications and devices you use.</p>'],
    ['Why we use it', '<p>To provide and support the service, to bill for it, to register numbers for emergency calling, to meet regulatory obligations, to detect fraud and abuse, and &mdash; where you have separately agreed &mdash; to contact you about Loopcom products.</p>'],
    ['Information about your calling', '<p>Information about the telephone service you buy and the calls you make is treated as Customer Proprietary Network Information and handled under federal rules for telephone companies. See the <a href="/legal/cpni/">CPNI notice</a>.</p>'],
    ['Quote requests and messages', '<p>Details submitted through the quote form or the message box on this website are used to prepare and send your quote and to contact you about that request. Any marketing contact is a separate optional choice, is never pre-selected, and declining it does not affect your quote.</p>'],
    ['Who we share it with', '<p>Carriers who deliver your calls and messages; emergency service databases where required for 911; providers who deliver email and process payments on our behalf; and where the law requires. We do not sell your information.</p>'],
    ['How long we keep it', '<p>Account records are kept while you are a customer and afterwards where retention is required for regulatory or accounting purposes. Call records, recordings and voicemail are retained according to your account configuration.</p>'],
    ['Security', '<p>Traffic between your devices and Loopcom is encrypted in transit and internal access is restricted to staff who need it. See <a href="/security/">Security</a>.</p>'],
    ['Your choices', '<p>You may ask what information we hold, ask for corrections, withdraw marketing consent at any time, and ask about the use of your calling information.</p>'],
    ['Cookies', '<p>This website uses only cookies strictly necessary for it to function. It does not use advertising cookies or cross-site tracking. If that changes, this policy will be updated and consent obtained where required.</p>'],
    ['Changes', '<p>We will update this policy as the service changes and revise the effective date above.</p>'],
  ],
});

export const aup = legalDoc({
  url: '/legal/acceptable-use/',
  title: 'Acceptable Use Policy',
  description: 'What Loopcom services may and may not be used for, including calling and messaging conduct.',
  lede: 'What Loopcom services may and may not be used for.',
  sections: [
    ['Scope', '<p>This policy applies to everyone who uses a Loopcom service and forms part of the <a href="/legal/terms/">Terms of Service</a>.</p>'],
    ['General conduct', '<p>You may not use the service unlawfully, to harass or defraud, to infringe the rights of others, or in a way that damages the service or other customers.</p>'],
    ['Calling', '<p>You may not make calls that breach applicable telemarketing or robocall rules, present misleading caller identification, or generate artificial traffic. Caller identification may only present numbers for which ownership has been established with Loopcom.</p>'],
    ['Messaging', '<p>You may not send messages without the consent required by law, continue messaging after an opt-out, misrepresent the sender, or send content prohibited by mobile carriers. See the <a href="/legal/messaging/">Messaging Terms</a>.</p>'],
    ['Security', '<p>You may not attempt to gain unauthorised access to the platform or to other customers&rsquo; information, or knowingly introduce malicious code.</p>'],
    ['Resale and capacity', '<p>You may not resell the service or connect equipment generating traffic materially beyond ordinary business use without written agreement.</p>'],
    ['Enforcement', '<p>We may investigate suspected breaches and may suspend or restrict service where necessary, including to protect the platform, other customers or the public. We will tell you what happened and why, except where the law prevents it.</p>'],
    ['Reporting', `<p>Report suspected abuse of a Loopcom service to <a href="mailto:${E}">${E}</a>.</p>`],
  ],
});

export const messagingTerms = legalDoc({
  url: '/legal/messaging/',
  title: 'Messaging Terms',
  description: 'Terms for SMS and MMS on Loopcom, including consent, opt-out handling and A2P 10DLC carrier registration.',
  lede: 'Terms for SMS and MMS on Loopcom, including consent, opt-out and carrier registration.',
  sections: [
    ['Scope', '<p>These terms apply to business messaging on Loopcom and form part of the <a href="/legal/terms/">Terms of Service</a>.</p>'],
    ['Registration', '<p>Sending business messages to United States mobile numbers from standard ten-digit numbers requires A2P 10DLC brand and campaign registration with the mobile carriers. Loopcom prepares and submits registration with you. Outcomes are determined by the carriers and are not guaranteed. See <a href="/10dlc/">A2P 10DLC registration</a>.</p>'],
    ['Consent', '<p>You must have consent to message each recipient, obtained before the first message and appropriate to the type of message. Marketing messages require consent clearly separate from any other agreement, and consent may not be a condition of purchase. You must keep records of consent.</p>'],
    ['Opt-out', '<p>You must stop messaging a recipient promptly when they opt out by any reasonable method, including replying STOP. You may not require a specific word or format as the only way to opt out.</p>'],
    ['HELP and identification', '<p>A HELP request must receive a reply identifying your business and explaining how to obtain support and how to opt out. Messages must identify the sending business.</p>'],
    ['Prohibited content', '<p>You may not send content prohibited by carriers or by law, including unlawful goods, high-risk lending offers, and content prohibited under the <a href="/legal/acceptable-use/">Acceptable Use Policy</a>.</p>'],
    ['Delivery', '<p>Mobile carriers filter messaging traffic independently. Loopcom does not guarantee delivery, delivery speed, freedom from filtering, or any particular sending rate.</p>'],
    ['Your responsibility', '<p>Compliance with the laws governing your messaging &mdash; including consent, revocation and record keeping &mdash; is your responsibility.</p>'],
  ],
});

export const cpni = legalDoc({
  url: '/legal/cpni/',
  title: 'CPNI Notice',
  description: 'How Loopcom protects Customer Proprietary Network Information about your telephone service, and the choices you have.',
  lede: 'How Loopcom protects information about your telephone service, and the choices you have.',
  sections: [
    ['What CPNI is', '<p>Customer Proprietary Network Information is information about the telephone service you buy and how you use it &mdash; the numbers you call and are called from, when, for how long, and the services on your account. Federal law requires telephone companies to protect it.</p>'],
    ['How we use it', '<p>To provide, configure, support, bill and repair your service, and where the law requires or permits. We do not sell it.</p>'],
    ['Sharing', '<p>With carriers and vendors who help deliver your service, with emergency services in connection with a 911 call, and where required by law or legal process.</p>'],
    ['Marketing', '<p>Where we wish to use this information to market services beyond those you already buy, we will seek your approval first in the manner the rules require. Declining does not affect your existing service.</p>'],
    ['Protecting your account', '<p>We authenticate callers before discussing account information, restrict internal access to staff who need it, keep records of access and disclosure, and notify you and the authorities of unauthorised disclosure as required.</p>'],
    ['Your choices', `<p>You may ask what information we hold, ask us to restrict its use for marketing, and ask about disclosures. Write to <a href="mailto:${E}">${E}</a> or the address above.</p>`],
  ],
});

export const accessibility = legalDoc({
  url: '/legal/accessibility/',
  title: 'Accessibility',
  description: 'Loopcom’s approach to accessibility, the standard we target for this website, and how to report a barrier.',
  lede: 'Our approach to making Loopcom usable by everyone, and how to tell us when we have fallen short.',
  sections: [
    ['Our approach', '<p>We build the Loopcom website and applications to be usable with a keyboard alone, with a screen reader, at increased zoom and with reduced motion. We target the Web Content Accessibility Guidelines version 2.2 at level AA for this website.</p>'],
    ['What we have done', '<p>This site uses semantic structure and landmarks, a skip link, visible keyboard focus, text and interface contrast measured against the guidelines rather than estimated, form fields with associated labels and clear error messages, and honours the operating system&rsquo;s reduced-motion setting.</p>'],
    ['Known limitations', '<p>We list known limitations here as they are identified rather than claiming the site is perfect.</p>'],
    ['Telling us about a problem', `<p>If you encounter a barrier on this website or in a Loopcom application, contact <a href="mailto:${E}">${E}</a> or telephone <a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a>. Tell us the page or screen and what happened, and we will respond and tell you what we intend to do.</p>`],
    ['Accessible communications', '<p>Customers who need an accessible arrangement should contact us and we will discuss what we can support.</p>'],
  ],
});
