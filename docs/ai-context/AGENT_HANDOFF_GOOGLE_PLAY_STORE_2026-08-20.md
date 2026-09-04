# AGENT HANDOFF — Google Play Store: the app is BUILD-READY (signed AAB exists), the developer account is NOT yet created (2026-08-20)

Izzy, 2026-08-20: *"I want to put the Connect Communications app on the Google
Play Store. Walk me through everything I need to do, and do it in the browser
for me... Also, get the app ready."*

Decisions made by Izzy in-chat (do not re-litigate):
- **Organization account** (not personal — avoids the 12-tester/14-day closed
  test rule for new personal accounts, and shows the business name).
- ⛔⛔ **THE LEGAL ENTITY IS `Loopcom LLC`, NOT Connect Communications LLC**
  (Izzy, 2026-08-21: *"it's not Connect Communications. It's LoopCom"*). This
  is the name that goes on the D-U-N-S record, the Play organization account
  and the Apple organization enrollment — all three are verified against
  official business records and must match exactly. Spelling is **Loopcom**,
  lowercase c, per the standing brand rule.
- ⚠️ **Still inconsistent, needs Izzy's decision:** the live privacy policy
  says *"Loopcom is the business phone app operated by Connect Communications"*
  and `billing/pdf.ts` still prints **"Connect Communications, LLC"** on
  invoice PDFs. A Play/Apple reviewer comparing the developer account name
  against the privacy policy operator can flag the mismatch. Do NOT silently
  rewrite either — they are legal/financial documents.
- ⛔ **Owner account: `izzy@loopcom.net`** — changed 2026-08-21 from
  sms@loopcom.net once it emerged that sms@ is the **automated SMS↔email
  bridge mailbox** (it holds the app-specific password named `loopcom` that
  the bridge polls with). Play developer ownership is effectively permanent,
  so a service mailbox is the wrong owner. ⏳ izzy@loopcom.net needed 2-step
  verification enabling before Google would allow developer signup.
- **The app is named "Loopcom"** on Play AND on the Android launcher — matches
  the iOS rename of 2026-07-30. The package id stays
  `com.connectcommunications.mobile` (permanent once uploaded).

## 1. What is DONE (commit `b338064d`, merged+pushed as `c0e0fa55`)

### The app builds a Play-compliant signed AAB now
- **New upload keystore**: `apps/mobile/android/app/play-upload.keystore`
  (PKCS12, RSA-4096, alias `loopcom-upload`, **CN=Loopcom, O=Loopcom LLC**,
  valid 10,000 days). ⛔ **Regenerated 2026-08-21** — the first key said
  `O=Connect Communications LLC` and Izzy corrected the legal entity to
  **Loopcom LLC**; the superseded key is parked beside it as
  `play-upload.keystore.superseded-connectcomms` and must NEVER be used (it
  was never uploaded to Google, so replacing it was free — after the first
  Play upload the upload key is locked and only a Google support reset can
  change it). Credentials in the gitignored
  `apps/mobile/android/keystore.properties`. Both files exist ONLY on Izzy's
  workstation — ⛔ **back them up**; with Play App Signing the upload key is
  resettable via Google support, so loss is recoverable but painful.
  SHA-256: `23:51:D1:3B:A9:59:AB:88:8B:F8:75:C2:58:93:64:A3:69:B7:4B:4F:F2:5D:4E:DA:CB:8E:5C:E0:68:A8:C9:53`.
  ⛔ The OLD `connect-release.keystore` (password `Connect2026!` committed in
  `gen-keystore.cjs`) was NOT used — treat it as compromised, never use it for Play.
- **`build.gradle` signing is gated on `CONNECT_PLAY_SIGNING=1`**: Play builds
  sign with the upload key; every other release build keeps the historical
  debug signing. ⛔ **THAT IS DELIBERATE, NOT A BUG**: the entire installed
  sideload fleet carries the debug signature, and changing it would break
  `adb install -r` / download-page updates for every customer. A Play build
  with the env var set but no keystore.properties REFUSES (never silently
  debug-signs).
