# ⛔⛔ AGENT HANDOFF — Hanna's first calls: "hangs up on answer" was her cellular uplink, "picture came as a link" is an MMS REGRESSION the Aug-19 identity refactor shipped, and "Weber" was her own iPhone contacts (2026-08-21) — READ FIRST for ANY picture-by-text failure, before adding an env name to a URL chain, before diagnosing a 443-route caller's audio, or before claiming a feature "never worked"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_HANNA_FIRST_CALLS_2026-08-21.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no env change.**
Measured live during her test calls: tcpdump on the PBX, `pjsip show
channelstats` mid-call, the app's own `VoiceDiagEvent` uploads, the Asterisk
log.) Izzy, 2026-08-21: *"I need a full report on what the fuck is going on."*

- ⛔⛔ **PICTURES-BY-TEXT BROKE ON 2026-08-19 — a regression the identity
  refactor shipped, invisible for two days because nobody sent media.**
  ⛔ **The first version of this finding said "never worked, broken since May"
  and Izzy correctly rejected it** — the query counted only fallbacks, never
  successes. Truth: **40 successful MMS sends May–July** (last 07-31), then
  **0 successes and 5 failures in August, all on 08-21** (Fixup Group ×4 +
  Hanna). The mechanism: `6a0f3a01` (08-19) added **`PUBLIC_API_URL`** to the
  worker's `publicBase` chain (`connectChatSmsJob.ts`) — the old chain ended
  in a literal WITH `/api` and never read that name. The variable has sat in
  `.env.platform:34` since ~April as a **bare ORIGIN**, and it reaches **only
  the worker** (api/api_candidate compose blocks override it to empty via
  `${PUBLIC_API_URL:-}`; the worker block has no override, so env_file
  supplies it). Result: media URLs lack `/api` → VoIP.ms fetches the portal's
  **404 HTML** → `invalid_media` → the fallback **texts the customer the same
  dead link** (pre-08-19 fallback links carried `/api` and worked — verified
  from stored May/June rows). ⛔ The 08-19 session verified "changed nothing —
  all six env names unset in the worker" — **its list was missing
  `PUBLIC_API_URL`, the seventh candidate and the set one.** ✅ **FIXED AND
  DEPLOYED 2026-08-23 under Izzy's live go-ahead**: `.env.platform:34` →
  `PUBLIC_API_URL=https://app.loopcom.net/api` (backup kept; loopcom hostname
  verified serving real image bytes first), the derivation guarded in
  `apps/worker/src/smsPublicApiBase.ts` (`17b20ab3` — a pathless base gets
  `/api` appended, 10 tests), worker `done 82363a5c` with the resolver probed
  IN the container printing the loopcom base. ⛔ `PUBLIC_PORTAL_URL` (the
  platform-wide loopcom cut-over) deliberately NOT touched. ⏳ No picture
  sent since — that is the acceptance test. ⛔⛔ **The rule: never claim "X
  never worked" from a failure-only query — count the successes first.**
- ⛔⛔ **"It answered — I heard her — then it just hung up": HER OWN ANSWER'S
  stop-ringing cancel tore down her live call.** ⛔ The first attribution
  ("she hung up", off the `user_hangup` label) was WRONG — that label only
  proves the app's hangup PATH ran, and CallKit-initiated ends ride it too.
  The chain: a cold-start lock-screen answer (`pushToAnswerMs: 0`) connects
  over SIP before the HTTPS **claim** lands on her lossy cellular → the
  invite is still PENDING when telephony reports **`answered_elsewhere`**
  (built for desk-phone answers) → the api cancels it (`server.ts:35153`) and
  pushes INVITE_CANCELED **to the phone that just answered** → the app's
  handler (`NotificationsContext.tsx:~5630`) calls **`endNativeCall`
  unconditionally — no am-I-connected guard** → CallKit end → `sip.hangup()`
  → dead 3–4s after connect, screen reads "Call ended". **Proven by
  correlation with a control**: both dropped answers had `canceledAt` stamped
  the second she connected (one invite was even ACCEPTED 1.1s earlier and
  overridden — the cancel is a read-then-write race on `findMany(PENDING)`);
  the one answer whose claim landed FIRST was never canceled and survived.
  ✅✅ **SERVER FIX BUILT AND DEPLOYED 2026-08-23 (`61c34205`, api
  `deploy-direct` + telephony queue job `1d784a09`, rolled in a verified
  0-active-calls window; both containers verified, AMI/ARI reconnected, 0
  restarts).** Telephony records WHICH channel set `extensionAnsweredAt`
  (`extensionAnsweredChannel`) and sends `answeredEndpoint` with the
  answered-stop payload; the api (`mobileRingAnswerPolicy.ts`) marks an
  invite ACCEPTED with NO push when the answerer is that invite's own app
  device (`T<t>_<ext>_<n>`), and the cancel write is `updateMany` conditioned
  on PENDING with a 0-row skip. ⛔ Desk-phone answers (no device suffix)
  still cancel-push the apps — the original 2026-07-29 feature. 14 tests,
  all 5 source guards fail against pre-fix HEAD. ⛔ `deploy-direct.sh` does
  NOT take `telephony` — queue only. ⏳ NOT PROVEN by a live call; the
  client-side guard (cancel handler re-checks a confirmed session) still
  rides the next TestFlight build.
