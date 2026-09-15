# ⛔ AGENT HANDOFF — GOOGLE PLAY STORE: the ORGANIZATION ACCOUNT EXISTS as of 2026-08-29 (Loopcom, ID 4801714522126873799, owner izzy@loopcom.net) and the app is BUILD-READY (signed AAB `loopcom-play-vc100.aab`) — READ FIRST before any Play Console work, before touching Android signing/versioning, or before publishing the next sideload APK

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


- ✅ **vc101 IS LIVE ON PLAY (verified in the console 2026-09-15): Production "Latest release: 101 (1.0.0)", Active, 177 countries, 2 installs; Publishing overview "Last published on September 7, 2026", nothing in review.** So the 09-04 submission was approved and auto-published (managed publishing OFF) on 09-07. ⛔⛔ **BUT THE STORE PAGE STILL SHOWS THE OLD ICON, and that is NOT a stale review — the STORE LISTING ICON IS A SEPARATE 512×512 LISTING ASSET that no app update can ever change.** The listing carries `docs/brand/loopcom/play/play-store-icon-512.png` (built 2026-08-20: the dark circuit-board infinity on black), uploaded 08-30 — it predates the 08-22 Blue 2B refinement and was never re-uploaded. The Blue 2B store icon that matches the launcher is `docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/blue-2b/android-app-icon-512.png` (white infinity on bright blue). **Fix = Main store listing → replace the app icon with the blue-2b 512 → Save → Submit for review** (a listing change reviews like anything else; approval auto-publishes). ⛔ After the swap goes live, the Play Store APP on a phone caches listing art — give it hours/a re-open before calling it stale. ⛔ Also on the release dashboard, unaddressed: **"Restricted foreground service types" — Android 15+ bans BOOT_COMPLETED receivers launching certain FGS types and Google says the app "will crash for users on Android 15"** — plus a deprecated edge-to-edge API warning against 101; both predate this task and neither blocks the icon.
- ⛔⛔ **THE PLAY STORE WENT LIVE WITH AN OLD BUILD (2026-09-04, Izzy: "I was the wrong fucking version") — `loopcom-play-vc100.aab` was BUILT 2026-08-21 06:29 and UPLOADED 2026-08-30 without a rebuild, so Play shipped nine days behind the fleet APK.** It predates every 08-22/08-23 mobile commit: Blue 2B + theme-following launcher, the new login/splash, contact names on calls, the `*`/`#`/`+` dialpad fix, the boot-flash shield, arm64 packaging — and the 08-31 hangup sync. (It also predates the 08-22 answer regression, so answering WORKED on it — old, not broken.) The handoff recorded the FILE NAME and never the commit or build date, so nothing compared the artifact against the fleet. ✅ **`loopcom-play-vc101.aab` BUILT 2026-09-04 06:40 from tip `0580856d`** (55,797,582 bytes, sha256 `84b066ad…fcccad`, `versionCode 101` / `1.0.0` read out of the bundle manifest, signer `O=Loopcom LLC`, armeabi-v7a + arm64-v8a, and — the proof it is new code — the `LauncherNavy`/`LauncherBlue` aliases are in its manifest where vc100 has **0**). ✅✅ **UPLOADED AND SUBMITTED FOR REVIEW 2026-09-04 ~11:15Z from this session, WITHOUT a file-picker click**: the AAB was served from a local CORS server on `127.0.0.1:8123` and assigned to the release page's hidden `input[type=file][accept=.aab]` by page JS (`new File([await (await fetch(url)).blob()])` → `DataTransfer` → `input.files` + `change`); Play uploaded it itself (55.8 MB, ~70 s) and processed it as **101 (1.0.0)**. ⛔ Run that fetch DETACHED (`(async()=>{...})()` storing state on `window`) — an awaited 53 MB fetch times out the extension's 45 s CDP call, and the first attempt's fetch kept running and produced a DUPLICATE upload that read *"Version code 101 has already been used"* (dismiss the errored row, keep the accepted one). Release notes filled, Save → Publishing overview → *Submit 1 change for review* → confirm dialog → **"Changes in review"** (quick checks, ≤12 min; managed publishing OFF, so approval = live). ⛔ Production reads *"Last published on September 4, 2026"* — the vc100 rollout only went live TODAY, which is when Izzy saw the wrong version. ⏳ NOT PROVEN: no phone has installed 101 yet. ⛔ **RULE: never upload a Play AAB whose file date is older than `apps/mobile/ship-proof.json`'s `completedAt` — rebuild first, and record the AAB's COMMIT + sha256 in this file every time.** Next code is **102**.
- ✅✅ **THE PLAY CONSOLE ORGANIZATION ACCOUNT WAS CREATED 2026-08-29** — driven
  end to end in Izzy's real Chrome (⛔ NEVER the in-app browser pane on this
  machine — it crashes Claude Desktop's GPU process, see
  [[claude-desktop-gpu-crash-loop]]; the extension route ran the whole flow with
  zero crashes). Izzy typed the password, ticked the two Terms boxes and paid
  the **$25** himself. **Developer name `Loopcom` (public), organization
  account, Account ID `4801714522126873799`, owner `izzy@loopcom.net`** — the
  console is at `/u/4/` in that Chrome. Details that cost effort:
  **(1)** the signup page adopts whatever Google session is active and the
  signed-in account owns the developer account PERMANENTLY — it first landed on
  `support@connectcomunications.com` and was backed out via
  `accounts.google.com/AddSession`; **(2)** izzy@loopcom.net's **2SV master
  toggle was OFF** (Play refuses without it) — it already had a passkey +
  Google prompt, so flipping the toggle at
  `myaccount.google.com/signinoptions/twosv` took 30 seconds, no code;
  **(3)** the **D-U-N-S `149921594` resolved at Google ONE DAY after
  issuance** — the payments profile pulled `Loopcom LLC, 33 NY-17M Ste C,
  Harriman, NY 10926` straight from D&B, so the 24–48 h propagation fear never
  bit; **(4)** the org CONTACT email must DIFFER from the owner account AND be
  on the website's domain — Izzy created **`info@loopcom.net`** as a free alias
  on his own user in Google Admin and it verified by code minutes later;
  **(5)** public profile = `Loopcom` / `+18457231213` / `izzy@loopcom.net`
  (⛔ support@loopcom.net stays OUT until that mailbox provably exists);
  private contact = Israel Weinstock / info@loopcom.net / his cell
  `+15622096644`; declarations = 1–10 employees, 2–5 apps, **No** earning money
  on Play, **None of the above** categories, **No** other Play Console
  accounts — ⛔ **Firebase/Cloud Console use does NOT count as "other Play
  Console access"**; Izzy almost declared Yes over the FCM/Maps setup.