- **Version scheme fork**: `PLAY_VERSION_CODE` / `PLAY_VERSION_NAME` override
  the sideload timestamp scheme for Play builds. Play codes are small and
  monotonic (100, 101, ...). ⛔ Never upload a timestamp-scheme versionCode to
  Play — it burns the 2.1e9 ceiling and wraps (rejects-forever) around 2036.
- **`scripts/android-play-bundle.ps1`** is the ONE sanctioned Play build:
  `powershell -File scripts/android-play-bundle.ps1 -VersionCode 101 -VersionName "1.0.1"`
  Builds `bundleRelease` with **armeabi-v7a + arm64-v8a** (the sideload APK is
  arm64-only on purpose; the AAB adds 32-bit ARM reach), never touches the
  working tree, never installs to a device, copies the AAB to
  `apps/mobile/dist/loopcom-play-vc<code>.aab`.
- **First artifact built and verified**: `apps/mobile/dist/loopcom-play-vc100.aab`
  (77.9 MB, versionCode 100, versionName 1.0.0), `jarsigner -verify` reads
  "Signed by CN=Loopcom, O=Connect Communications LLC" + "jar verified".

### Rebrand + manifest hygiene (affects the NEXT sideload build too)
- Launcher label `Connect` → **`Loopcom`** (`strings.xml` + `app.config.ts`),
  full Loopcom launcher icon set generated at all 5 densities (legacy, round,
  adaptive foreground from `docs/brand/loopcom/app-icons/android-dark-512.png`
  at 85% scale), adaptive `iconBackground` `#1d4ed8` → `#0C1218`,
  `assets/icon.png` → the opaque 1024 Loopcom icon.
  ⛔ The installed fleet shows the new name+icon only after its next sideload
  update — tell Izzy before publishing the next APK, or "my app changed its
  name" becomes a support ticket.
- `android:allowBackup` → `false` (a telephony app holding auth tokens should
  not ride Auto Backup), `READ/WRITE_EXTERNAL_STORAGE` capped
  `maxSdkVersion="32"`.

### Store assets + listing (all in `docs/brand/loopcom/play/`)
- `play-store-icon-512.png` — 512×512 **opaque** (Play rejects alpha; the
  pre-existing `android-*-512.png` files have alpha and must not be used).
- `play-feature-graphic-1024x500.png` — cropped from
  `masters/loopcom-logo-dark.png`, verified visually.
- `PLAY_LISTING.md` — paste-ready app name / short / full description,
  category, declaration cheat-sheet for every sensitive permission, and the
  Data-safety-form summary. ⛔ Read it before filling any Play Console form.

### Privacy policy (was already live — the audit initially missed it)
- **`https://app.loopcom.net/privacy` is a STATIC nginx file**
  (`/opt/connectcomms/legal/privacy.html`, `location = /privacy` on BOTH
  vhosts) — NOT a portal route. Made for the App Store submission 2026-07-30.
- Updated 2026-08-20 for Play: push tokens now say "Apple and Google (Firebase
  Cloud Messaging)", a Microphone-and-camera bullet was added, effective date
  bumped. Backup: `/opt/connectcomms/legal/privacy.html.bak.20260820-playstore`.
  Verified live on both hostnames after the edit.

## 2. THE GOOGLE PREREQUISITES ARE CLEARED — the gate is now the D-U-N-S

**Resolved 2026-08-21, all verified in the Admin console:**
- ⛔ **loopcom.net is a SECONDARY DOMAIN of the connectcomunications.com
  Workspace** — not a separate tenant. Every loopcom.net account is managed
  from that one Admin console. (Admin console URLs need the `/u/3/` account
  index or Chrome silently falls back to a personal account.)
- ✅ **Google Play Console reads "ON for everyone"** org-wide (Apps →
  Additional Google services). The earlier *"Couldn't sign you in — contact
  your domain admin"* wall for sms@loopcom.net is **gone**; do not go hunting
  for a disabled service.