- ⛔ **"Really broken" audio = her Verizon cellular uplink, measured:** mid-call
  her channel read **39% receive loss / ~500ms RTT** while every other channel
  in the same second read 0% / 26–46ms; a call minutes later was 0%/90ms;
  registration flapped 3× in 12 min. The 15:23 voicemail case: she tapped
  Accept 8s after her socket went Unreachable — the known
  ring-push-with-no-contact gap. ⛔ **Media is DIRECT phone↔PBX on the 443
  route** (tcpdump-proven) — do not blame France for a 443 tenant's audio.
  ⛔ The app's `TURN_missing` RCA verdict is the documented lie.
- ⛔ **PCMU-vs-opus is an AMPLIFIER, not a cause — and only THREE endpoints
  platform-wide have the opus-inbound override** (T5_101_1, T7_102_1,
  T25_101_1 — the July pilot). Trust runs 454 calls on PCMU at ~2% loss,
  essentially no complaints. ⛔ **Landau Home HAD the override and a panel
  Apply silently wiped it** (36 opus inbound calls, then 32 PCMU, conf edit
  gone) — the per-endpoint bake does not survive regeneration; re-check after
  any panel change on a pilot tenant.
- ⛔ **"Comes up as Weber": Connect sends NO caller name** (`fromDisplay:
  null`, PBX `CALLERID(all)= "" <num>`, 0 Connect contacts on the tenant) and
  the app reports handle type `"number"` — **iOS matches it against the
  phone's own address book.** The name on screen is a contact on HER iPhone.
  Check the device's contacts before suspecting a CID leak.
- ✅✅ **THE "DO THEM ALL" NIGHT (2026-08-23, Izzy; iOS build deliberately HELD
  for an icon decision — it goes LAST):** Android APK **1.0.0+20260822-221827
  PUBLISHED** (fleet-live on next installs) carrying the Aug-6 telemetry fixes
  (real platform + networkType) AND three new client fixes (`83a5728c`): both
  INVITE_CANCELED branches guard on `hasConfirmedSipSession()` +
  `answerInviteRef` (a push can never tear down the call this device
  answered), the warm answer path background-claims its invite (3 retries —
  the "claim skipped as an optimisation" hole), and quality reports carry
  `midCallNetworkEvents`/`networkChangedMidCall` (the driving signal). ⛔ The
  APK was built from the shared worktree carrying another session's
  uncommitted screens reorganisation — verified equivalent to the fleet's
  08-21 build layout before publishing, but **diff apps/mobile against HEAD
  before any fleet build from this tree.** And **PBX-side per-call RTP stats**
  (`a9008ac1`): `RtpStatsSampler` (read-only AMI `pjsip show channelstats`,
  active-calls-only, 10s, kill switch `RTP_STATS_SAMPLER_DISABLED=1`) →
  CdrNotifier attach → **`ConnectCdr.rtpStats`** (migration applied) — both
  directions incl. the uplink loss no client can measure. ⛔ The CLI truncates
  channel names; matching is prefix-based and ambiguity matches NOTHING.
  ⛔ The tuner is NOT built — it needs weeks of this data first.
