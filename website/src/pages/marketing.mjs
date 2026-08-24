import { COMPANY, TESTIMONIALS } from '../site.mjs';
import { ICONS as I, card, plainCard, checks, sectionHead, pageHead, cta,
         appMock, menuMock, callsMock, testimonials } from '../ui.mjs';

/* ============================ HOME ============================ */
export const home = {
  url: '/',
  title: 'Business Phone Systems for US Companies',
  description:
    'A complete business phone system — calls, texting and video on desk phones, desktop, mobile and web. We move your numbers across and set it up with you.',
  body: `
<section class="hero">
  <div class="hero-glow" aria-hidden="true"></div><div class="hero-lat" aria-hidden="true"></div>
  <div class="wrap">
    <div class="hero-in">
      <span class="pill"><span class="pill-d" aria-hidden="true"></span><b>Loopcom</b> &middot; Business communications</span>
      <h1>The complete business phone system.</h1>
      <p class="lede">Calls, messaging and video for your whole team &mdash; on desk phones, desktop, mobile and the web. We set it up, move your numbers across, and keep it running.</p>
      <div class="hero-acts">
        <a class="btn btn-lg btn-pri" href="/quote/">Request a Quote</a>
        <a class="tlink" href="/business-phone/">See the phone system &rarr;</a>
      </div>
    </div>
    <div class="shot">${appMock()}</div>
  </div>
</section>

<section class="s-mist"><div class="wrap">
  ${sectionHead('Everything included', 'One system for every way your team works.',
    'A call comes in once and rings wherever it needs to &mdash; the desk, a pocket, a browser tab. Same extension, same contacts, same history.', true)}
  <div class="g g3">
    ${card(I.phone, 'Cloud phone system', 'Extensions, auto attendants, ring groups, call queues and business-hours routing, all managed from one place.')}
    ${card(I.dev, 'Desktop &amp; mobile apps', 'Windows, iPhone and Android apps plus a browser phone. Answer anywhere and move a live call between devices.')}
    ${card(I.desk, 'Desk phones', 'Professional handsets that arrive configured. Plug one in and it registers itself and picks up your settings.')}
    ${card(I.msg, 'Business texting', 'Send and receive SMS and MMS on your business number, with shared team inboxes.')}
    ${card(I.vid, 'Video meetings', 'Send a link and people join from a browser. Screen sharing, chat and host controls included.')}
    ${card(I.chart, 'Reporting &amp; recording', 'Company-wide call history, queue performance and call recording with searchable playback.')}
  </div>
</div></section>

<section><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Call routing</span>
    <h2>Every call goes exactly where it should.</h2>
    <p class="lede" style="margin-top:15px">Build your call flow visually &mdash; menus, departments, queues and schedules &mdash; and change it yourself in seconds.</p>
    ${checks([
      '<b>Auto attendants</b> that greet callers and route them by keypress',
      '<b>Ring groups</b> so a department rings together instead of one desk',
      '<b>Call queues</b> with hold announcements and live wait times',
      '<b>Business hours and holidays</b> that switch the greeting automatically',
      '<b>Per-number routing</b>, so each line can behave differently',
    ])}
    <div style="margin-top:26px"><a class="tlink" href="/business-phone/">More on call handling &rarr;</a></div>
  </div>
  <div>${menuMock()}</div>
</div></div></section>

<section class="s-night"><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Moving to Loopcom</span>
    <h2>Keep your numbers. Change everything else.</h2>
    <p class="lede" style="margin-top:15px;color:#A8BDD4">We move your existing numbers to Loopcom, configure your call flow with you, and stay on the line the day you go live.</p>
    ${checks([
      'We handle the transfer of your numbers from your current provider',
      'Your phones are configured before they reach your desks',
      'We build your menus, departments and hours with you',
      'Your current service keeps running right up to the moment we switch',
    ])}
  </div>
  <div class="g" style="gap:14px">
    ${plainCard('1. Quote', 'Tell us how your business runs. We send a written quote covering everything.')}
    ${plainCard('2. Build', 'We configure your system, prepare your handsets and start your number transfers.')}
    ${plainCard('3. Go live', 'Your numbers switch across and your team keeps working. We are there on the day.')}
  </div>
</div></div></section>

<section><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Custom solutions</span>
    <h2>And if you need something that does not exist yet, we build it.</h2>
    <p class="lede" style="margin-top:15px">We are a software company that runs a phone network. Customers come to us with a workflow, not a feature request &mdash; and we build it.</p>
    ${checks([
      '<b>Account lookup by phone</b> &mdash; callers get a balance or a status without waiting for anyone',
      '<b>Payments by phone</b>, day or night, working with your payment provider',
      '<b>Tracking systems</b> for drivers, deliveries, runs and jobs',
      '<b>Integrations</b> into the software you already pay for',
    ])}
    <div style="margin-top:26px"><a class="tlink" href="/custom/">See what we build &rarr;</a></div>
  </div>
  <div class="g" style="gap:14px">
    ${plainCard('Scope it with you', 'We work out what it has to do before anyone writes a line of code.')}
    ${plainCard('Quote it in writing', 'A price and a timeframe up front, not an open-ended project.')}
    ${plainCard('Build, host and support it', 'It runs on our infrastructure and changes as your business does.')}
  </div>
</div></div></section>

<section class="s-mist"><div class="wrap">
  ${sectionHead('Who we work with', 'Built for businesses that live on the phone.', '', true)}
  <div class="g g4">
    ${plainCard('Trades &amp; service', 'Reach whoever is free, including the crew on the road, without customers hearing a busy signal.')}
    ${plainCard('Retail &amp; wholesale', 'Handle order-line peaks with queues, and let customers text the number they already call.')}
    ${plainCard('Professional offices', 'A clean greeting, direct extensions and voicemail delivered straight to email.')}
    ${plainCard('Multi-site businesses', 'One directory across every location, with each site keeping its own number and greeting.')}
  </div>
  <div style="margin-top:26px"><a class="tlink" href="/solutions/">See how businesses use Loopcom &rarr;</a></div>
</div></section>

${testimonials(TESTIMONIALS)}

${cta()}`,
};

