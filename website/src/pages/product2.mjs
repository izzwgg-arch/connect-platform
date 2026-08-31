import { ICONS as I, card, plainCard, checks, sectionHead, pageHead, cta } from '../ui.mjs';

/* ============================ CUSTOM ============================ */
export const custom = {
  url: '/custom/',
  title: 'Custom Phone Systems & Business Software',
  description:
    'Custom phone-based automation and business systems — account lookup by phone, payments by phone, tracking systems and integrations, built for your business.',
  crumbs: [['Custom solutions', null]],
  body: `
${pageHead('Custom solutions',
  'Most providers sell you what is already in the box. We build what your business actually needs &mdash; phone-based automation, tracking systems, integrations into the software you already run.',
  [['Custom solutions', null]])}

<section><div class="wrap">
  ${sectionHead('Automation over the phone', 'If it can happen on a phone call, we can build it.',
    'Your customers already know how to use a telephone. That makes the phone the one channel every customer can reach you on without downloading anything or remembering a password.')}
  <div class="g g3">
    ${card(I.users, 'Account lookup by phone', 'A caller enters an account or reference number and hears what they need &mdash; a balance, an order status, a due date, an appointment time &mdash; without waiting for a person.')}
    ${card(I.phone, 'Payments by phone', 'Take payment during a call, or let customers pay through an automated line that runs day and night. Built to work with your payment provider.')}
    ${card(I.route, 'Order and delivery status', 'Callers check where their order is, when it is due, or which run it is on, straight from your own system.')}
    ${card(I.clock, 'Appointments and reminders', 'Confirm, cancel or reschedule by phone, and send automated reminders before the appointment.')}
    ${card(I.msg, 'Notifications that go out', 'Automated calls and texts triggered by something happening in your system &mdash; a delivery leaving, a job finished, a payment failing.')}
    ${card(I.chart, 'Anything else you can describe', 'If the information exists in a system somewhere, it can usually be reached from a phone call. Tell us the workflow and we will tell you honestly whether it is practical.')}
  </div>
</div></section>

<section class="s-mist"><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Custom systems</span>
    <h2>Software built around how you work.</h2>
    <p class="lede" style="margin-top:15px">We are a software company that runs a phone network. When a customer needs something that does not exist yet, it is a piece of work rather than a refusal.</p>
    ${checks([
      '<b>Tracking systems</b> &mdash; drivers, deliveries, runs, jobs and assets, with a mobile app for the people in the field',
      '<b>Operations tools</b> &mdash; the workflow your business runs on, rather than a spreadsheet everyone has a different copy of',
      '<b>Dashboards and reporting</b> &mdash; the numbers you actually manage by, updating live',
      '<b>Integrations</b> &mdash; connecting Loopcom, or your other systems, to software you already pay for',
      '<b>Customer-facing portals</b> &mdash; so your customers can check things themselves',
    ])}
  </div>
  <div><div class="card" style="background:var(--paper)">
    <h3 style="margin-bottom:6px">How a build works</h3>
    <p style="font-size:14.4px;margin-bottom:18px">No open-ended projects and no surprises on the invoice.</p>
    <div class="tbl-w tbl-bare"><table><tbody>
      <tr><td style="width:34px"><b>1</b></td><td><b>Scope.</b> We sit down with you and work out what it needs to do.</td></tr>
      <tr><td><b>2</b></td><td><b>Quote.</b> A written price and a timeframe before anything is committed.</td></tr>
      <tr><td><b>3</b></td><td><b>Build.</b> We build it, and you see it working as it goes.</td></tr>
      <tr><td><b>4</b></td><td><b>Run.</b> We host it, support it and change it as your business changes.</td></tr>
    </tbody></table></div>
  </div></div>
</div></div></section>

<section><div class="wrap">
  ${sectionHead('Omnichannel', 'One conversation, whichever way the customer starts it.',
    'Customers do not think in channels. They call, then text, then message you from wherever they already are &mdash; and expect whoever picks it up to know what was said last time.')}
  <div class="g g4">
    ${plainCard('Voice', 'Your main business line, menus and departments.')}
    ${plainCard('SMS &amp; MMS', 'Texting on the same number customers already call.')}
    ${plainCard('WhatsApp Business', 'Integration built as part of a custom project, for businesses whose customers live on WhatsApp.')}
    ${plainCard('Facebook Messenger', 'Integration built as part of a custom project, so messages from your page reach the same team.')}
  </div>
  <div class="note" style="margin-top:26px"><b>Channels beyond voice and SMS are delivered as custom integration projects</b> rather than a switch in the portal. Tell us which channels your customers use and we will scope it with your quote.</div>
</div></section>

<section class="s-night"><div class="wrap" style="max-width:760px">
  <span class="eyebrow">Where we draw the line</span>
  <h2>The one thing we will not build.</h2>
  <p class="lede" style="margin-top:16px;color:#A8BDD4">We do not build robocall systems, and we do not carry robocall traffic. Not as a favour to the industry &mdash; because it is the difference between a phone number your customers answer and one every carrier learns to block.</p>
  <div class="g g2" style="margin-top:34px">
    ${plainCard('What that means in practice', 'No mass unsolicited dialling, no spoofed caller identification, and no campaign that contacts people who never agreed to hear from you. Loopcom operates a robocall mitigation programme and every number you present has to be one you own.')}
    ${plainCard('What it does not mean', 'Legitimate automated calling is fine &mdash; appointment reminders, delivery notifications, payment confirmations, service alerts. The test is whether the person on the other end agreed to hear from you.')}
  </div>
  <p style="margin-top:26px;font-size:15px">Everything else, within the law, is on the table.</p>
</div></section>

${cta('Got something specific in mind?', 'Describe what you want to happen and we will tell you whether it is practical, what it takes and what it costs.')}`,
};