- ✅ **BUILD 53 IS IN FLIGHT (2026-08-23) with Izzy's icon decision** — the
  "Icon refinement options.zip" designs (`a7eaf8e7`, zip archived under
  `docs/brand/loopcom/icon-refinement-2026-08/`): iOS icon **light blue by
  default, Navy as a Settings choice** (`expo-alternate-app-icons`, alternate
  key 'Navy' — ⛔ renaming it orphans devices; ⛔ iOS-gated, bare android/
  never gets the aliases), the login rebuilt to the mockup (**light by
  default, dark only when the phone is dark** — `systemDark || isDark`),
  the splash rebuilt to the mockup (mark springs in, ⛔ **the three dots
  render ONLY while auth is genuinely unresolved past 1.2s**, signed-in-only
  unchanged), iOS native pre-JS splash now a plain navy field. EAS build
  `8e59d172-0741-4111-99db-7f6e96117b14` (ios-prod). Build 53 also carries
  the cancel-guard/claim/telemetry client fixes.
- ✅✅ **BUILD 53 IS ON TESTFLIGHT (2026-08-23 03:40Z): processing VALID,
  attached to "Loopcom Testers", beta review WAITING_FOR_REVIEW** — testers
  get it on Apple's approval. It carries the icon-refinement designs AND the
  cancel-guard/claim/telemetry client fixes, so iPhones (incl. Hanna) close
  the client-side answer race on install.