/* ======================= BUSINESS PHONE ======================= */
export const businessPhone = {
  url: '/business-phone/',
  title: 'Cloud Business Phone System — Auto Attendant, Queues & Voicemail',
  description:
    'A cloud phone system with auto attendants, ring groups, call queues, business-hours routing, voicemail to email and call recording. Built for US businesses.',
  crumbs: [['Phone system', null]],
  body: `
${pageHead('Business phone system',
  'Everything you expect from a modern phone system, and the routing controls to make it fit how your business actually answers.',
  [['Phone system', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.route, 'Auto attendant', 'Greet callers and route them by keypress &mdash; to a person, a department, a queue or another menu. Set a timeout and what happens if nobody presses anything.')}
  ${card(I.users, 'Ring groups', 'Ring a whole department at once, or in sequence. Ideal when the role matters more than the person: reception, dispatch, the order desk.')}
  ${card(I.chart, 'Call queues', 'Hold callers in order with announcements and position updates, and watch queues live as they build and clear.')}
  ${card(I.vm, 'Voicemail', 'Personal and shared mailboxes, with messages delivered to email as an audio file and, where enabled, a written transcript.')}
  ${card(I.rec, 'Call recording', 'Record the calls you need to and find them again from call history, with playback and download.')}
  ${card(I.clock, 'Business hours', 'Different greetings and destinations for open hours, after hours and holidays, switching on schedule without anyone remembering.')}
</div></div></section>

<section class="s-mist"><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Call history</span>
    <h2>Every call, on the record.</h2>
    <p class="lede" style="margin-top:15px">Search the whole company&rsquo;s calls &mdash; who rang, which number they reached, how it was routed, how long it lasted.</p>
    ${checks([
      'Filter by extension, number, direction, date or result',
      'Play or download recordings where recording is switched on',
      'Follow how a call moved through menus, groups and queues',
      'Give each person their own calls, and managers the whole company',
    ])}
  </div>
  <div>${callsMock()}</div>
</div></div></section>

<section><div class="wrap">
  ${sectionHead('', 'Features included as standard', '')}
  <div class="tbl-w"><table>
    <caption class="hp">Standard features included with every Loopcom phone system</caption>
    <tbody>
    <tr><td><b>Extensions</b></td><td>Internal dialling across the company</td><td><b>Transfer</b></td><td>Warm and blind, from any device</td></tr>
    <tr><td><b>Hold &amp; music</b></td><td>Your own hold audio</td><td><b>Call park</b></td><td>Pick a held call up from another desk</td></tr>
    <tr><td><b>Do not disturb</b></td><td>Per extension, set from any device</td><td><b>Caller ID</b></td><td>Present the right number per department</td></tr>
    <tr><td><b>Forwarding</b></td><td>To another extension or an outside line</td><td><b>Directory</b></td><td>Company contacts on every device</td></tr>
    <tr><td><b>Voicemail to email</b></td><td>Audio delivered to your inbox</td><td><b>Shared mailboxes</b></td><td>For departments, not just people</td></tr>
  </tbody></table></div>
</div></section>

${cta()}`,
};