- ✅ **2-step verification** — sms@ already had it ON; **izzy@loopcom.net had
  it OFF and it has since been turned on**. ⛔ Only the user can enable 2SV;
  a Workspace admin cannot do it for them.
- ⏳ Still Izzy-side at handoff: the **$25 one-time fee** and Google's
  organization identity verification (can take days). ⛔ Izzy enters all
  payment and identity data himself — never the agent.

## 2a. THE D-U-N-S APPLICATION IS SUBMITTED (2026-08-21)

**Submitted through D&B's own free flow — case `DFC-656595`** (`dfc.dnb.com`,
`flow=GAD`). my.dnb.com now shows the company as **"(Company pending)"** and
the app tile reads **"Pending – Product Terms Acceptance"**.
⛔ **Apple's faster sponsored route could not be used: developer.apple.com was
in scheduled maintenance** ("We'll be back soon") for the whole session. Apple's
route (~5 business days) is still the better one if a future D-U-N-S is ever
needed; D&B's own is the 30-business-day SLA.

**Exactly what was filed** (so nobody re-derives it, and so a correction can be
matched against it):

| Field | Value |
|---|---|
| Address | **33 Route 17M, Harriman NY 10926** |
| Business phone | +1 (845) 723-1213 |
| Business email | izzy@loopcom.net |
| Website | https://loopcom.net |
| SIC | **48130000 — "Telephone communication, except radio"** (SIC **4813**) |
| Employees / start year | 1 / 2026 |

- ⛔⛔ **THE ADDRESS FIELD REJECTS `33 NY-17M` AND IT IS NOT A BAD ADDRESS.**
  That field is a typeahead against a commercial postal index; the hyphenated
  route shorthand matches nothing and it answers *"No results found / You must
  select a value from the dropdown"*, which reads exactly like "your address
  does not exist". **Type `33 Route 17M`** and it resolves instantly. Expect
  the same trap on any form that autocompletes this address.
- ✅ **Harriman 10926 is CORRECT** and matches the HQ on the FCC/USAC filings
  (`33 NY-17M, Suite C, Harriman, NY 10926` —
  [[loopcom-fcc-frn-and-federal-registrations]]). ⛔ An earlier answer in-chat
  said Monroe 10950; the autocomplete corrected it. **Always reconcile an
  address against the federal filings, not against chat.**
- ⛔ **SIC 4813 was chosen deliberately over the sub-codes.** The dropdown
  offers `48130200 Online service providers` and `48130201 Internet
  connectivity services` — **those are ISP categories and are WRONG for
  Loopcom**, which is registered federally as an *interconnected VoIP
  provider* (i.e. a phone company). Classifying as an ISP would contradict the
  FCC posture.
- ⏳ **UNVERIFIED at handoff: whether "Suite C" made it into the
  Suite/Apartment field, and whether a document was attached.** D&B accepts an
  EIN/TIN confirmation letter, Articles of Organization or a Secretary-of-State
  registration, and attaching one is the single biggest accelerator.

**How long it really takes — do NOT quote the 30-day SLA as the estimate.**
30 business days is the outer bound. A clean auto-verifiable application
commonly lands in **48–72 hours**; anything that trips **manual review** runs
**2–4 weeks**. The named manual-review triggers are mismatched addresses,
**multiple trade names**, and missing documents.
- ✅ Working in Loopcom's favour: US single-location LLC, a verifiable business
  phone, a live website, an EIN, and — unusually strong corroboration — the
  **public FCC record already tying Loopcom LLC to FRN 0038803722 and the EIN**.
- ⛔⛔ **THE ONE REAL RISK IS THE NAME, AND IT IS UNRESOLVED: three spellings
  are in circulation.** USAC Form 499-A says **"LoopCom, LLC"** (capital C,
  comma), the FCC FRN says **"loopcom llc."**, and the brand/store name is
  **"Loopcom"**. "Multiple trade names" is a documented manual-review trigger,
  **and Apple + Google both verify their organization name against the D-U-N-S
  record.** If the case is still pending after ~2 weeks, this is the first
  thing to check. ⏳ Nobody has confirmed which spelling is on the actual LLC
  filing — that is the authoritative one.