/* ============================ 10DLC ============================ */
export const tenDlc = {
  url: '/10dlc/',
  title: 'A2P 10DLC Registration Explained',
  description:
    'What A2P 10DLC means, why US carriers require it for business texting, what brand and campaign registration involve, and what gets messages filtered.',
  crumbs: [['Messaging', '/messaging/'], ['A2P 10DLC', null]],
  body: `
${pageHead('A2P 10DLC registration',
  'If your business texts customers in the United States from a standard phone number, US mobile carriers require you to register that number first. The programme is called A2P 10DLC. Here is what it means and what it involves.',
  [['Messaging', '/messaging/'], ['A2P 10DLC', null]])}

<section><div class="wrap"><div class="legal-body" style="max-width:760px">
  <h2>What A2P 10DLC actually means</h2>
  <div class="tbl-w" style="margin-bottom:18px"><table><tbody>
    <tr><td style="width:110px"><b>A2P</b></td><td><b>Application-to-Person.</b> Messages sent by a business system &mdash; your phone platform, your booking software, your dispatch tool &mdash; rather than typed by one person on a handset. Almost all business texting is A2P, even when a member of staff writes it.</td></tr>
    <tr><td><b>10DLC</b></td><td><b>10-Digit Long Code.</b> An ordinary ten-digit phone number, like the one already on your van and your invoices &mdash; as opposed to a five-digit short code or a toll-free number.</td></tr>
  </tbody></table></div>
  <p>Put together, A2P 10DLC is the programme the US mobile carriers &mdash; AT&amp;T, T-Mobile and Verizon &mdash; use to identify legitimate business messaging sent from normal phone numbers. Before it existed, business texting on ordinary numbers was indistinguishable from spam, so carriers filtered it heavily. Registration tells them who you are and what you send.</p>
  <div class="note"><b>It applies to every provider.</b> A2P 10DLC is a carrier requirement, not a Loopcom one. Any provider offering business texting on a standard US number has to register your traffic, and unregistered messages are filtered, surcharged or blocked outright.</div>

  <h2>Where the registration goes</h2>
  <p>Registrations are submitted to <b>The Campaign Registry</b>, the central database the US carriers use for A2P 10DLC. Loopcom submits on your behalf; the carriers make the decisions.</p>

  <h2>The two registrations</h2>
  <h3>1. Brand &mdash; who you are</h3>
  <p>Your legal business name, business address, tax identification number (EIN), website and a contact person. These are verified against public records, so they must match what is officially registered for your business rather than the name on your signage.</p>
  <p>Brand registration produces a <b>trust score</b>. A well-established business with consistent public records scores higher, and a higher score means the carriers allow you to send at a faster rate.</p>
  <h3>2. Campaign &mdash; what you send</h3>
  <p>Your use case: appointment reminders, order and delivery updates, customer service, account notifications, marketing, or a mix. You provide sample messages, and you describe how customers opt in and how they opt out. Each distinct use case is registered as its own campaign.</p>

  <h2>How fast you can send</h2>
  <p>A2P 10DLC sets a limit on how many messages per minute you may send to each carrier. That limit comes from your brand&rsquo;s trust score and your registered campaign type &mdash; it is not something your provider chooses. For most businesses sending reminders and updates it is never a constraint; if you plan to send in large batches, tell us and we will size it with you.</p>

  <h2>Who does what</h2>
  <div class="tbl-w"><table><thead><tr><th>Step</th><th>Handled by</th></tr></thead><tbody>
    <tr><td>Submitting brand registration to The Campaign Registry</td><td><b>Loopcom</b></td></tr>
    <tr><td>Submitting campaign registration for your use case</td><td><b>Loopcom</b></td></tr>
    <tr><td>Supplying accurate business details and EIN</td><td><b>You</b></td></tr>
    <tr><td>Providing opt-in wording and sample messages</td><td><b>You</b></td></tr>
    <tr><td>Collecting consent from the people you text</td><td><b>You</b></td></tr>
    <tr><td>Honouring opt-outs and answering HELP</td><td><b>Handled by the platform</b></td></tr>
    <tr><td>Approving brand, campaign and trust score</td><td>The mobile carriers</td></tr>
  </tbody></table></div>

  <h2>What gets messages filtered or blocked</h2>
  <p>Even with a registered campaign, carriers continue to filter traffic. These are the things that cause it:</p>
  <ul>
    <li>Messaging people who have not agreed to hear from you</li>
    <li>Continuing to message someone after they replied STOP</li>
    <li>Sending content that does not match your registered campaign &mdash; marketing on a campaign registered for appointment reminders, for example</li>
    <li>Categories carriers prohibit outright, including high-risk lending, unlawful goods and certain debt-related offers</li>
    <li>Business details in the brand registration that do not match public records</li>
    <li>Sending faster than your registered throughput allows</li>
  </ul>

  <h2>Timing and cost</h2>
  <p>Brand registration is usually quick. Campaign review takes longer and is genuinely reviewed rather than rubber-stamped &mdash; a campaign that is rejected has to be corrected and resubmitted, which adds time. We start the process early in your setup so it is not what holds up your go-live date.</p>
  <p>The carriers and The Campaign Registry charge registration and per-campaign fees, and carriers apply a per-message fee to A2P traffic. These are pass-through costs that exist with every provider. Your quote sets them out so there are no surprises on the first bill.</p>

  <h2>Toll-free numbers work differently</h2>
  <p>A2P 10DLC applies to standard ten-digit numbers. Toll-free numbers use a separate carrier verification process instead, with different throughput characteristics. If you text from a toll-free number, or are considering one, tell us and we will explain which route suits what you are sending.</p>

  <div class="note" style="margin-top:26px"><b>What to have ready.</b> Your legal business name exactly as registered, business address, EIN, website, and a description of what you intend to send with two or three sample messages. If customers opt in on a form, at a counter or on your website, keep a copy of the wording &mdash; the campaign registration asks for it.</div>
</div></div></section>

${cta('Planning to text your customers?', 'Tell us what you want to send and we will include messaging and the A2P 10DLC registration in your quote.')}`,
};