- ✅✅ **BUILD 54 IS ON TESTFLIGHT (2026-08-23 16:05Z, SUPERSEDES 53): VALID,
  attached to "Loopcom Testers" (204), beta review WAITING_FOR_REVIEW (201).**
  Izzy's ask: *"Make iPhone match the current Android version, everything we
  added in the past two days."* Commit `2dcdbca7` (EAS `f83abd97`, ios-prod)
  = build 53 + the six post-53 mobile commits, all shared RN code that iOS
  picks up untouched: the corrected login (`isDark` only — the phone's dark
  mode no longer darkens it; Welcome DELETED; flexGrow spacers), the themed
  splash with the real light-mode mark and no glow ball, the contact-name
  fixes (ring screen + Recents), and the voicemail tab's white-on-blue ink.
  **One iOS-side change: the native pre-JS splash now follows the SYSTEM
  theme** (`ios.splash` `#f2f7fd` + `dark: #040810` — the exact split
  Android's values/values-night makes) instead of a fixed navy field, so a
  light-theme iPhone no longer flashes navy before the light JS splash.
  ⛔ **The theme-following home-screen ICON stays Android-only ON PURPOSE** —
  iOS pops a system alert on every programmatic icon change, so the Settings
  → App icon row (build 53, key 'Navy') remains the iOS answer; ThemeContext's
  launcher calls are all `Platform.OS !== 'android'`-guarded, verified.
  ⛔ Pipeline correction re-earned: `/tmp/connect-ios-build`'s **`origin` is
  the SERVER CLONE (`/opt/connectcomms/app`), which lags GitHub** — fetching
  it reset the build dir 3 commits behind and `EAS_NO_VCS` would have shipped
  the wrong tree; **fetch the `gh` remote and verify `git log -1` reads your
  exact commit** before any build. ⏳ NOT PROVEN: nobody has opened build 54
  on an iPhone — acceptance is one TestFlight install checking the light
  login/splash, a saved contact's name on an incoming call, and the voicemail
  tab's buttons in light mode.
- ✅✅ **BUILD 56 — THE iPHONE ICON FOLLOWS LIGHT/DARK NOW (2026-08-23,
  `5f68ac0b`).** Izzy: *"on iPhone, the icon is not changing between light mode
  and dark mode."* He was right, and it was never a regression — iOS had ONLY
  the manual Settings row while Android's launcher aliases have followed the
  theme since `4e3655f4`. Fixed with **iOS 18 appearance variants**: `ios.icon`
  is now `{ light: ios-icon-blue, dark: ios-icon-navy }` and **the OS swaps
  them itself, silently**. Both assets already shipped (the navy one IS the
  approved alternate), both 1024×1024 and **alpha 255 everywhere**, so Expo's
  flattening is a no-op — no halo risk.
  ⛔⛔ **THE HONEST DIFFERENCE, AND IT IS PERMANENT: Android follows the IN-APP
  theme; iOS follows the PHONE'S SYSTEM APPEARANCE.** Driving
  `setAlternateAppIcon()` from `ThemeContext` the way Android drives its
  activity-aliases makes iOS **pop a system alert on EVERY toggle**, which is
  why it was never wired that way. The two agree for almost every user but are
  genuinely different mechanisms — **do not "unify" them.**
  ⛔⛔ **A MANUALLY PINNED ALTERNATE OVERRIDES THE VARIANTS — and that is the
  thing most likely to be misreported as "the fix didn't work".** Anyone who
  ever tapped Settings → App icon is pinned to 'Navy' and will see NO automatic
  switching. The row is relabelled **Automatic / Navy** (it read "Light blue",
  which became a lie the moment variants shipped) and **Automatic is the way
  back**. ⛔ Check that row before diagnosing this.
  ✅✅ **PROVEN IN THE GENERATED ARTIFACT, not just the config — `expo prebuild`
  was run on the exact shipped commit and the asset catalog read back.**
  `AppIcon.appiconset/Contents.json` carries TWO entries, the second tagged
  **`appearances: [{ appearance: "luminosity", value: "dark" }]`**, and the
  PNGs match the sources pixel-for-pixel: default corner **(34,167,255)** = the
  blue art, dark corner **(12,19,37)** = the navy art. ⛔ Config resolving and
  a type accepting `dark` prove nothing on their own — `@expo/prebuild-config`'s
  `withIosIcons.js` emitting that entry is what proves it. Typecheck 0.
  ⛔⛔ **AND THE TRAP THAT PROOF CREATES: `expo prebuild` leaves an `ios/`
  DIRECTORY IN THE BUILD CLONE, and `EAS_NO_VCS=1` UPLOADS THE WORKING TREE — so
  a leftover `ios/` rides the NEXT build and can silently override the
  regenerated project.** `ios/` is gitignored, so `git status` stays clean and
  never warns you. **`rm -rf ios` in `/tmp/connect-ios-build/apps/mobile` the
  moment you finish inspecting it** (done here; re-verified absent). ⛔ **No `tinted` variant on purpose** — the only monochrome art
  in the kit is the 24–96px notification silhouette and upscaling it to 1024 is
  mush; iOS derives its own.
  ⛔⛔ **"IT CHANGES ON THE HOME SCREEN BUT NOT IN SIRI SUGGESTIONS" IS AN iOS
  CACHE, NOT OUR BUG — DO NOT GO LOOKING FOR A CODE FIX (Izzy reported it on
  build 56, 2026-08-23, and it is confirmed working elsewhere on his phone).**
  iOS 18 refreshes the Home Screen and App Library immediately while
  **Spotlight and the Siri-suggestion surfaces keep a stale icon**; Apple's own
  developer forum thread describing exactly this
  (<https://developer.apple.com/forums/thread/769188>) has **zero replies and no
  Apple answer**, and there is **no public API to invalidate those caches**.
  Our side is already complete and artifact-proven (both appearance variants in
  the catalog, correct artwork) — **there is nothing to change and nothing to
  build.** ⛔ The only remedies are on the DEVICE: **restart the phone** (most
  reliable, and even that is reported inconsistent), or clear the icon cache by
  toggling Home Screen icon size Large ↔ Normal.
  ⚠️ Related and separate: a **pinned alternate** icon has never been reflected
  in Spotlight/Siri Suggestions at all — a long-standing iOS behaviour. One more
  reason Automatic is the better default.
  ⏳ **NOT PROVEN: nobody has watched the icon change on a real iPhone.** It is
  proven as config + generator + opaque artwork, never on a home screen.
  **Acceptance: install build 56, set Settings → App icon to Automatic, then
  flip the PHONE between light and dark** — the home-screen icon swaps with no
  alert. ⛔ The negative that matters: with the row on **Navy** it must stay
  navy in both, which is the pin working, not a regression.
- ⏳ **Open:** Apple's beta-review approval (automatic notification to
  testers); nobody has seen build 53 on a device; no call has yet exercised
  the deployed answer fix or produced an `rtpStats` row; no picture sent
  through the fixed MMS path yet; Android gets the new login/splash at its
  NEXT APK (tonight's predates them).
