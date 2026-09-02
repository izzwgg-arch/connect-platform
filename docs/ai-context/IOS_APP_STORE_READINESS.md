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