- ✅ **loopcom.net IS A VERIFIED SEARCH CONSOLE DOMAIN PROPERTY under
  izzy@loopcom.net, and Play's website verification is DONE.** TXT
  `google-site-verification=XyKYtIzs9i_qfbf39AcxEhZpcGe6-0D2HrcdSSfnbKc` was
  added as a Squarespace custom record (Izzy clicked the "Verify to continue
  as support@…" Google gate; ⛔ the form's SAVE button shifts position after
  the first click — re-aim, don't re-type). Play's "Send verification request"
  then verified INSTANTLY because the requester IS the Search Console owner.
  ⛔⛔ **NEVER delete that TXT record** — Search Console ownership dies with it
  and Play's website verification hangs off it.
- ✅✅ **EVERY VERIFICATION COMPLETED THE SAME DAY (2026-08-29) — the account
  is FULLY UNLOCKED and "Create app" is live.** Identity: Izzy's ID upload
  verified within minutes (not the advertised days). Developer phone
  `+18457231213`: Google's code text landed in **Connect's own SMS inbox** and
  was read straight from `ConnectChatMessage` (*"Your Play Console
  verification code is NNNNNN"* — the worker poll had it inside ~2 min); the
  contact phone `+15622096644` Izzy verified himself. ⛔ **That inbox trick is
  the recipe for any future verification of a Connect-hosted number**: query
  `ConnectChatMessage` for `direction='INBOUND'` in the last few minutes —
  columns are `body`/`threadId`, there is NO `fromNumber` column.
- ✅✅ **THE APP IS CREATED AND BUILD 100 (1.0.0) IS LIVE ON INTERNAL TESTING
  (2026-08-30).** App **Loopcom**, app id `4975651109887902716`, package
  `com.connectcommunications.mobile` (⛔ PERMANENT now — first bundle
  uploaded), Free, Play App Signing accepted. `loopcom-play-vc100.aab`
  (81.7 MB → 41.4 MB installed) uploaded by Izzy through the native picker
  (⛔ the Chrome-extension `file_upload` tool caps at 10 MB — an AAB always
  needs his file-dialog click), parsed as **100 (1.0.0), API 24+, target 36**,
  published to Internal testing; track **Active**. Tester list "Loopcom
  internal testers" = izzy@loopcom.net + izzwgg@gmail.com + izzywkg@gmail.com;
  **opt-in link
  `https://play.google.com/apps/internaltest/4701258069997080030`**. The two
  publish warnings were benign (no deobfuscation mapping; testers-not-set,
  fixed same minute).
- ⛔⛔ **A SIDELOADED PHONE CANNOT UPDATE INTO THE PLAY BUILD — the fleet app
  is DEBUG-signed and the Play build is Play-App-Signing-signed.** Installing
  from the opt-in link on a phone carrying the sideloaded Loopcom requires
  UNINSTALLING the sideloaded app first (sign-in is lost and must be redone).
  Izzy's own phone runs the fleet build — warn before he taps Install.
- ✅✅ **THE STORE LISTING IS SAVED AND STORE SETTINGS ARE PUBLISHED
  (2026-08-30).** Default store listing: app name Loopcom, short + full
  descriptions from `PLAY_LISTING.md` verbatim, 512 icon, 1024×500 feature
  graphic, **6 phone screenshots** (order: recents, voicemail, keypad,
  contacts, team, settings — Loopcom Demo tenant, letterboxed to exact 9:16
  1431×2544 on #0C1218), 7-inch and 10-inch tablet slots each carry 2 of the
  same letterboxed shots — saved ("Change saved. Send for review in Publishing
  overview."). Store settings: category **App / Business** saved; contact
  details **info@loopcom.net / +18457231213 / https://www.loopcom.net/**
  — "Save and publish" → **Change published** (contact details go live
  immediately, they do not wait for review).
- ⛔⛔ **HOW IMAGES GET INTO PLAY CONSOLE WITHOUT A FILE DIALOG — the
  CORS-drop technique, proven for all five image slots.** A Chrome-extension
  synthesized click CANNOT open a native file picker (untrusted gesture), and
  `file_upload` caps at 10 MB. What works: run a tiny CORS server on
  `http://127.0.0.1:8123` over the asset folder (`http://127.0.0.1` is a
  trustworthy origin, so the HTTPS page may fetch it), then in page JS fetch
  the file → `File` → `DataTransfer` → dispatch dragenter/dragover/drop on the
  slot's `LOCALIZED-IMAGE-UPLOADER` (debug-ids `icon-uploader`,
  `feature-graphic-uploader`, `phone-screenshot-uploader`,
  `small/regular-tablet-screenshot-uploader`) → the asset side panel opens →
  assign `dt.files` to its hidden `<input type=file>` + fire input/change →
  tick the thumbnail → click the panel's Add. ⛔ **The panel is SCOPED to the
  slot that opened it** — a 1024×500 reads "too small" if the panel was opened
  from the 512×512 icon slot; close and reopen from the right slot's own "Add
  assets". ⛔ Play screenshots must be EXACT 16:9/9:16 — compute the canvas as
  height = multiple of 16, width = h*9/16 (1431×2544), or rounding gives
  0.5624 and a refusal. ⛔ Play takes ONE store icon — there is no light/dark
  pair; the theme-following launcher icon lives in the AAB, not the listing.
- ✅✅ **11 OF 12 APP CONTENT DECLARATIONS ARE DONE (2026-08-30), and the
  TRUE Android screenshots are on the listing.** Saved: privacy policy
  (`https://app.loopcom.net/privacy`), Ads (No), **Sign in details** (Yes
  restricted; reviewer demo `loopcom.review@example.com` + the same password
  Apple's reviewer uses — read it from `/root/.appstoreconnect/asc-demo.mjs`
  on loopcom; accounts created "through employment/enterprise"; full-access
  box ticked), **Content ratings** (IARC: Social or Communication →
  Communication one-on-one, all interaction questions No → all-ages ratings;
  ⛔ the IARC Next button stays DISABLED until you click the form's own
  "Save" first), **Target audience** (18+), Advertising ID (No), Government
  apps (No), Financial features (none), Health (none), **Full-screen intent**
  (making/receiving calls + pre-grant Yes), and **Data safety** (13 types:
  Name/Email/User IDs/Phone [App functionality + Account management], SMS or
  MMS/Other in-app messages/Voice recordings/Crash logs/Diagnostics/Device
  IDs [App functionality], Contacts/Photos/Videos optional; all collected,
  NONE shared — service-provider transfers are exempt; encrypted in transit;
  no in-app account creation but external accounts Yes; delete-data URL = the
  privacy page, whose "Retention and deletion" section qualifies).
  ⛔ The Data safety per-type dialogs STACK if you click every row's Start in
  one pass — process them top-down; the "Collected" checkbox in those dialogs
  only takes a REAL click (JS clicks work for everything else in them).
- ✅✅ **ALL 12 DECLARATIONS ARE DONE AND EVERYTHING IS QUEUED — "Submit 12
  changes for review" is LIVE (2026-08-30).** The Foreground service
  declaration is saved with Izzy's ~60s screen recording (splash → full-screen
  incoming call from Ext 101 → answered call with mic controls → notification
  shade with the Loopcom keepalive notification): **unlisted YouTube video
  `https://www.youtube.com/watch?v=GxAA20WVQ98`** (Shorts link
  `youtube.com/shorts/GxAA20WVQ98` — same video), the SAME url in all three
  fields — Data sync → Network processing "Other", Microphone → "Background
  audio input", Phone call → "VoIP, telecom APIs". ⛔ **The video lives on
  izzwgg@gmail.com's "Peace and love" channel** (izzy@loopcom.net has no
  YouTube session in that Chrome) — fine, any unlisted link satisfies Play; a
  vertical ≤3-min video files under Studio's SHORTS tab, not Videos. ⛔ **A
  first cut of the video (`HDy0Xtv6hFE`) contains content Izzy cut out and is
  set PRIVATE, not deleted — never re-share or re-use that link.** No audio
  track needed — reviewers only need to SEE the permissions in use.
- ⛔⛔ **"SEND FOR REVIEW" WAS STILL LOCKED WITH EVERY DECLARATION DONE — a
  NEW app's review runs through a PRODUCTION RELEASE.** The Publishing
  overview lock ("complete the required steps in the app dashboard") means the
  dashboard's "Create and publish a release" task list, not App content. Done
  2026-08-30: **Countries/regions = ALL countries** on the production track
  (deliberate — login-gated B2B app, and real users open it from abroad:
  B Visible's Philippines employee), then **production release "100 (1.0.0)"
  created from the LIBRARY** (Add from library — never re-upload the AAB; the
  extension tool caps at 10 MB anyway), release notes filled, saved at the
  Preview step (the one warning is the benign no-deobfuscation-mapping one).
  **That unlocked the button.** Nothing is live: saving a release only queues
  it in Publishing overview.
- ✅✅ **SUBMITTED TO GOOGLE FOR REVIEW — 2026-08-30, on Izzy's explicit "I
  wanted to go live right away."** All 12 changes (production release "100
  (1.0.0)" full rollout, 176 countries + rest of world, store listing, every
  App content declaration) sent in one submission; Publishing overview reads
  **"Changes in review"**. Google's dialog: reviews typically complete within
  7 days. ⛔ **Managed publishing is OFF BY IZZY'S CHOICE** — approval means
  the app goes LIVE on Play worldwide automatically, nobody presses anything
  else. Watch "Submission activity" on the Publishing overview for the
  verdict. Internal testers see `com.connectcommunications.mobile
  (unreviewed)` until review completes; ⛔ sideloaded phones still must
  uninstall the debug-signed fleet app before installing from Play.
- ⛔ **The localhost fetch trick works on YouTube Studio too** — same CORS
  server, page-JS fetch → File → assign to the upload dialog's one
  `input[type=file]`; the 7.4 MB mp4 fetched in 67 ms. A first attempt hung
  ("signal is aborted") — transient; a fresh server on a new port worked.
  Studio's stepper is driveable by shadow-walker JS (`ytcp-button` by text,
  `tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"|"UNLISTED"]`).
