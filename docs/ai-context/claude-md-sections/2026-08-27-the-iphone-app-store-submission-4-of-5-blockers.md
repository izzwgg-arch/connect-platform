# ⛔⛔ AGENT HANDOFF — the iPhone App Store submission: 4 of 5 blockers CLOSED, only SCREENSHOTS and two web-UI checks remain (2026-08-27) — READ FIRST before any App Store work, before "fixing" the reviewer demo account, before trusting a 200 from the ASC API, or before believing App Privacy can be checked by a script

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.

- ⛔⛔ **2026-09-15: APPLE REJECTED VERSION 1.0.** Submission `f395cee7…` went
  `UNRESOLVED_ISSUES`, the version reads `REJECTED`, two boilerplate emails hit
  iw5626644@gmail.com Sep 14 11:57 PM ET ("Changes needed"). ⛔ **The REASONS are
  only on the App Review page in ASC — the public API does not expose Resolution
  Center (every rejection-ish path 404s; probed, do not re-probe), and Apple's
  emails no longer carry them.** The Default-profile ASC web session is expired
  (login wall), so reading the reasons needs ONE Izzy action: click the Claude
  extension icon in the **jacob** Chrome window (left open on the app's ASC page)
  or sign in to ASC. ⛔ Change NOTHING on the listing or build until the reasons
  are read — a metadata-only rejection is answered WITHOUT a resubmit. Full
  detail + closed-routes list: `IOS_APP_STORE_READINESS.md` §2026-09-15.
  (Also: loopcom's IPv6 to api.appstoreconnect.apple.com is dead — run ASC
  scripts with `NODE_OPTIONS=--dns-result-order=ipv4first`.)


- ⛔⛔ **2026-09-09 STATUS: STILL `WAITING_FOR_REVIEW` AFTER 10.5 DAYS, AND APPLE HAS BEEN SILENT ON
  THE MIGRATION CASE SINCE 09-02.** Read live from the ASC API + Izzy's signed-in Chrome: submission
  `f395cee7…` (08-30 03:12Z) never entered review, Resolution Center holds ZERO messages, 0 ratings
  (**the "one star" is the yellow status badge beside "1.0 Waiting for Review", not a rating**).
  ⛔ **Correction to the 09-02 bullet below: the replacement go-ahead reply WAS sent, with a body,
  09-02 12:50 PM** — it sits as its own conversation in `in:sent`, not in the Apple thread, which is
  why it looked unsent. Membership still reads **Individual**; builds 58/59 processed on 09-06, so the
  migration has not started. Nothing is pending on our side; both queues are Apple's. Next = two
  SENDS needing Izzy's word: reply on case 20000151453845 asking status, and ASC Contact Us → App
  Review status request. ⛔ Do NOT pull the version to resubmit build 59. Full detail: readiness doc
  §2026-09-09. Chrome trap: the Apple session is in profile **"jacob"** — its extension must be
  connected by hand and picked with `select_browser`.

Full state: **`docs/ai-context/IOS_APP_STORE_READINESS.md`**
(**Listing metadata WRITTEN through the App Store Connect API and read back — no
submission, no build, no deploy, no code change, no data change.** Read-only
checklist: `node /root/.appstoreconnect/asc-final.mjs` on loopcom.)
Izzy's decisions, 2026-08-27: **submit under the personal account** (do not wait
for the org migration), **submit build 57**, **move every URL to loopcom.net**.

- ✅ **Far more was already done than anyone remembered.** App **6796392950**,
  version **1.0** has sat in `PREPARE_FOR_SUBMISSION` since 2026-07-30 with a real
  description, keywords, subtitle, Business category, **4+** rating + declaration,
  and **genuinely good review notes** telling the reviewer how to place an inbound
  and an outbound test call. **Check the listing before assuming it is empty.**