## 2b. APPLE IS IN SCOPE TOO — ONE D-U-N-S SERVES BOTH (2026-08-21)

Izzy: *"I'm gonna want to use this DUNS number for Apple as well, so both"* and
*"I want to change my Apple account from personal to an organization as well."*

- ⛔ **A D-U-N-S number is a universal business identifier, NOT vendor-scoped.**
  One registration for **Loopcom LLC** satisfies Google Play organization
  verification AND Apple organization enrollment. Do not request two.
- ✅ **Request it through APPLE's route, not the generic D&B one** —
  `https://developer.apple.com/enroll/duns-lookup/` (Apple ID sign-in
  required). Apple's sponsored path turns a new D-U-N-S around in about
  **5 business days**; D&B's own free request is advertised at **up to 30
  business days**. Same resulting number.
  ⏳ **BLOCKED 2026-08-21: developer.apple.com was in scheduled maintenance**
  ("We'll be back soon") when we tried. Retry; nothing is wrong on our side.
  ⛔ Izzy already searched the D&B lookup for Loopcom and **no existing
  D-U-N-S was found**, so a new one must be requested.
- ⛔⛔ **CONVERTING THE APPLE ACCOUNT IS NOT SELF-SERVICE — there is no button
  in App Store Connect.** Verified against Apple's own docs
  (`developer.apple.com/help/account/membership/updating-your-account-information/`):
  you submit a request at
  **`https://developer.apple.com/contact/request/migrate-individual-account`**.
  Requirements: you must be the **founder/cofounder**, hold the **Account
  Holder** role, supply the **D-U-N-S**, and you may be asked for business
  documents.
- ✅ **Good news: it MIGRATES the existing account rather than creating a new
  one**, so app `6796392950`, the TestFlight builds and the existing tester
  group are not orphaned and no App Transfer is needed.
- ⛔ **Apple does NOT accept a DBA, a fictitious name or a sole
  proprietorship** for an organization account — it must be the legally
  recognized entity, i.e. exactly **Loopcom LLC**.
- **Order matters: D-U-N-S first, then both enrollments in parallel.** Neither
  the Apple migration request nor the Play organization signup can be
  completed without the number in hand.

## 3. What is still TODO after the account exists

- **Create the app** in Play Console (name Loopcom, English US, App, Free) →
  upload `loopcom-play-vc100.aab` to **Internal testing** first.
- **Screenshots** — ⛔ none captured. Minimum 2 phone screenshots. Capture
  from a device signed into the **Loopcom Demo tenant (T102)** — never a real
  customer account (real names/numbers in a store screenshot is a leak).
- **Reviewer demo login** — the app has no self-signup, so App content → App
  access needs working demo credentials (make a dedicated Loopcom Demo user).
- **All the App content declarations** — listed with suggested wording in
  `PLAY_LISTING.md` §Declarations. The foreground-service ones want a short
  demo video (screen recording of an incoming call ringing the app).
- **Data safety form** + content rating questionnaire.
- Decide whether the invite-email link should point at Play once live
  (`ANDROID_APK_DOWNLOAD_PAGE_URL` env override in
  `apps/api/src/androidApkInviteUrl.ts` — the seam already exists).
- ⛔ **Play-vs-sideload signature split is permanent**: a sideloaded phone
  cannot "update" to the Play version in place — it needs an
  uninstall/reinstall (and re-login). Whether/when to migrate the fleet is
  Izzy's product decision, not a technical default.

## 4. Traps this session hit (don't repeat)

- The Explore audit called the privacy policy a hard blocker — it exists as a
  static nginx file the portal tree can't show. **Curl the live URL before
  declaring a page missing.**