- ✅ **The phone-screenshot swap is DONE and SAVED** — the 6 chat-pasted
  Android captures were recovered from the SESSION TRANSCRIPT
  (`~/.claude/projects/<proj>/<session>.jsonl`: pasted images live in
  `attachment.prompt[]` records as base64 — NOT in `message.content`),
  letterboxed to exact 9:16 (923×2000 → 1125×2000), and re-attached in order
  recents/voicemail/keypad/contacts/team/settings, plus 2 each on both tablet
  slots. Files: `docs/brand/loopcom/play/shots-android/android-*.png`.
  ⛔ An unsaved Play form dies with its tab — the first swap was lost when
  the tab closed before Save; SAVE THE LISTING before leaving it.
  ⛔ Two Chromes are connected on this machine and the OTHER one's `/u/4/` is
  izzwgg@gmail.com — `switch_browser` and confirm the account chip reads
  Loopcom before any console write.

Full handoff: **`docs/ai-context/AGENT_HANDOFF_GOOGLE_PLAY_STORE_2026-08-20.md`**
(`b338064d`, pushed as merge `c0e0fa55`. No deploy, no migration, no PBX
touch; one live edit to the static `/opt/connectcomms/legal/privacy.html`
on loopcom, backed up.)

- ✅ **The app side is DONE**: Play upload keystore (gitignored,
  `apps/mobile/android/keystore.properties` + `app/play-upload.keystore` —
  ⛔ workstation-only, back them up); `scripts/android-play-bundle.ps1` is the
  ONE Play build (AAB, armeabi-v7a+arm64, `CONNECT_PLAY_SIGNING=1`, small
  monotonic `PLAY_VERSION_CODE` starting at 100); first artifact
  `apps/mobile/dist/loopcom-play-vc100.aab` built + signature-verified.