/* ============================ APPS ============================ */
export const apps = {
  url: '/apps/',
  title: 'Desktop, Mobile & Web Softphone Apps',
  description:
    'Take your business number anywhere. Windows desktop, iPhone and Android apps and a browser softphone — one extension across every device.',
  crumbs: [['Apps', null]],
  body: `
${pageHead('Desktop, mobile and web',
  'Your business number on every device you use. Answer at your desk, carry the call to your phone, finish it in a browser.',
  [['Apps', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.dev, 'Windows desktop', 'A full desktop application with proper incoming-call alerts, your directory, messages and voicemail in one window.')}
  ${card(I.phone, 'iPhone and Android', 'Business calls ring like calls, not notifications. Take the office number with you without giving out your mobile.')}
  ${card(I.glob, 'Web phone', 'Sign in and make calls from a browser tab &mdash; useful for shared machines, temporary desks and locked-down laptops.')}
</div>
<div class="g g2" style="margin-top:22px">
  ${plainCard('Calls', 'Make and take calls on your business number, transfer them, put people on hold and move a live call between your own devices.')}
  ${plainCard('Messages', 'Send and receive text and picture messages on the same business number, in threads your team can share.')}
  ${plainCard('Voicemail', 'Listen in the app, read the transcript where transcription is on, and call back in one tap.')}
  ${plainCard('Directory', 'See colleagues, who is on a call and who is unavailable before you transfer to them.')}
</div></div></section>

${cta()}`,
};