/* ============================= E911 ============================= */
export const e911 = {
  url: '/e911/',
  title: 'Emergency Calling & E911',
  description:
    'How 911 works on Loopcom, what it depends on, and your responsibility to keep the registered address for each number current.',
  crumbs: [['Emergency calling', null]],
  body: `
${pageHead('Emergency calling',
  'How 911 works on Loopcom, what it depends on, and what you need to keep up to date.',
  [['Emergency calling', null]])}

<section><div class="wrap"><div class="legal-body" style="max-width:760px">
  <div class="note warn"><b>Please read this.</b> Loopcom provides 911 service, but it does not work the same way as a traditional telephone line. It depends on your internet connection and your electricity, and it sends the address registered for your number.</div>

  <h2>How 911 calls work</h2>
  <p>When someone dials 911 from a Loopcom phone, the call is routed to the emergency call centre serving the address registered for that number, and that registered address is given to the dispatcher.</p>
  <p>We record a registered address for every number able to dial 911. It is collected when your service is set up and checked against the emergency address database.</p>

  <h2>Keeping your registered address correct</h2>
  <p>The address we hold is the address emergency services will be sent to. If your business moves, opens another location, or moves a phone to a different building, the registered address must be updated <b>before</b> the phone is used there.</p>
  <ul>
    <li>Tell us when a location changes so we can update the registration.</li>
    <li>Do not move a desk phone to another address and assume 911 follows it.</li>
    <li>Take particular care with the apps, which can be used anywhere.</li>
  </ul>

  <h2>Using the apps away from your address</h2>
  <p>The desktop and mobile apps work anywhere with an internet connection. If you dial 911 from an app while away from your registered address, the call may be routed to the emergency centre for the registered address rather than where you are, and the dispatcher may be shown the wrong location.</p>
  <p>If you are away from your registered address and need emergency help, use a mobile phone on the cellular network wherever possible.</p>

  <h2>When 911 may not be available</h2>
  <ul>
    <li><b>No internet.</b> If your broadband is down, no calls can be placed, including 911.</li>
    <li><b>No power.</b> Phones, routers and network equipment need electricity. Unlike an old analogue line, they do not draw power from the phone network.</li>
    <li><b>Network congestion or an outage</b> affecting Loopcom or a connecting provider.</li>
    <li><b>Suspended service</b>, including suspension for non-payment.</li>
    <li><b>Equipment unplugged, faulty or misconfigured.</b></li>
  </ul>

  <h2>Tell everyone who uses the phones</h2>
  <p>Anyone who might dial 911 from a Loopcom phone should know these limitations &mdash; including staff working from home, anyone using the mobile app, and visitors to your premises. We provide warning labels for handsets on request.</p>

  <h2>Acknowledgement</h2>
  <p>Customers are asked to acknowledge these limitations before service begins, and that acknowledgement is recorded on the account.</p>
</div></div></section>

${cta('Questions about 911 on your lines?', 'Ask us directly &mdash; it is something we would rather over-explain than leave unclear.')}`,
};

