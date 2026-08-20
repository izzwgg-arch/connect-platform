# Google Play listing — Loopcom

Working copy for the Play Console store listing. Paste-ready. Keep the character
limits: app name 30, short description 80, full description 4000.

## App name (30 chars max)
Loopcom

## Short description (80 chars max)
Your business phone in your pocket — calls, texts, voicemail, and your team.

## Full description (4000 chars max)

Loopcom puts your company's phone system in your pocket. Make and take calls on
your business number, text customers, hear your voicemail, and reach your
team — from anywhere, on any network.

Loopcom is for businesses using the Loopcom phone platform by Connect
Communications. You sign in with the account your company gives you — there is
no self-service signup in the app.

WHAT YOU CAN DO

• Business calls — make and answer calls on your company phone number, with
  your business caller ID. Your cell number stays private.
• Ring everywhere — calls to your extension ring your desk phone and your
  mobile at the same time. Answer wherever you are.
• Business texting — send and receive SMS and MMS on your business number,
  with shared inboxes your team can work from together.
• Voicemail — listen to voicemail from any device, with visual voicemail
  organized per mailbox.
• Team directory — see your whole company, call a coworker's extension in one
  tap, and transfer calls to anyone.
• Contacts — import the contacts you choose so callers show up by name.
• Works on real-world networks — built to stay reachable on office Wi-Fi,
  filtered internet, and cellular data.

BUILT FOR BUSINESS

Loopcom is the mobile side of a full business phone system: auto-attendants,
ring groups, waiting queues, call recording, conference rooms, and more are
managed by your company's administrator. The app keeps you connected to all
of it.

PERMISSIONS, PLAINLY

Loopcom asks only for what a phone app needs: the microphone to carry your
voice on calls, notifications so your phone rings, and (only if you choose)
your contacts so callers show up by name. We don't sell your information and
we don't use it for advertising. Privacy policy:
https://app.loopcom.net/privacy

NEED HELP?

Your company's Loopcom administrator is the fastest path for account
questions. You can also reach Connect Communications support from inside
the app.

## Category
Business (secondary consideration: Communication — pick Business)

## Contact details (Store listing → Store settings)
- Email: (Izzy to confirm — currently iw5626644@gmail.com on the privacy page)
- Phone: (845) 723-1213
- Website: https://app.loopcom.net

## Graphics
- App icon 512×512 (opaque): docs/brand/loopcom/play/play-store-icon-512.png
- Feature graphic 1024×500: docs/brand/loopcom/play/play-feature-graphic-1024x500.png
- Phone screenshots: MINIMUM 2, up to 8, 16:9 or 9:16, each side 320–3840px.
  ⛔ NOT CAPTURED YET — capture from a device signed into the Loopcom Demo
  tenant (never a real customer's account: real names/numbers in a store
  screenshot is a privacy leak). Suggested screens: dialer, incoming-call
  screen, team directory, chat/SMS inbox, voicemail list.

## App access (review requirement)
The app requires login and has no self-signup, so Play requires demo
credentials for Google's reviewers. Create a dedicated user on the Loopcom
Demo tenant (T102) for this and enter it under App content → App access.

## Declarations to expect (App content section)
- Privacy policy URL: https://app.loopcom.net/privacy
- Data safety form: collects account info (name, email, phone), contacts
  (optional import), audio (voicemail/call audio), messages (SMS), device ids
  (push tokens), diagnostics (call quality). All encrypted in transit; no
  selling; no ads; deletion on request.
- Foreground service permissions: FOREGROUND_SERVICE_PHONE_CALL,
  FOREGROUND_SERVICE_MICROPHONE (calls), FOREGROUND_SERVICE_DATA_SYNC
  (keeping SIP registration alive so calls ring). Each needs a short
  justification and a demo video link.
- USE_FULL_SCREEN_INTENT: incoming-call screen over the lock screen (VoIP
  dialer — an approved use case).
- READ_PHONE_STATE / MANAGE_OWN_CALLS: self-managed calling app.
- Contacts: optional user-initiated import to display caller names.
- SYSTEM_ALERT_WINDOW + REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: reliability of
  incoming call delivery for a business telephony app.
- Content rating questionnaire: business/utility app, no user-generated public
  content, no ads — lands at "Everyone".