/* ========================= DESK PHONES ========================= */
export const deskPhones = {
  url: '/desk-phones/',
  title: 'Desk Phones — Preconfigured & Zero-Touch Provisioning',
  description:
    'Professional SIP desk phones that arrive configured and ready to work. Yealink, Grandstream, Polycom, Fanvil and Snom, with button layouts set centrally.',
  crumbs: [['Desk phones', null]],
  body: `
${pageHead('Desk phones',
  'Professional handsets that arrive ready to work. We configure them before they ship, so you plug one in and it just registers.',
  [['Desk phones', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.desk, 'Configured before delivery', 'Your extension, buttons and settings are loaded before the phone reaches you. There is nothing to type into a handset.')}
  ${card(I.users, 'Buttons set centrally', 'Busy-lamp keys, shared lines and speed dials are set from the portal and pushed to the phones, so every desk matches.')}
  ${card(I.route, 'Changes without a visit', 'Move an extension, relabel a key or change a setting from the portal and the phone picks it up.')}
</div>

<div style="margin-top:52px">
  ${sectionHead('', 'Works with the handsets businesses actually buy',
    'Loopcom supports professional SIP handsets from the major manufacturers, from a simple two-line phone to a receptionist console with expansion keys.')}
  <div class="g g4">
    ${plainCard('Yealink', 'Desk phones, conference phones, cordless handsets and expansion modules.')}
    ${plainCard('Grandstream', 'Desk phones, video handsets and door intercoms.')}
    ${plainCard('Polycom', 'Desk and conference phones, including the classic meeting-room units.')}
    ${plainCard('Fanvil &amp; Snom', 'Desk phones, paging speakers and intercom units for warehouses and entrances.')}
  </div>
  <div class="note" style="margin-top:28px"><b>Already have handsets?</b> Many existing SIP phones can be reconfigured to work with Loopcom instead of being replaced. Send us the makes and models with your quote request and we will confirm.</div>
</div>
</div></section>

<section class="s-mist"><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">Beyond the desk</span>
    <h2>Phones for the whole building.</h2>
    <p class="lede" style="margin-top:15px">A phone system is not only desks. We supply and configure the other devices that need to be on it.</p>
    ${checks([
      '<b>Conference phones</b> for meeting rooms',
      '<b>Cordless handsets</b> for shop floors and warehouses',
      '<b>Overhead paging</b> and warehouse speakers',
      '<b>Door intercoms</b> that ring the phones and let staff release the door',
    ])}
  </div>
  <div class="card" style="background:var(--paper)">
    <h3 style="margin-bottom:14px">A typical fit-out</h3>
    <div class="tbl-w tbl-bare"><table><tbody>
      <tr><td><b>Reception</b></td><td>Desk phone with expansion keys</td></tr>
      <tr><td><b>Offices</b></td><td>Standard desk phones</td></tr>
      <tr><td><b>Meeting room</b></td><td>Conference phone</td></tr>
      <tr><td><b>Warehouse</b></td><td>Cordless handset and paging speaker</td></tr>
      <tr><td><b>Front door</b></td><td>Intercom ringing reception</td></tr>
      <tr><td><b>On the road</b></td><td>Mobile app on the same extension</td></tr>
    </tbody></table></div>
  </div>
</div></div></section>

${cta('Need phones on desks?', 'Tell us how many people, how many rooms and what is on the walls, and we will quote the handsets with the service.')}`,
};

/* ========================== MESSAGING ========================== */
export const messaging = {
  url: '/messaging/',
  title: 'Business Text Messaging — SMS & MMS on Your Business Number',
  description:
    'Send and receive SMS and MMS on your existing business number, with shared team inboxes and email delivery. Includes A2P 10DLC registration.',
  crumbs: [['Messaging', null]],
  body: `
${pageHead('Business texting',
  'Customers already text. Let them text the number they call &mdash; and let your whole team answer.',
  [['Messaging', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.msg, 'SMS and MMS', 'Send and receive text and picture messages on your main business number, from desktop, mobile or the web.')}
  ${card(I.users, 'Shared team inbox', 'Messages to the business number can be shared, so whoever is free replies and everyone sees the conversation.')}
  ${card(I.dev, 'Texts in your inbox', 'Incoming messages can also be delivered to email, and replying to that email sends a text back.')}
</div>
<div class="note warn" style="margin-top:34px"><b>Texting customers in the United States requires A2P 10DLC registration.</b> US mobile carriers require every business sending messages from a standard ten-digit number to be registered first, and unregistered traffic is filtered or blocked. It applies to every provider. We prepare and submit the registration with you during setup. <a class="tlink" href="/10dlc/" style="font-size:14.6px">What A2P 10DLC involves &rarr;</a></div>
</div></section>

<section class="s-mist"><div class="wrap"><div class="split">
  <div>
    <span class="eyebrow">How businesses use it</span>
    <h2>The messages customers prefer.</h2>
    ${checks([
      '<b>Appointment reminders</b> that cut no-shows',
      '<b>Order and delivery updates</b> without a phone call',
      '<b>Quotes and invoices</b> sent straight to a handset',
      '<b>Quick questions</b> answered without anyone waiting on hold',
      '<b>Photos from the field</b> sent to the office by MMS',
    ])}
  </div>
  <div class="card" style="background:var(--paper)">
    <h3 style="margin-bottom:16px">Getting started</h3>
    ${checks([
      'We submit your A2P 10DLC brand and campaign registration',
      'We set up your number for messaging',
      'Your team answers from the apps they already use',
      'Opt-outs are handled automatically',
    ])}
    <div style="margin-top:20px"><a class="btn btn-pri" href="/quote/">Request a Quote</a></div>
  </div>
</div></div></section>

${cta('Want texting on your business number?', 'Tell us how you would use it and we will include messaging and registration in your quote.')}`,
};