- ✅ **FIXED THIS PASS:** support URL → `https://www.loopcom.net/support/`
  (a **real support page** — it pointed at the portal LOGIN screen, which is a
  weak support URL and draws its own rejection), marketing URL →
  `https://www.loopcom.net/`, privacy → `https://app.loopcom.net/privacy`,
  `contentRightsDeclaration` → `DOES_NOT_USE_THIRD_PARTY_CONTENT`, review notes
  rewritten, description rebranded, and **build 35 → build 57** (the attached
  build was four weeks old, predating the CallKit zombie fix, the answer-deadline
  fix, contact names, the icon variants and the rebuilt login/splash).
- ⛔⛔ **THE URL WAS NOT MERELY OLD, IT WAS BROKEN:**
  `https://connectcomunications.com` **fails TLS** — the cert on 31.220.77.60 is
  `CN=www.loopcom.net` (SANs `loopcom.net, www.loopcom.net`), so that hostname is
  not on it; plain HTTP 301s to www.loopcom.net but the stored URL was https, so
  the redirect was never reached. It was the marketing URL **and** the closing
  line of the customer-facing description. Guideline 2.1 rejection, twice over.
- ✅ **The reviewer demo account is REAL — checked, not assumed.**
  `loopcom.review@example.com` is ACTIVE, **has actually signed in** (2026-07-31),
  sits on tenant **Loopcom Demo**, **owns ext 101**, tenant is on the 443 route,
  and the notes' test number **347-978-0090** really maps to `loopcom_demo`.
  ⛔ **The `@example.com` address looks like a placeholder and is not one** —
  Apple never emails it; "fixing" it breaks a working login.
- ⛔ **Encryption + privacy manifest live in the BUILD, not the listing**
  (`ITSAppUsesNonExemptEncryption`, `ios.privacyManifests` in `app.config.ts`).
  Confirmed on the artifact: build 57 carries `usesNonExemptEncryption: false`, so
  export compliance is auto-answered. Do not hunt for these in App Store Connect.
- ✅ **SCREENSHOTS DONE 2026-08-29 — the engineering blocker is closed.** Izzy
  shot six screens on a real iPhone on the Loopcom Demo tenant (verified clean —
  demo people, 555 numbers); resized 1170×2532 → **1290×2796** and uploaded via
  the ASC API (set APP_IPHONE_67 `cd530a7a…`, order Recents / Voicemail / Keypad
  / Contacts / Team / Settings, all `COMPLETE`, read back fresh). Tooling:
  `/root/.appstoreconnect/asc-upload-screenshots.mjs` + `shots/`. `asc-final.mjs`
  now reports the real set count instead of a hardcoded blocker line.
- ⛔⛔ **BLOCKER — THE APP PRIVACY QUESTIONNAIRE CANNOT BE CHECKED BY ANY SCRIPT.**
  `/v1/appDataUsages` and `/v1/appDataUsagesPublishState` both answer **404 "does
  not exist"** — App Privacy is not on the public API at all. **Its state is
  unprovable from here and a green probe means nothing**; somebody must open
  App Store Connect → App Privacy and look. Same for the **Free Apps agreement**,
  which silently blocks submission and appears in no API.
- ⛔⛔ **A 200 FROM THE ASC API IS NOT PROOF THE FIELD CHANGED — AND THE OPPOSITE
  TRAP IS WORSE.** The content-rights PATCH answered **200** and the immediate GET
  read back **null**, which reads exactly like a silently-ignored write; a second
  read showed it HAD landed — Apple has read-after-write lag. **Read back on a
  fresh request before concluding a write failed, or you will "re-fix" something
  that was already correct.**
- ⚠️ **Build 57 has never left the internal group** (external testers have 56; 57
  has no beta review and no external group). Beta review is irrelevant to an App
  Store submission, but the build going to Apple is one **no human has opened**.
  Izzy chose that knowingly.
- ⚠️ **Account deletion (Guideline 5.1.1(v))** applies to apps supporting account
  *creation*; Loopcom is invite-only with no in-app sign-up — the standard
  exemption, and the review notes now say so explicitly.