- `git push` was rejected (remote ahead) while the shared worktree carried
  another session's in-flight Phase-3 support-console work — a normal merge
  would have collided with their dirty files. Resolved with the
  **private-index merge**: `GIT_INDEX_FILE=... git read-tree -m <base> <mine>
  <origin-tip>` → `write-tree` → `commit-tree -p <mine> -p <origin-tip>` →
  `update-ref` → push. Worktree untouched, both sides' files disjoint.
- The audit's "IOS_WORK_ANDROID_GUARDRAILS.md says the app is on the Play
  Store" claim is WRONG (it never was — that doc means "distributed via
  sideload").

## 5. 2026-09-04 — Play went live with the WRONG (old) build; vc101 built, not yet uploaded

**What happened.** `loopcom-play-vc100.aab` was built **2026-08-21 06:29** (right after
the upload key was regenerated as `O=Loopcom LLC`) and sat on disk. When the Play
Console account unlocked on **2026-08-30**, that same file was uploaded and submitted
as build 100 (1.0.0) **without a rebuild**. Google approved it and, with managed
publishing off, it went live worldwide — nine days behind the fleet APK
(`1.0.0+20260823-175041`, built 2026-08-23).

**What vc100 lacks vs the fleet APK** (every mobile commit 08-22 → 09-03): Blue 2B
launcher + theme-following icon (`4e3655f4`), the new login/splash (`a7eaf8e7`,
`185cd7b7`, `52885e85`), contact names on incoming calls (`57ab7c71`), the `*`/`#`/`+`
dialpad display (`3ac07f1f`), the boot-flash shield (`fca10c32`), the arm64-only
packaging (`097563da`), the 08-31 instant hangup sync (`2e4ebdbb`). It also predates
the 08-22 warm-answer regression (`83a5728c`) and its fix (`8c78b2c0`), so **answering
works on vc100** — it is old, not broken.

**Why nobody caught it.** §2 of this doc and the CLAUDE.md section recorded only the
artifact's FILE NAME, never its commit or build date, so there was nothing to compare
against the fleet build. The fix is procedural and is now written into CLAUDE.md:
**never upload an AAB whose mtime is older than `apps/mobile/ship-proof.json`'s
`completedAt`; rebuild first; record commit + sha256.**

**vc101 — built, verified, NOT uploaded.**

| field | value |
|---|---|
| file | `apps/mobile/dist/loopcom-play-vc101.aab` |
| built | 2026-09-04 06:40 local, `scripts/android-play-bundle.ps1 -VersionCode 101`, 9 m 04 s |
| source | branch tip `0580856d` (`apps/mobile` clean in `git status` before the build) |
| size | 55,797,582 bytes |
| sha256 | `84b066adbea3ea43a83a2ffb5d272440beae2b461dc4f1f89b2bb1774fcfccad` |
| manifest | `versionCode 101`, `versionName 1.0.0` (read from `base/manifest/AndroidManifest.xml`) |
| signer | `CN=Loopcom, O=Loopcom LLC, C=US` (`jarsigner -verify`: jar verified) |
| ABIs | `base/lib/armeabi-v7a`, `base/lib/arm64-v8a` |
| new-code proof | manifest carries `LauncherNavy` ×1 / `LauncherBlue` ×1; vc100's manifest carries **0**; 22 `ic_launcher_navy*` resources present |

**Upload recipe (Izzy, in the Loopcom Chrome `/u/4/`):** Play Console → Loopcom →
Release → Production → **Create new release** → upload `loopcom-play-vc101.aab` through
the native file picker (the extension's `file_upload` caps at 10 MB) → release notes →
Save → Review release → **Start rollout to production**. Internal testing can take the
same bundle "from the library" afterwards. Existing Play installs update automatically
once Google's (usually shorter, post-first-review) check passes. Next version code is
**102**.

⏳ NOT PROVEN: no phone has installed vc101. Acceptance: a Play install shows the Blue
2B icon (Navy in dark theme), the new login, and `*`/`#` on the dialpad.