/* =========================== MEETINGS =========================== */
export const meetings = {
  url: '/meetings/',
  title: 'Video Meetings — Join by Link From a Browser',
  description:
    'Video meetings included with your Loopcom phone system. Guests join by link from a browser with screen sharing, chat and host controls.',
  crumbs: [['Video meetings', null]],
  body: `
${pageHead('Video meetings',
  'Send a link and people join. No downloads for your guests, no separate subscription for you.',
  [['Video meetings', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.vid, 'Join from a browser', 'Guests open the link and join. Nothing to install and no account to create.')}
  ${card(I.dev, 'Screen sharing', 'Present a document, a drawing or an application to everyone in the meeting.')}
  ${card(I.users, 'Host controls', 'Mute a participant, remove someone, or lock the meeting once everyone has arrived.')}
  ${card(I.msg, 'Chat and raise hand', 'Ask a question without talking over whoever is presenting.')}
  ${card(I.clock, 'Scheduled meetings', 'Schedule ahead and send email invitations with the joining link and the time zone spelled out.')}
  ${card(I.lock, 'Private by code', 'Every meeting has its own code, and can be locked so nobody else joins.')}
</div></div></section>

${cta()}`,
};

/* =========================== REPORTING =========================== */
export const reporting = {
  url: '/reporting/',
  title: 'Call Reporting & Call Recording',
  description:
    'See what is happening on your phones — call volumes, answer rates, queue performance and a live wallboard, with call recording and searchable playback.',
  crumbs: [['Reporting', null]],
  body: `
${pageHead('Reporting and call recording',
  'See what is actually happening on your phones &mdash; by person, by department, by day.',
  [['Reporting', null]])}

<section><div class="wrap"><div class="g g3">
  ${card(I.chart, 'Call reporting', 'Volumes, answer rates and busy periods across the company, so staffing decisions are based on numbers rather than impressions.')}
  ${card(I.users, 'Queue performance', 'How long callers waited, how many gave up and which agents answered, per queue.')}
  ${card(I.rec, 'Call recording', 'Record where you need to, then search call history and play back or download.')}
  ${card(I.glob, 'Live wallboard', 'A screen for the room showing calls in progress, queue pressure and today&rsquo;s totals.')}
  ${card(I.route, 'Per-number reporting', 'See how each published number performs &mdash; useful when you advertise different lines.')}
  ${card(I.clock, 'History you can search', 'Filter by extension, number, direction, date or result and export what you find.')}
</div></div></section>

${cta()}`,
};