/* =========================== SECURITY =========================== */
export const security = {
  url: '/security/',
  title: 'Security & Privacy',
  description:
    'How Loopcom protects your account, your calls and your customer proprietary network information — encryption in transit, access control and fraud protection.',
  crumbs: [['Security', null]],
  body: `
${pageHead('Security', 'How we protect your account, your calls and the information we hold about your service.', [['Security', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.lock, 'Encrypted connections', 'Traffic between your devices and Loopcom travels over encrypted connections, and the portal is served over HTTPS only.')}
  ${card(I.users, 'Access control', 'Permissions are set per person, so your team sees what they need and administration stays with the people who should have it.')}
  ${card(I.shield, 'Fraud protection', 'International dialling is blocked by default, and we watch for the calling patterns that indicate a compromised extension.')}
  ${card(I.phone, 'Caller ID protection', 'Numbers can only be presented where ownership has been established, which prevents your account being used to spoof someone else.')}
  ${card(I.route, 'Separated accounts', 'Every customer&rsquo;s configuration, directory and call records are kept separate.')}
  ${card(I.chart, 'Change history', 'Administrative changes to your configuration are recorded, so it is possible to see what changed and when.')}
</div></div></section>

<section class="s-mist"><div class="wrap">
  ${sectionHead('', 'Information about your calling',
    'Details of the service you buy and the calls you make are protected under federal rules for telephone companies, known as Customer Proprietary Network Information.')}
  ${checks([
    'We use it to provide, support and bill for your service',
    'We do not sell it',
    'Access inside Loopcom is limited to staff who need it',
    'We verify who you are before discussing your account',
    'You can ask what we hold and how it is used',
  ])}
  <div style="margin-top:26px"><a class="tlink" href="/legal/privacy/">Privacy policy &rarr;</a></div>
</div></section>

${cta()}`,
};