- ⛔⛔ **Sideload builds KEEP the debug signature ON PURPOSE** — the installed
  fleet carries it; changing it breaks every customer's in-place update. Only
  the Play AAB uses the upload key. Never "fix" `signingConfigs.debug` on the
  release buildType without reading the handoff.
- ✅ **Android is renamed Loopcom** (launcher label + full icon set at all
  densities + `assets/icon.png`), matching iOS. ⛔ The fleet sees the new
  name/icon at its next sideload update — tell Izzy before shipping it.
- ✅ **The privacy policy was NEVER missing** — `https://app.loopcom.net/privacy`
  is a STATIC nginx file (`/opt/connectcomms/legal/privacy.html`, both
  vhosts), updated 2026-08-20 for Play (Google FCM + mic/camera wording).
  ⛔ Curl the live URL before declaring a page missing off the portal tree.
- ✅ Store assets + paste-ready listing copy + every permission-declaration
  answer: `docs/brand/loopcom/play/` (`PLAY_LISTING.md` is the cheat sheet).
- ⛔⛔ **THE LEGAL ENTITY IS `Loopcom LLC`, NOT Connect Communications LLC**
  (Izzy, 2026-08-21). The upload keystore was regenerated as `O=Loopcom LLC`
  and the AAB rebuilt — free to fix then because nothing had been uploaded;
  after the first Play upload that key is locked and needs a Google support
  reset. ⛔ Owner account changed **sms@ → izzy@loopcom.net** once sms@ turned
  out to be the automated SMS↔email bridge mailbox.