/* =========================== SOLUTIONS =========================== */
export const solutions = {
  url: '/solutions/',
  title: 'Solutions by Business Type',
  description:
    'How trades and field service, retail and wholesale, professional offices and multi-site businesses set up their Loopcom phone system.',
  crumbs: [['Solutions', null]],
  body: `
${pageHead('Solutions',
  'How different businesses set Loopcom up. Yours will not match exactly &mdash; that is what the quote conversation is for.',
  [['Solutions', null]])}

<section><div class="wrap"><div class="g g2">
  <div class="card"><h3>Trades and field service</h3>
    <p style="margin-bottom:12px">Calls come to the office number and have to reach whoever is free, including people driving.</p>
    ${checks(['One ring group rings the office and the crew&rsquo;s mobile apps','After hours the number routes to the on-call phone','Voicemail lands in email so nothing waits until Monday','Photos from site come in by picture message'])}
  </div>
  <div class="card"><h3>Retail, wholesale and order desks</h3>
    <p style="margin-bottom:12px">Predictable peaks, and customers who would rather text than hold.</p>
    ${checks(['A queue with announcements instead of a busy tone','Texting on the number already on your van and your signage','A wallboard so the floor sees how far behind it is','Separate numbers for orders and accounts'])}
  </div>
  <div class="card"><h3>Professional offices</h3>
    <p style="margin-bottom:12px">Fewer calls, but each one matters and needs the right person quickly.</p>
    ${checks(['A short menu with direct extensions','Voicemail to email with transcripts','Call recording where your profession requires it','Clear out-of-hours and holiday greetings'])}
  </div>
  <div class="card"><h3>Multiple locations</h3>
    <p style="margin-bottom:12px">Every site keeps its identity while the company shares one system.</p>
    ${checks(['Each site keeps its own number and greeting','One directory and extension dialling between sites','Calls overflow to another site when one is busy','Central administration with per-site access'])}
  </div>
</div></div></section>

${cta()}`,
};

/* ============================ ABOUT ============================ */
export const about = {
  url: '/about/',
  title: 'About Loopcom',
  description:
    'Loopcom LLC provides business telephone service to companies across the United States — an interconnected VoIP provider that builds its own software.',
  crumbs: [['About', null]],
  body: `
${pageHead('About Loopcom', 'Business telephone service for companies across the United States.', [['About', null]])}

<section><div class="wrap"><div class="split split-top">
  <div class="legal-body" style="max-width:none">
    <h2 style="margin-top:0">What we do</h2>
    <p>Loopcom provides business telephone service &mdash; numbers, calling, voicemail, texting and video meetings &mdash; to companies across the United States. We are an interconnected VoIP provider, which means your Loopcom numbers reach and are reached from the ordinary telephone network exactly as any other business line would be.</p>
    <h2>How we work with customers</h2>
    <p>We quote in writing before anything is committed. We move your existing numbers rather than asking your customers to learn new ones. We configure the system with you, prepare your handsets before they reach your desks, and we are available on the day you go live.</p>
    <p>When something needs changing later &mdash; a new department, a different greeting, another location &mdash; it is a conversation, not a support ticket that goes nowhere.</p>
    <h2>Who we serve</h2>
    <p>Businesses where the telephone is not optional: trades and service companies, retail and wholesale operations, professional offices, and organisations running several locations. Typically the phone rings all day, and everyone notices immediately when it does not.</p>
  </div>
  <div>
    <div class="card" style="background:var(--mist)">
      <h3 style="margin-bottom:16px">Company</h3>
      <div class="tbl-w tbl-bare"><table><tbody>
        <tr><td><b>Legal entity</b></td><td>${COMPANY.legalName}</td></tr>
        <tr><td><b>Address</b></td><td>${COMPANY.addressOneLine}</td></tr>
        <tr><td><b>Telephone</b></td><td class="num"><a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a></td></tr>
        <tr><td><b>Service</b></td><td>Interconnected VoIP</td></tr>
      </tbody></table></div>
      <div style="margin-top:20px"><a class="btn btn-pri" href="/quote/">Request a Quote</a></div>
    </div>
  </div>
</div></div></section>

${cta()}`,
};

