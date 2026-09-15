# iOS App Store Readiness — measured state (2026-08-27)

> Goal: submit the Loopcom iPhone app to the App Store.
> Safety spine: `IOS_WORK_ANDROID_GUARDRAILS.md`.
> **Everything here was READ LIVE from the App Store Connect API**, and the fixes
> below were WRITTEN through it and read back. Re-run before trusting it:
> `node /root/.appstoreconnect/asc-final.mjs` on loopcom (read-only checklist).

App id **6796392950** · bundle `com.connectcommunications.mobile` · SKU
`connectcomms-mobile` · name **Loopcom** · version **1.0**, state
`PREPARE_FOR_SUBMISSION`, release type `AFTER_APPROVAL`.

## Decisions Izzy made 2026-08-27
- **Submit under the personal/individual Apple account** rather than wait for the
  organization migration (D-U-N-S case DFC-656595). ⛔ So the App Store will list
  the seller as **Israel Weinstock**, not Loopcom LLC, until that migration lands
  — and **the migration does not require re-submitting the app.**
- **Submit build 57 straight away** (not 56, which is what testers have).
- **Move every listing URL to loopcom.net.**

---

## ✅ Done — written through the API and read back

| Field | Value |
|---|---|
| description | rewritten, Loopcom-branded, dead URL removed |
| keywords / subtitle | already present ("Business calls & voicemail") |
| support URL | `https://www.loopcom.net/support/` |
| marketing URL | `https://www.loopcom.net/` |
| privacy policy URL | `https://app.loopcom.net/privacy` |
| content rights | `DOES_NOT_USE_THIRD_PARTY_CONTENT` |
| age rating | `FOUR_PLUS`, declaration present |
| category | Business |
| build attached | **57** (was 35, from July) |
| review notes | rewritten; now also states there is no in-app sign-up |

⛔ **Encryption + privacy manifest are in the BUILD, not the listing** —
`ITSAppUsesNonExemptEncryption: false` and `ios.privacyManifests` in
`app.config.ts`. Confirmed on the artifact: build 57 carries
`usesNonExemptEncryption: false`, so export compliance is auto-answered and the
submission will not stop to ask. Do not hunt for these in App Store Connect.

## ✅ The reviewer demo account is REAL and correctly wired — checked, not assumed
`loopcom.review@example.com` is **ACTIVE**, **has actually signed in**
(`lastLoginAt` 2026-07-31), belongs to tenant **Loopcom Demo**
(`cms8yjvth8ctlo4137738yg0n`), **owns extension 101**, and the tenant is on the
**443 SIP route**. The test number in the notes, **347-978-0090**, really maps to
`loopcom_demo` in `PbxTenantInboundDid`.
⛔ **The `@example.com` address looks like a placeholder and is not one** — Apple
never emails it, and changing it breaks a working login.

## ✅ What the URL fix actually repaired
`https://connectcomunications.com` **fails TLS**: the cert on 31.220.77.60 is
`CN=www.loopcom.net` (SANs `loopcom.net, www.loopcom.net`), so that hostname is
not on it; plain HTTP 301s to `https://www.loopcom.net/`, but the stored URL was
https so the redirect was never reached. It was the marketing URL **and** the
closing line of the customer-facing description. Both are gone.
✅ Support now points at a **real support page** (`Support | Loopcom`, 200) rather
than the portal login screen, which is a weak support URL and draws its own
rejection.

---

## ⛔ WHAT STILL BLOCKS THE SUBMIT BUTTON

