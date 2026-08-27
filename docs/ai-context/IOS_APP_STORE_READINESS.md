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

### 1. ZERO screenshots — the only engineering-side blocker left
`appScreenshotSets` is **empty**. Apple hard-blocks submission without them.
Needs a **real iPhone** signed into the demo account — there is no Mac here, so a
simulator capture is not available.
⛔ **Shoot them on the Loopcom Demo tenant ONLY.** A real customer's call history,
voicemail or messages in a store screenshot is a data leak — the same rule the
Play Store handoff records.
Screens worth capturing: Recents (call history), an active call, Voicemail,
Messages, Contacts/keypad.

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