/* =========================== SUPPORT =========================== */
export const support = {
  url: '/support/',
  title: 'Support',
  description:
    'How to reach Loopcom support if you are an existing customer — by telephone, email, text, or from inside the Loopcom app.',
  crumbs: [['Support', null]],
  body: `
${pageHead('Support', 'How to reach us if you are already a Loopcom customer.', [['Support', null]])}

<section><div class="wrap"><div class="g g2">
  <div class="card"><h3>Telephone</h3><p style="margin-bottom:10px">Call the main line and ask for support.</p>
    <p class="num" style="font-family:var(--fd);font-size:24px;font-weight:700;color:var(--ink)"><a href="tel:${COMPANY.phoneE164}" style="color:inherit;text-decoration:none">${COMPANY.phoneDisplay}</a></p></div>
  <div class="card"><h3>Email</h3><p style="margin-bottom:10px">Include the number or extension affected.</p>
    <p style="font-family:var(--fd);font-size:18px;font-weight:700;color:var(--ink)"><a href="mailto:${COMPANY.supportEmail}" style="color:inherit;text-decoration:none">${COMPANY.supportEmail}</a></p></div>
  <div class="card"><h3>From the app</h3><p>Report a problem directly from the Loopcom portal and it reaches us with your account and device details attached.</p></div>
  <div class="card"><h3>Text us</h3><p>Our main line accepts text messages. For a short question it is often quickest.</p></div>
</div>

<div style="margin-top:52px">
  <h2 style="margin-bottom:22px">Common questions</h2>
  <div class="g g2">
    ${plainCard('A phone has stopped ringing', 'Check the handset shows a registered line and the extension is not set to do not disturb. If both look right, call us with the extension number.')}
    ${plainCard('We need to change the greeting', 'Greetings are changed from the portal. You can record a new one or have one generated from typed text.')}
    ${plainCard('Someone has joined the team', 'Add the extension from the portal, or ask us and we will set it up including the desk phone.')}
    ${plainCard('We are moving premises', 'Tell us before you move. Your 911 registered address has to be updated and it is not automatic.')}
  </div>
</div>
</div></section>`,
};

/* =========================== CONTACT =========================== */
export const contact = {
  url: '/contact/',
  title: 'Contact Loopcom',
  description:
    'Contact Loopcom — request a quote, reach support, or write to us. Loopcom LLC, 33 NY-17M, Suite C, Harriman, NY 10926.',
  crumbs: [['Contact', null]],
  body: `
${pageHead('Contact', 'For pricing, use the quote form &mdash; it asks everything we would otherwise have to email you about.', [['Contact', null]])}

<section><div class="wrap"><div class="split split-top">
  <div>
    <h2 style="margin-bottom:22px">Get in touch</h2>
    <div class="g" style="gap:16px">
      <div class="card"><h4 style="margin-bottom:6px">Sales</h4>
        <p style="font-size:14.5px;margin-bottom:12px">The quote form is the fastest route to a price.</p>
        <a class="btn btn-pri" href="/quote/">Request a Quote</a></div>
      <div class="card"><h4 style="margin-bottom:6px">Existing customers</h4>
        <p style="font-size:14.5px"><a href="mailto:${COMPANY.supportEmail}">${COMPANY.supportEmail}</a><br>
        <span class="num"><a href="tel:${COMPANY.phoneE164}">${COMPANY.phoneDisplay}</a></span></p></div>
      <div class="card"><h4 style="margin-bottom:6px">Post</h4>
        <p style="font-size:14.5px">${COMPANY.legalName}<br>${COMPANY.addressLines.join('<br>')}</p></div>
    </div>
  </div>
  <div><div class="card" style="background:var(--mist)"><h3 style="margin-bottom:14px">Before you write</h3>
    ${checks([
      'For pricing, the <b>quote form</b> collects everything in one go',
      'If a service is down, <b>call us</b> &mdash; it is faster than email',
      'If you are moving numbers across, have a <b>recent bill</b> to hand',
      'If you already own handsets, note the <b>makes and models</b>',
    ])}
  </div></div>
</div></div></section>`,
};