### 1. ~~ZERO screenshots~~ ✅ DONE 2026-08-29 — six screenshots UPLOADED and COMPLETE
Izzy shot six screens on a real iPhone (1170×2532, iPhone 6.1") signed into the
demo account on the **Loopcom Demo tenant** — all verified clean of customer data
(demo people Alex Morgan / Maya Feldman, 555 numbers). Processed locally to
Apple's **1290×2796** (scale-to-fill + center-crop, aspect delta ~0.15%) and
uploaded through the ASC API from loopcom: set **APP_IPHONE_67**
`cd530a7a-3698-4093-bbe4-9268e695900a` on the en-US version localization, order
**Recents, Voicemail, Keypad, Contacts, Team, Settings**, every one polled to
`assetDeliveryState COMPLETE`, and a fresh read of the checklist confirms 1 set.
- Tooling: `/root/.appstoreconnect/asc-upload-screenshots.mjs` (reserve →
  chunked PUT to `uploadOperations` → PATCH `uploaded:true` + md5 → poll);
  source PNGs kept in `/root/.appstoreconnect/shots/`.
- ⛔ `asc-final.mjs` used to hardcode the screenshots line as `[ ] <-- BLOCKER`;
  fixed 2026-08-29 to report the real set count.
- ⏳ No 6.5" set uploaded — ASC scales the 6.7" set down for smaller devices, so
  one set suffices. An "active call" shot was skipped (needs a live call);
  optional, can be added to the same set later.

### 2. App Privacy questionnaire — UNPROVABLE FROM HERE
⛔⛔ `/v1/appDataUsages` and `/v1/appDataUsagesPublishState` both answer
**404 "does not exist"** — App Privacy is **not on the public App Store Connect
API at all**. **No script can confirm it, and a green probe means nothing.**
Somebody must open App Store Connect → App Privacy and look. It is a hard gate.

### 3. Free Apps agreement — no API either
Must be active under Agreements, Tax, and Banking. An expired agreement silently
blocks submission and shows up nowhere in the API.

### 4. The Submit press itself
Irreversible and outward-facing. Izzy's.

---

## ⚠️ Worth knowing
- **Account deletion (Guideline 5.1.1(v))** applies to apps supporting account
  *creation*. Loopcom is invite-only with no in-app sign-up — the standard
  exemption. The review notes now say so explicitly.
- ⛔ **Build 57 has never left the internal group.** External testers have **56**;
  57 has no beta review and no external group. Beta review is irrelevant to an App
  Store submission, but it does mean **the build going to Apple is one no human
  has opened**. Izzy chose this knowingly.
- ⛔ **A 200 from the ASC API is not proof the field changed.** The content-rights
  PATCH answered 200 and read back `null` on the immediate GET; a second read
  showed it had landed. **Read back twice, or on a fresh request, before
  believing a write failed.**

---

## ✅ 2026-08-29 — the personal→organization MIGRATION REQUEST IS SUBMITTED

Izzy's D-U-N-S arrived (**149921594**, issued 2026-08-28) and the
**Individual to Organization Membership Update** request was filed the next day
at `developer.apple.com/contact/request/migrate-individual-account` — Izzy
signed in (the developer identity displays as "max weiss" / iw5626644@gmail.com
on team `israel weinstock - PR63R6J84J`) and pressed Submit himself; the form
was filled through the in-app Browser pane:

| Field | Value |
|---|---|
| Region | United States |
| Organization Name | **Loopcom LLC** (exact NY DOS 8001109 form) |
| Website | https://www.loopcom.net/ |
| D-U-N-S | **149921594** |
| Founder/co-founder | Yes |
| Uses a DBA/trade name | **No** (no state DBA; "Loopcom" is just the brand) |
| Org holds a membership | No (the individual one is what's being migrated) |
| Tax ID on individual membership | **None** (free app, no paid-app tax forms) |
| Note | NY DOS 8001109 · D-U-N-S issued 2026-08-28 may still be propagating · migrate team PR63R6J84J keeping app 6796392950 + TestFlight |

- ⛔ **The migration does NOT block submitting the app for review** — it converts
  the account in place; the app, listing, TestFlight and an in-flight review all
  survive. Only cosmetic effect: seller shows "Israel Weinstock" until the
  migration completes, then flips to Loopcom LLC.
- ⚠️ Apple may reply that the D-U-N-S cannot be found — that is 24–48h D&B
  propagation (issued 2026-08-28), not a bad number. Retry/answer, don't panic.
- ✅ **2026-09-02 — APPLE ANSWERED: the migration is READY TO START on our word.**
  Developer Support (Natalie, **case 20000151453845**, replying to
  iw5626644@gmail.com) did NOT reject the D-U-N-S; she listed six preconditions
  and said "respond when you're ready to start". Checked against our state:
  (1) 2FA on the Apple Account — Apple already requires it for every developer
  account, and the Account Holder signed in to submit the request; confirm at
  `appleid.apple.com` before replying. (2) Public org website whose domain is
  the org's — `https://www.loopcom.net/` answers **200** and its markup names
  **Loopcom LLC** (verified 2026-09-02). (3) ⛔ **Certificates, Identifiers &
  Profiles is UNAVAILABLE during the migration — an EAS iOS build needs that
  portal for signing, so do NOT start an iOS build (build 58+) until Apple
  confirms the migration finished.** App Store Connect itself stays up, and
  build 57 is still `WAITING_FOR_REVIEW` (4 days in, checked the same day) —
  the review is not blocked. (4) The legal entity name (Loopcom LLC) replaces
  "Israel Weinstock" on the store — the whole point. (5) Sales & Trends history
  lost — irrelevant, the app is free with zero sales. (6) Paid-app earnings /
  bank account — irrelevant, no paid apps, no IAP, no bank account.
  ⛔ **A pre-existing blank stays open and is unrelated to the migration: no card
  on file for the $99 renewal.** ⚠️ The Apple ID's display name is "max weiss"
  while the founder is Israel Weinstock; Apple may ask the Account Holder to
  verify identity — answer with the NY DOS 8001109 filing if they do.
- ✅ **2026-09-02 — WE TOLD APPLE TO START. Izzy sent the reply on case
  20000151453845 from iw5626644@gmail.com** (recipient devprograms@apple.com,
  subject `Re: [20000151453845] Migration to a company account`; body = the six
  points answered + "please go ahead and migrate team PR63R6J84J to Loopcom LLC
  (D-U-N-S 149921594), keeping app 6796392950 and its TestFlight builds").
  ⛔⛔ **THAT MESSAGE WENT OUT BLANK.** Apple (Natalie, 12:13 PM the same day)
  replied: *"The email you sent was a blank message wasn't sure if it was sent on
  accident. If you are ready for the migration to start please reply back."*
  The thread in iw5626644@gmail.com shows the 11:44 AM message from Izzy to
  devprograms with NO body at all. The line that used to stand here — "Verified
  in the mailbox's Sent folder" — was wrong: what was verified was the text in
  the prefilled compose window, not the message that was sent. **The
  `?view=cm&body=` prefill populates the compose box on screen and can still
  send empty** — Gmail's draft model had not picked the text up when Send was
  pressed. A replacement reply (the six points answered + the go-ahead + an
  apology for the blank) was prefilled again on 2026-09-02 ~12:40 ET; this
  time the rule is: **click INTO the body, wait for "Draft saved", THEN Send**,
  and afterwards open the message in Sent and confirm the text is really in it
  (or wait for Apple's acknowledgement) before recording it as sent.
  Two-factor was confirmed ON at
  account.apple.com → Sign-In & Security (1 trusted phone, 1 trusted device).
  ⛔ **From this moment until Apple confirms completion: NO iOS/EAS build** —
  Certificates, Identifiers & Profiles is dark during the migration.
  Build 57 stays in review untouched. ⏳ Watch that inbox for Apple's next
  message (completion, or an identity check on the Account Holder).
  ⛔ Browser trap: a Gmail add-on extension in Izzy's Chrome injects a frame
  into every compose window, and the Claude extension then cannot click, type
  or run JS on that tab ("Cannot access a chrome-extension:// URL of different
  extension") — reads still work. Workaround used: prefill a standalone compose
  via `mail.google.com/mail/u/N/?view=cm&fs=1&to=…&su=…&body=…`, verify the
  text by reading the page, and have Izzy press Send himself.
- ⛔ Browser-driving traps hit: the contact form demands its OWN idmsa sign-in
  (a developer.apple.com session from another tab does NOT carry into it), and
  element refs on this form GO STALE after any scroll — a stale-ref click landed
  on "No" for the founder question and collapsed the whole form. Re-read refs
  after every scroll and verify each radio by screenshot before moving on.

---

## 🎉 2026-08-29 23:12 ET — SUBMITTED TO APPLE FOR REVIEW

Version **1.0, build 57**, state **WAITING_FOR_REVIEW** ("1 Item Submitted — it
can take up to 48 hours"). Driven in Izzy's Chrome with his explicit
"Accept + Submit for review" approval. What the last mile actually took:

1. **App Privacy — filled from scratch and PUBLISHED.** It had never been
   started. Declared 11 data types, all "App Functionality" + "Linked to the
   user's identity" + **no tracking**: Name, Email Address, Phone Number,
   Contacts, Emails or Text Messages, Photos or Videos, Audio Data, User ID,
   Device ID, Crash Data, Performance Data. ⛔ The per-type wizard is 5 modal
   screens × 11 types; modal geometry shifts per type — verify each type ends
   showing "Used for App Functionality / Linked to the user's identity" before
   moving on. Published ("Published a few seconds ago by max weiss").
2. **NEW since the 08-27 audit: social-media age-rating questions** — required
   when submitting a NEW app (banner: answers optional until 2026-09-07
   otherwise). Answered in the 7-step Age Ratings wizard: Social Media **No**
   (no feed/redistribution), "Social Media Disabled for Users Under 13" **No**
   (we don't implement the Declared Age Range API; no social features exist).
   Everything else was pre-filled; calculated rating stayed **4+**.
3. **Free Apps agreement: Active** (Jun 21 2026 – Apr 14 2027) — verified, no
   action needed.
4. **The updated Apple Developer Program License Agreement HARD-BLOCKED
   submission** ("to submit new apps, the Account Holder must review and
   accept"). Accepted at developer.apple.com/account. ⛔ **The first Agree
   click silently did nothing** — the banner survived a fresh page load; the
   second attempt clicked the button by element ref and the banner disappeared.
   Verify acceptance by the banner's absence on a re-navigate, never by the
   click having happened.
5. **Copyright was EMPTY and failed "Add for Review" validation** — the one
   field the metadata pass missed (it's on the version page, not appInfo).
   Filled: `2026 Loopcom LLC`. ⛔ Add for Review is the only validator that
   catches version-page gaps; run it expecting a red box, fix, re-press.
6. **Add for Review → Draft Submission → Submit for Review** → ✅
   "1 Item Submitted".

**Icon note:** the App Store icon ships inside build 57's asset catalog (the
Blue 2B refinement with light/dark variants) — nothing to change in the listing.

### ⚠️ Follow-ups spotted (neither blocks review)
- **No credit/debit card on the Apple account for the $99 membership
  auto-renew** — if the membership lapses the apps come off the store.
- **DSA trader verification unstarted** (Business → Agreements banner) — EU
  distribution consequence only.
- The **org migration** (Loopcom LLC) rides in parallel; seller name flips
  after it completes. Review proceeds under Israel Weinstock.

## ⛔ 2026-09-09 — STILL WAITING FOR REVIEW AFTER 10.5 DAYS; MIGRATION GO-AHEAD WAS SENT (WITH A BODY) AND APPLE HAS BEEN SILENT SINCE 2026-09-02

Read live 2026-09-09 (ASC API from loopcom + Izzy's own signed-in Chrome, profile
"jacob" / Gmail account #5 = iw5626644@gmail.com). **Read-only — nothing sent,
nothing changed.**

- **Review:** version 1.0 / build 57 is `WAITING_FOR_REVIEW`; review submission
  `f395cee7-6db2-4abf-9aa6-26aa43d8125c` submitted 2026-08-30T03:12Z, its one item
  `READY_FOR_REVIEW`. ASC → App Review (Resolution Center) lists that ONE
  submission and **no message from Apple**. No rejection, never entered
  `IN_REVIEW`. Apple's own submission email: "up to 48 hours". 0 customer
  reviews / 0 ratings — the app is not live, so **the "one star" Izzy saw is the
  yellow status badge beside "1.0 Waiting for Review" in the ASC sidebar, not a
  rating.**
- **Migration case 20000151453845:** the replacement go-ahead **WAS sent, with a
  body, 2026-09-02 12:50 PM** ("Apologies - my previous reply went out blank…
  Yes, please start the migration now. Please migrate my individual membership
  (team PR63R6J84J) to the organization…"). ⛔ It shows as a SEPARATE
  conversation in Gmail (the Apple thread still lists only Natalie/blank/Natalie),
  which is why it reads as unsent from the inbox view — check `in:sent`.
  **Apple has not replied since** (7 days). `developer.apple.com/account` →
  Membership details still reads **Enrolled as: Individual**, renewal
  2027-04-14, no card on file (banner). Builds 58/59 uploaded + processed VALID
  on 09-06, so Certificates & Profiles was NOT dark — the migration has not
  started on Apple's side.
- **Both Apple-side queues are stalled together** (review untouched since 08-30,
  migration case unanswered since 09-02). Whether one holds the other is Apple's
  to say; nothing on our side is pending.
- **Next (both are sends, need Izzy's word):** (1) reply on case 20000151453845
  asking for the migration status and whether it is holding App Review;
  (2) ASC → Contact Us → App Review → ask for a status on the 08-30 submission
  (10+ days, no contact). ⛔ Do NOT remove the version from review to resubmit
  build 59 — that puts it at the back of the queue with no explanation gained.
- Chrome note: only one Chrome profile has its Claude extension connected at a
  time; the Apple session lives in profile **"jacob"** (`Profile 2`, avatar
  "J"), the default extension connection is profile "Iz". Izzy must click the
  extension icon in the jacob window to connect it (`list_connected_browsers`
  then shows it as a second browser; pick it via `select_browser`).

## ⛔⛔ 2026-09-15 — APPLE REJECTED VERSION 1.0 (submission f395cee7), AND THE REASONS ARE UNREACHABLE WITHOUT A HUMAN CLICK

Read live 2026-09-15 ~04:00 ET (ASC API from loopcom + the iw5626644 Gmail at
`/mail/u/5/` in the Default "Iz" Chrome profile). **Read-only — nothing sent,
nothing changed on Apple's side.**

- **The facts:** version 1.0 `appStoreState = REJECTED` / `appVersionState =
  REJECTED`; review submission `f395cee7-6db2-4abf-9aa6-26aa43d8125c` state
  `UNRESOLVED_ISSUES`, its single item (the app version) `REJECTED`,
  `lastUpdatedByActor = APPLE`. Two emails landed at iw5626644@gmail.com
  **Mon Sep 14, 11:57 PM ET**: "Your App Review Feedback — Changes needed" and
  "There's an issue with your Loopcom (iOS) submission." (addressed to
  "max" — the ASC user is max weiss). ⛔ **Both emails are BOILERPLATE.** Apple
  no longer puts rejection reasons in email; they say only "go to the App
  Review page in App Store Connect" and note "there may be more than one
  reason" and that metadata-only fixes don't need a re-submit.
- ⛔⛔ **The rejection REASONS are only on the App Review (Resolution Center)
  page, which the public ASC API does NOT expose.** Probed 2026-09-15, all
  404 PATH_ERROR: `resolutionCenterThreads` (bare, by app, by submission),
  `resolutionCenterMessages`, `reviewRejections`, `rejectionReasons`,
  `reviewSubmissions/{id}/messages`. `appStoreReviewDetails?filter` is 403.
  A full-include read of the submission returns states only. **Do not burn
  time re-probing; the API will not say WHY.**
- ⛔ **Every non-human route to the page was tried and is closed:** the Default
  ("Iz") profile's ASC web session is EXPIRED (`/login?…authResult=FAILED` →
  password field; entering credentials is prohibited); the jacob profile's
  Claude extension connects only via a manual click on the extension icon
  (launching `chrome.exe --profile-directory="Profile 2"` does NOT connect
  it); computer-use browser grants are read-only and the grant dialog cannot
  be raised from a non-interactive session; Control_Chrome MCP is
  macOS-only (osascript). The rejection emails were read at Gmail `/mail/u/5/`
  (iw5626644 IS signed into Google there — it's only the APPLE session that
  lives in jacob).
- **What was left staged:** a jacob-profile Chrome window open at
  `appstoreconnect.apple.com/apps/6796392950/distribution/ios/version/inflight`.
  **Next = ONE Izzy action:** click the Claude extension icon in that jacob
  window (connect it), or sign in to ASC in any connected profile — then read
  App Review → the rejection message(s), fix each named issue, and reply /
  resubmit from there.
- ⛔ Until the reasons are read, **change NOTHING on the listing or the build**
  — "fix" without the reason list is guessing, and a metadata-only rejection
  is answered from the App Review page without a new submission.
- Probe scripts kept on loopcom: `/root/.appstoreconnect/asc-rejection.mjs`
  (+ `asc-probe-rc.mjs`, `asc-probe-includes.mjs`). ⛔ Node on loopcom needs
  `NODE_OPTIONS=--dns-result-order=ipv4first` for api.appstoreconnect.apple.com
  now — the box's IPv6 route to Apple is dead and default-order fetch times out.

## ⛔ 2026-09-15 — THE REJECTION MESSAGE, READ IN FULL (submission f395cee7, reviewed on iPad Air 11" M3, ver 1.0 build 57)

Three separate issues. Only ONE needs a code/binary change:

1. **Guideline 5.1.1(ii) — Privacy, purpose strings (THE ONLY CODE FIX).**
   The photo-library and location purpose strings were expo-image-picker /
   expo-location's GENERIC auto-plugin defaults ("Allow Loopcom to access your
   photos" / "…use your location"). ✅ FIXED in `apps/mobile/app.config.ts`
   commit `db20a0a8` (branch feat/ivr-migration-takeover): explicit
   `NSPhotoLibraryUsageDescription`, `NSLocationWhenInUseUsageDescription`,
   `NSLocationAlwaysAndWhenInUseUsageDescription` set in `ios.infoPlist`, each
   describing the real use + a concrete example. `buildNumber` bumped 59→60.
   ⛔ **In the BINARY → a new build (60) MUST be built and attached.** Verified
   with `expo config --type prebuild --json` that the explicit strings resolve
   (they win over the plugin default per `@expo/config-plugins`
   `ios/Permissions.js` line 32: `passed || existing || default`).
   iOS-only surface (guardrails §2) — the change is entirely inside the `ios:`
   block and cannot touch Android.
2. **Guideline 2.1 — "Which is (are) the salable storefront(s)? Please update
   at the App Store Connect."** METADATA ONLY, no new build. The app's
   territory availability is not configured (ASC API: `appAvailabilityV2`
   returns 404 NOT_FOUND for the app, and the price schedule has baseTerritory
   USA with one manual price). Fix in **ASC → app → Pricing and Availability
   (Availability section) → tick the storefront(s) the app is sold in** (at
   least United States). Reviewer can't tell where it's salable.
3. **Guideline 2.1(b) — business model questions.** A written REPLY, no code
   change. Apple wants to confirm the paid-content model. Loopcom is a B2B VoIP
   service: employees are invited by the business that subscribes; the service
   is billed to the business OUTSIDE the app (web portal / Sola-Cardknox); no
   in-app purchase, no in-app sign-up, no consumer digital content. Draft reply
   below answers all six questions.

### ⛔ DRAFTED REPLY TO APPLE (paste into ASC → App Review → Reply; Izzy must send — sending needs his OK and his signed-in session)

> Hello, thank you for the review. Responses below, plus the fixes we've made.
>
> **Guideline 5.1.1(ii) — purpose strings.** Fixed in the next build (v1.0,
> build 60). The photo-library and location prompts now describe the specific
> use and give an example: the photo library is accessed only when a user
> chooses to attach a photo or video to a message (e.g. sending a customer a
> picture of a finished job in a chat), and location is used only while a user
> is actively working a delivery route so the business can show customers an
> accurate arrival time (e.g. updating the live delivery map as the driver
> approaches a stop). Location is not used when the user is off a route.
>
> **Guideline 2.1 — salable storefronts.** We have updated Pricing and
> Availability so the app is available in the United States. [Izzy: adjust the
> country list here to match what you actually set.]
>
> **Guideline 2.1(b) — business model.**
> 1. *Who uses the paid content/services?* Employees of businesses that
>    subscribe to Loopcom's phone service. Loopcom is a business (B2B) VoIP
>    phone system; the app is the softphone client the business's staff use to
>    place and receive the company's calls, voicemail, texts and team chat.
> 2. *Where are the services purchased?* The phone service is sold by Loopcom
>    directly to the business, outside the app, via a signed service
>    arrangement and the web billing portal. Nothing is sold inside the app.
> 3. *What previously-purchased services can a user access in the app?* The
>    business communication features the company already pays Loopcom for:
>    inbound/outbound business calls, voicemail, SMS/MMS, and internal team
>    chat/contacts for that company's phone system.
> 4. *What paid features are unlocked in-app without In-App Purchase?* None are
>    sold or unlocked in the app. The app is a client for a service the
>    business buys from Loopcom directly; there is no in-app purchase and no
>    paywall.
> 5. *Are the enterprise services sold to single users, consumers, or family?*
>    They are sold to businesses (companies), not to individual consumers or
>    for family use. This is an enterprise/B2B service.
> 6. *How do users get an account? Is there a fee to create one?* Accounts are
>    created only by invitation from the subscribing business's administrator.
>    There is no public/in-app sign-up and the end user pays no fee to create
>    or use their account — the business pays Loopcom for the service.
>
> Happy to hop on a call if that's easier. Thank you.

### ✅ 2026-09-15 (second pass, Izzy's go): API-SIDE FIXES DONE, BUILD HELD ON THE GOOGLE-AUTH MOCKUP DECISION
- ✅ **Storefront (2.1) FIXED AT THE SOURCE**: `POST /v2/appAvailabilities` 201 —
  USA available, all other 174 territories false, `availableInNewTerritories:
  false`; verified by fresh read-back (`AVAILABLE_FOR_SALE_UNRELEASED_APP`).
  ⛔ The v2 create DEMANDS an entry for EVERY territory (175) with temp-id
  `${XXX}` + included `territories` relationships — a USA-only payload 409s
  listing the missing ones. Script: `/root/.appstoreconnect/asc-set-availability2.mjs`.
  ⛔ "Salable storefront" = the COUNTRY App Store, not prices — a free app
  qualifies; no price display needed; billing stays on loopcom.net.
- ✅ **Review notes hardened**: appended BUSINESS MODEL (all six 2.1(b) answers),
  PERMISSIONS (5.1.1 fix note), STOREFRONT (US-only) to appStoreReviewDetail
  `165cb89c…` (PATCH 200, read back, 2229 chars). The resubmission now answers
  2.1(b) even before any Resolution Center reply.
- ✅ **Demo account proven live BY THE REVIEWER**: `loopcom.review@example.com`
  ACTIVE, `lastLoginAt` **2026-09-15 03:51** — the Apple reviewer signed in with
  it during this very review. No completeness risk there.
- ✅ **Android parity verified**: no `apps/mobile` commits exist in origin/main
  or feat/ai-agent that aren't in HEAD; the Sep-6 fleet APK's commits are all in
  this branch → iOS build 60 from HEAD is a strict superset of the Android build.
- ✅ **supportsTablet: false** (iPad reviews run iPhone-compatibility mode) and
  **no third-party login in the mobile app today** (no 4.8 exposure in build 60
  as-is).
- ⏳ **BUILD 60 HELD on Izzy's mockup decision.** Izzy asked for Google Auth in
  the build AND a mockup first. Mockup published:
  **https://claude.ai/artifact/6kc9wk6iD52HxwoadLuauW** — faithful shipped
  screen + "Continue with Apple" + "Continue with Google" (login-only), with the
  ⛔ Guideline 4.8 warning: Google login REQUIRES Sign in with Apple alongside
  it, so Google-only is an auto-rejection. Option A = build now with just the
  fixes, auth in 1.1 (fastest approval). Option B = wire Google+Apple first
  (app + server token exchange + invite-only matching), then build.
- EAS is authenticated on Izzy's Windows machine too (`izz8457`, verified via
  `npx eas-cli whoami` in apps/mobile) — the build can be kicked from either
  machine once he decides.

### ⛔ REMAINING HUMAN STEPS TO RESUBMIT (all need Izzy)
1. **Build 60.** Build the iOS binary from commit `db20a0a8` (recipe in
   `ios-testflight-pipeline-state` memory / this doc: loopcom, checkout the
   pushed commit, `npx --yes eas-cli build -p ios --profile ios-prod
   --non-interactive --no-wait --json` from `apps/mobile`, then
   `eas-cli submit --id <build>`). EAS session on loopcom = user `izz8457`
   (`~/.expo/state.json`). ⛔ Guardrails §4: a human runs the Android
   cold-call smoke test before an iOS build ships — the change is iOS-only so
   Android can't regress, but do the smoke test anyway.
2. **Availability (2.1):** ASC → Pricing and Availability → set the storefront(s).
3. **Reply (2.1b + confirmations):** paste the draft above into App Review → Reply.
   ⛔ Sending a message on Izzy's behalf needs his explicit OK.
4. **Attach build 60** to the version, then **Resubmit to App Review**.
   (Apple's email: metadata-only issues don't need a resubmit, but 5.1.1 is a
   binary fix, so a resubmit with build 60 IS required.)
⛔ The purpose strings show in the iOS permission dialogs the CUSTOMER sees —
Izzy should read the three strings in `app.config.ts` (commit db20a0a8) and
tweak wording before build 60 bakes them in.