- ✅✅ **SUBMITTED TO APPLE FOR REVIEW — 2026-08-29 23:12 ET, version 1.0 build 57,
  state `WAITING_FOR_REVIEW` ("1 Item Submitted — up to 48 hours").** The last
  mile was driven in Izzy's own Chrome (the "apple" browser via claude-in-chrome)
  with his explicit "Accept + Submit for review" approval:
  **(1) App Privacy PUBLISHED** — 11 data types (Name, Email, Phone, Contacts,
  Emails/Text Messages, Photos or Videos, Audio Data, User ID, Device ID, Crash
  Data, Performance Data), every one App Functionality only + linked to
  identity + **NO tracking**; **(2)** Apple's NEW **social-media age-rating
  questions** answered (Social Media No, under-13 API No — required for a new
  app since Sept 2026; the 7-step wizard re-confirmed **4+**); **(3) Free Apps
  agreement verified Active** (thru 2027-04-14); **(4)** the **updated Apple
  Developer Program License Agreement was ACCEPTED** (it hard-blocks new-app
  submission; ⛔ the first Agree click silently did nothing — re-done via
  element ref and verified by the banner disappearing on a fresh load);
  **(5) Copyright was EMPTY and failed submission validation** — filled as
  `2026 Loopcom LLC` (⛔ the readiness doc's "✅ metadata done" table never
  covered this field; Add for Review is the only validator that catches it).
- ⚠️ **Two follow-ups seen in passing, neither blocks review:** the developer
  account has **NO card on file for the $99 membership auto-renew** (apps come
  off the store if it lapses), and the **DSA trader verification** for EU
  distribution is unstarted (EU-only consequence).
- ⛔⛔ **2026-09-02: THE REPLY TELLING APPLE TO START THE MIGRATION WENT OUT BLANK.**
  Apple (case 20000151453845, 12:13 PM) wrote back that the 11:44 AM message from
  iw5626644@gmail.com was empty and asked us to reply again. The thread confirms
  it: no body at all. The earlier "verified in the Sent folder" claim was wrong —
  only the prefilled COMPOSE was read, never the SENT message. A replacement reply
  was prefilled the same day (`?view=cm&body=` again, text confirmed on the page).
  ⛔ **A Gmail `body=` prefill can render on screen and still SEND EMPTY** when
  Send is pressed before Gmail's draft model has picked the text up. Rule: click
  into the body, wait for "Draft saved", then Send — and prove a sent email by
  opening it in Sent (or by the other side's acknowledgement), never by reading
  the compose window. Until Apple acknowledges the go-ahead, the migration has
  NOT started; the no-iOS-build rule stands either way.
- ✅ **THE PERSONAL→ORGANIZATION MIGRATION REQUEST WAS SUBMITTED 2026-08-29**
  (D-U-N-S **149921594** arrived 08-28) — Izzy filled + submitted the
  "Individual to Organization Membership Update" form himself via the in-app
  Browser pane: org **Loopcom LLC**, website loopcom.net, founder Yes, DBA No,
  no org membership, Tax ID **None**, plus a note asking to migrate team
  `PR63R6J84J` keeping app 6796392950 + TestFlight. ⛔ **It does NOT block
  submitting the app for review** — the account converts in place; the seller
  name flips Israel Weinstock → Loopcom LLC when it completes. ⚠️ Apple may say
  the D-U-N-S can't be found for a day or two (D&B propagation) — that is not a
  bad number. Full record: `docs/ai-context/IOS_APP_STORE_READINESS.md`.
  ⛔ Browser traps hit filing it: the contact form demands its OWN idmsa
  sign-in (a developer.apple.com session elsewhere does NOT carry over), and
  its element refs GO STALE after any scroll — a stale-ref click landed on
  founder="No" and collapsed the form; re-read refs after every scroll and
  verify each radio by screenshot.
