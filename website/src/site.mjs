/**
 * Loopcom website — single source of truth.
 *
 * ⛔ Every company fact, navigation entry, legal link and SEO default lives
 * here. Pages must never hard-code a phone number, an address or an email —
 * import it. That is what makes a change one edit instead of twenty.
 *
 * ⛔ FACTS IN THIS FILE ARE VERIFIED. Do not add a claim without a source:
 *   - legalName / entity facts .. New York Dept of State, DOS ID 8001109
 *                                 (Corporation & Business Entity Database,
 *                                  read 2026-08-24: LOOPCOM LLC, ACTIVE,
 *                                  domestic LLC, filed 08/20/2026, Orange Cty)
 *   - address ................... same DOS record + FCC RMD filing
 *   - phone ..................... the customer-inquiries number filed on the
 *                                 USAC Form 499-A
 */

export const COMPANY = {
  name: 'Loopcom',
  legalName: 'Loopcom LLC',
  // Displayed publicly. Already public on the NY DOS filing and the FCC RMD.
  addressLines: ['33 NY-17M, Suite C', 'Harriman, NY 10926'],
  addressOneLine: '33 NY-17M, Suite C, Harriman, NY 10926',
  locality: 'Harriman',
  region: 'NY',
  postalCode: '10926',
  country: 'US',

  phoneDisplay: '(845) 723-1213',
  phoneE164: '+18457231213',

  // ⛔ Both go to the same mailbox by the owner's instruction (2026-08-24).
  quoteEmail: 'onboarding@loopcom.net',
  supportEmail: 'onboarding@loopcom.net',

  foundedYear: 2026,
};

export const SITE = {
  origin: 'https://www.loopcom.net',
  titleSuffix: ' | Loopcom',
  defaultDescription:
    'Loopcom is a business phone system for companies across the United States — calls, texting and video on desk phones, desktop, mobile and the web.',
  ogImage: '/assets/img/og-loopcom.png',
  locale: 'en_US',
  themeColor: '#0B6FBF',
};

/** Primary navigation. Order matters — it is the order rendered. */
export const NAV = [
  { label: 'Phone system', href: '/business-phone/' },
  { label: 'Apps', href: '/apps/' },
  { label: 'Desk phones', href: '/desk-phones/' },
  { label: 'Messaging', href: '/messaging/' },
  { label: 'Custom solutions', href: '/custom/' },
  { label: 'Solutions', href: '/solutions/' },
  { label: 'Support', href: '/support/' },
];

export const FOOTER = [
  {
    heading: 'Product',
    links: [
      ['Phone system', '/business-phone/'],
      ['Desktop & mobile apps', '/apps/'],
      ['Desk phones', '/desk-phones/'],
      ['Business messaging', '/messaging/'],
      ['Video meetings', '/meetings/'],
      ['Call reporting', '/reporting/'],
      ['Custom solutions', '/custom/'],
    ],
  },
  {
    heading: 'Company',
    links: [
      ['About Loopcom', '/about/'],
      ['Solutions', '/solutions/'],
      ['Security', '/security/'],
      ['Support', '/support/'],
      ['Contact', '/contact/'],
    ],
  },
  {
    heading: 'Legal',
    links: [
      ['Legal centre', '/legal/'],
      ['Terms of service', '/legal/terms/'],
      ['Privacy policy', '/legal/privacy/'],
      ['Acceptable use', '/legal/acceptable-use/'],
      ['Emergency calling', '/e911/'],
      ['Messaging terms', '/legal/messaging/'],
      ['CPNI notice', '/legal/cpni/'],
      ['Accessibility', '/legal/accessibility/'],
    ],
  },
];

/**
 * Quote form + chat relay endpoint.
 * Same-origin so no CORS and no third-party form service sees customer data.
 */
/**
 * Cloudflare Turnstile — the robot check on the two public forms.
 *
 * ⛔ THIS KEY IS PUBLIC BY DESIGN. It ships inside every page and is meant to.
 * The SECRET key is the other half and lives ONLY in the server's environment
 * (TURNSTILE_SECRET_KEY, root-only) — it must never appear in this repo, in a
 * NEXT_PUBLIC-style build variable, or anywhere a browser can reach.
 *
 * Set to '' to remove the check entirely: the widget stops rendering and the
 * server stops verifying, and the site behaves exactly as it did before.
 */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAEamM79uqjq_a-aY';

export const FORM_ENDPOINT = '/api/quote';
export const CHAT_ENDPOINT = '/api/chat';

/** Options shown in the quote form. Kept here so copy edits need no code change. */
export const QUOTE_OPTIONS = {
  industries: [
    'Trades & field service',
    'Retail or wholesale',
    'Professional office',
    'Healthcare',
    'Property management',
    'Logistics & delivery',
    'Other',
  ],
  seatBands: ['1–4', '5–10', '11–25', '26–50', 'More than 50'],
  locationBands: ['One', 'Two', 'Three to five', 'More than five'],
  portingChoices: [
    'Yes, move our existing numbers',
    'No, we need new numbers',
    'Both',
    'Not sure yet',
  ],
  devices: [
    ['desk_phones', 'Desk phones', 'Handsets at desks and counters'],
    ['mobile', 'Mobile app', 'On the road or between sites'],
    ['desktop', 'Desktop app', 'At a computer all day'],
    ['other_devices', 'Conference & other', 'Meeting rooms, paging, intercoms'],
  ],
  interests: [
    ['auto_attendant', 'Auto attendant', 'A greeting that routes callers'],
    ['groups_queues', 'Ring groups or queues', 'Departments that ring together'],
    ['texting', 'Business texting', 'SMS and MMS on your number'],
    ['recording', 'Call recording', 'Record and play back calls'],
    ['reporting', 'Reporting', 'Volumes, answer rates, queues'],
    ['meetings', 'Video meetings', 'Join by link from a browser'],
    ['phone_automation', 'Phone automation', 'Account lookup, payments, order status'],
    ['custom_build', 'A custom system', 'Tracking, workflow or an integration'],
  ],
};

/** Legal document dates. ⛔ Set on the day a document is genuinely published. */
export const LEGAL_EFFECTIVE = 'Pending publication';
export const LEGAL_VERSION = '1.0';

/**
 * Customer testimonials shown on the homepage.
 *
 * ⛔⛔ EVERY ENTRY MUST BE A REAL QUOTE FROM A REAL CUSTOMER WHO HAS GIVEN
 * WRITTEN PERMISSION TO BE NAMED. Do not write one, do not paraphrase one,
 * do not invent a plausible-sounding customer.
 *
 * Two reasons, and the second one has teeth:
 *   1. The brief for this site forbids invented testimonials outright.
 *   2. The FTC Rule on the Use of Consumer Reviews and Testimonials
 *      (16 CFR Part 465, in force since October 2024) prohibits fabricated
 *      testimonials and carries civil penalties per violation. A made-up
 *      quote on a telecom website is a regulatory problem, not a white lie.
 *
 * The homepage section renders ONLY when this array is non-empty, so the site
 * is complete and correct while it stays empty.
 *
 * To add one, capture all five fields:
 *   {
 *     quote:   'What they actually said, verbatim.',
 *     name:    'Full name',
 *     role:    'Their job title',
 *     company: 'Company name',
 *     consent: '2026-08-24',   // date written permission was received
 *   }
 */
export const TESTIMONIALS = [];