- ✅ **The Google prerequisites are CLEARED** (verified in the Admin console
  2026-08-21): **loopcom.net is a SECONDARY DOMAIN** of the
  connectcomunications.com Workspace, **Play Console reads "ON for everyone"**
  org-wide, and 2-step verification is on. ⛔ Admin console URLs need the
  `/u/3/` account index or Chrome falls back to a personal account.
- ✅✅ **THE D-U-N-S ARRIVED 2026-08-28: `149921594`** (D&B case **10876236**,
  tracking **10815203**, resolution *"D-U-N-S Number created — verified through a
  company spokesperson plus outside sources"*). **So the Play Console
  ORGANIZATION account and the Apple personal→organization request are both
  unblocked**, and the two older cases (`DFC-656595` 08-21, `DFC-614186` 07-08)
  are superseded — ⛔ leave them alone; two open applications for one entity is
  itself a manual-review trigger.
  ⚠️ **D&B recorded the legal form as `Corporation` while NY DOS 8001109 says
  DOMESTIC LIMITED LIABILITY COMPANY — inaccurate, and DELIBERATELY NOT BEING
  CORRECTED.** ⛔⛔ **I first filed this as a blocker that would stall a store
  verification. That was asserted without checking what reads the field, and it
  is WRONG.** Apple's own D-U-N-S page states they verify **legal entity name,
  headquarters address and mailing address** — not entity type — and their only
  entity-type requirement is that you ARE a legal entity, listing "corporation,
  limited partnership, or limited liability company" as equally acceptable. The
  LLC fact travels in the NAME (`Loopcom LLC`), which is the field that is
  actually matched. ⛔ It is **not** mere coarse bucketing either — D&B's model
  has a distinct **Limited Liability Company code (18400)** beside Corporation
  (451), so an analyst simply did not use it. **Inaccurate, inconsequential.**
  ⛔ **Do NOT open a correction case to tidy it**: the record is days old and
  still propagating, and a second open case for one entity is itself a
  manual-review trigger. ✅ If a store ever refuses on entity STATUS (Apple's
  wording is *"Your organization is not listed as a legal entity"* — a different
  thing from entity type), the path exists: `support.dnb.com/?CUST=APPLEDEV`
  with the registration documents, and updates reach Apple in ~2 business days.
  ⛔ **It is NOT queryable immediately** — D&B says the data appears in **24–48
  hours**; pasting it into a store form the same evening returns nothing and
  reads like a bad number. ✅ Everything else matches the state record: name
  `Loopcom LLC`, address `33 NY-17M Ste C, Harriman NY 10926` (byte-identical to
  the DOS service-of-process address), start year 2026, principal Israel
  Weinstock, phone 845-723-1213.
- ⛔ **(HISTORY, kept for the reasoning) The whole thing used to wait on that
  number.** ⛔ **One D-U-N-S serves
  BOTH stores** (it is a universal business identifier) — Izzy also wants the
  **Apple account converted personal → organization**, which is **NOT
  self-service**: it is a request at
  `developer.apple.com/contact/request/migrate-individual-account`, needs
  founder + Account Holder + the D-U-N-S, and **migrates the existing account**
  so app `6796392950` and TestFlight survive.
- ⛔ **NUANCE, asked and answered 2026-08-27: "can we START without the D-U-N-S?"
  — for the ORGANIZATION account, NO. It is a required field in the Play Console
  signup form itself, so the account cannot be created at all.** A **PERSONAL**
  account needs no D-U-N-S and can be opened today ($25) — and **personal →
  organization conversion IS supported** (new payments profile of the org type →
  verify → link it), which corrects the "everything waits on the D-U-N-S"
  framing above. ⛔⛔ **But the price is real and permanent for that app:
  personal accounts created after 2023-11-13 must run a closed test with 12
  testers opted in CONTINUOUSLY for 14 days before they may apply for production
  access; ORGANIZATION accounts are exempt and publish straight to production.**
  ⏳ **UNVERIFIED and it is the whole decision: whether converting to
  organization LIFTS that gate, or whether the app stays bound to it.** Do not
  assume it lifts. **Recommendation: wait for the D-U-N-S** — a clean case lands
  in 48–72 h and the 14-day tester clock is longer than the wait it avoids.
- ⚠️ **FOUND 2026-08-27, needs Izzy: there are TWO D&B cases and NO number has
  arrived.** `support@connectcomunications.com` holds an EARLIER case
  **`DFC-614186` (2026-07-08)** whose only mail is a reminder to *"complete and
  submit"* — i.e. it reads as **started and never submitted** — and **nothing at
  all for `DFC-656595`**, which was presumably filed under `izzy@loopcom.net`.
  ⛔ **Check that mailbox before concluding the August case is progressing**, and
  ⛔ **two open applications for one entity is itself a manual-review trigger**.
  ✅ The name risk is settled since — see [[loopcom-llc-registered-name-is-authoritative]].
- ⛔⛔ **`33 NY-17M` IS REJECTED BY ADDRESS AUTOCOMPLETES AND IT IS NOT A BAD
  ADDRESS** — type **`33 Route 17M`**. The hyphenated route shorthand matches
  no postal index and the error reads like the address does not exist.
  Harriman **10926** is correct (matches the FCC/USAC HQ); Monroe 10950 is not.
  SIC filed is **4813 / 48130000 "Telephone communication, except radio"** —
  ⛔ never the `481302xx` sub-codes, which are ISP categories and contradict
  the FCC interconnected-VoIP posture.
- ⛔ **Do NOT quote D&B's 30-business-day SLA as the estimate** — that is the
  outer bound; clean auto-verified cases land in 48–72 h, manual review is
  2–4 weeks. ⏳ **The live risk is the NAME: three spellings are in
  circulation** — USAC says **"LoopCom, LLC"**, the FCC FRN says
  **"loopcom llc."**, the brand is **"Loopcom"** — and "multiple trade names"
  is a documented manual-review trigger while Apple and Google both verify
  their org name against the D-U-N-S record. Nobody has checked which spelling
  is on the actual LLC filing.
- ⚠️ **Customer-facing docs still name the OLD entity and reviewers compare
  them against the developer account**: the live privacy policy says
  *"operated by Connect Communications"* and `billing/pdf.ts` prints
  *"Connect Communications, LLC"* on invoices. ⛔ Deliberately NOT rewritten —
  legal/financial documents, Izzy's call.
- ⏳ **TODO after the account exists**: create the app, upload the AAB to
  Internal testing, screenshots (⛔ from the Loopcom Demo tenant ONLY — a real
  customer's data in a store screenshot is a leak), reviewer demo login (no
  self-signup in the app), Data safety + content rating + foreground-service
  declarations. ⛔ A sideloaded phone can never in-place-update to the Play
  version (different signature) — migrating the fleet is Izzy's call.
