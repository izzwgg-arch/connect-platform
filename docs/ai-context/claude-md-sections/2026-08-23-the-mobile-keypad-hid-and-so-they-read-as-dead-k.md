# ⛔ AGENT HANDOFF — the mobile keypad HID `*`, `#` and `+`, so they read as dead keys (2026-08-23) — READ FIRST for ANY "I can't dial # or *" report, before touching `formatDialDisplay`, before adding ANY formatter between typed input and a dialpad screen, and before chasing DTMF transport on a mobile complaint

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`3ac07f1f` on `feat/ivr-migration-takeover`, pushed. **apps/mobile only — no
server, no api, no portal, no PBX write, no migration, no deploy.**
✅✅ **SHIPPED BOTH PLATFORMS 2026-08-23 on Izzy's explicit "do both"** — fleet
APK **`1.0.0+20260823-132318`, 143,262,679 bytes** (live + smoke-tested on both
hostnames, `publishedAt 2026-08-23T17:32:31Z`) and **iOS build 55** on
TestFlight (EAS `1744f5e5-2f3b-4e71-a74b-59bf173a85a2`, submission finished,
processingState VALID, attached to "Loopcom Testers" — 11 testers — beta review
**APPROVED**). Izzy, 2026-08-23: *"from the iPhone and mobile Android app I'm
not able to dial # or *"*. Memory: [[mobile-keypad-hid-star-hash-and-plus]].
⛔⛔ **THE FLEET BUILD WAS MADE FROM A DELIBERATELY CLEANED TREE, AND THIS IS THE
REUSABLE PART.** The shared worktree carried **another session's uncommitted
splash flash-fix** (`SplashScreen.tsx` + `RootNavigator.tsx`, 85 lines, written
~1 h earlier, locally built at 12:17:51, never committed and never published).
Building as-is would have pushed unproven UI work to every customer's phone
under cover of a dialpad fix. Recipe used: back the files up to the scratchpad
(**plus `git diff HEAD` as a patch**) → `git checkout HEAD -- <paths>` → assert
**`git diff HEAD -- apps/mobile` is EMPTY** → build → publish → confirm the
files are STILL untouched (`git status --short`) before restoring, so a
returning session is never clobbered → restore → verify the line counts match.
⛔ **Do NOT restore their `strings.xml`** — `expo_runtime_version` is a build
artifact that must record the PUBLISHED build, so commit yours instead.
⛔ **The iOS half needed none of this**: `/tmp/connect-ios-build` builds from the
`gh` remote, i.e. committed code only — `grep -c gradientFade` read **0** there,
which is the one-command proof the splash work was absent.

- ⛔⛔ **IT WAS A DISPLAY DEFECT, NOT A DIALING ONE — AND THAT IS WHY IT READ AS
  A DEAD KEY.** `KeypadTab`'s `formatDisplay` built its output from
  `n.replace(/\D/g, '')`, so every non-digit was stripped before it reached the
  screen: **`*` rendered as an EMPTY field**, `*97` as `97`, `#123` as `123`,
  `+` as empty, and `+1347978009` as `134 797 8009` (the `+` dropped and the
  country code regrouped as an area code). The character was always kept in
  state and **always dialled correctly**, so there was no error, no log line and
  nothing to find — just silence on screen. **An invisible keypress is
  indistinguishable from a key that does nothing.**
- ⛔ **Mobile-only, which is exactly why the report named both phones and not the
  desktop.** The portal's `FloatingDialer` renders `phone.dialpadInput` raw;
  only the mobile app ran the typed value through a formatter.
- ✅ **The rule now lives in ONE tested pure module,
  `apps/mobile/src/screens/tabs/dialDisplay.ts`: only an ALL-DIGIT string is
  ever regrouped.** Anything carrying `*`, `#` or a leading `+` renders exactly
  as typed — grouping is wrong for those anyway (`*67`, `*97`, `800…#123` are
  feature codes and post-dial digits, not phone-shaped numbers). ⛔ **Never put
  a `replace(/\D/g, '')` between typed input and a dialpad screen again**; a
  source guard in `dialDisplay.test.ts` fails if one comes back (it strips
  comments first — the doc block deliberately quotes the bad pattern).
- ⛔ **NOTHING DOWNSTREAM WAS EVER AT FAULT — do not re-check these.**
  `normalizeMobileDialTarget` (mobile) and `normalizeOutboundDialTarget`
  (`server.ts`) both preserve `*`/`#`, and `applyInternalOutboundPrefix`
  deliberately refuses to prefix anything starting with `*` or `#`.
- ⛔⛔ **THE IN-CALL DTMF THEORY IS WRONG AND IT IS THE TEMPTING ONE — I chased
  it first, so here is the evidence that closes it.** Every app/WebRTC endpoint
  on the PBX is `dtmf_mode=rfc4733` (33) or `auto` (14) — **zero** are
  `info`/`auto_info` — while **JsSIP's `sendDTMF()` defaults to SIP INFO**, not
  RFC2833. That reads like a guaranteed mismatch. **It is not:** Asterisk 20's
  `res_pjsip_dtmf_info.c` `dtmf_info_incoming_request()` has **no dtmf_mode gate
  at all** (read the source, not the config) — it accepts `application/dtmf` /
  `dtmf-relay` / `hook-flash` unconditionally, and its `get_event()` maps `*`
  and `#` explicitly. **`dtmf_mode` decides what Asterisk SENDS to an endpoint,
  never what it accepts.** JsSIP sends exactly `application/dtmf-relay`,
  `Signal=*`. So in-call `*`/`#` should work and there is no evidence it
  doesn't.
- ⛔ **A latent trap if anyone ever "fixes" DTMF by switching transport:**
  `react-native-webrtc@124.0.7` ships **no DtmfSender** — its own source says
  *"This method is currently missing serializing DtmfSender / TODO: Add
  transport and dtmf fields to the serialized sender."* JsSIP's RFC2833 path
  needs `sender.dtmf`, finds nothing, logs `no local audio track to send DTMF
  with` and **sends nothing, silently**. **SIP INFO is the only DTMF transport
  mobile has.**
- ⛔ **The Asterisk log cannot settle a DTMF question here.** 683 DTMF events on
  2026-08-23 and **none** from an app (`_1`) channel — but only **2** app
  extensions made calls that day, and the PBX keeps **one day** of
  `/var/log/asterisk/full` (there is no `full.1`). Zero is not evidence.
- ⛔ **`apps/mobile` names every test file explicitly in `package.json`** — an
  unregistered test never runs (`mobileOutboundDial.test.ts` and
  `preferOpusSdp.test.ts` are still unregistered today). Registered as
  **`pnpm --filter @connect/mobile test:dial-display`**.
- ✅ **Proven: 10 tests pass; replayed against `HEAD`'s formatter 9 of 20
  assertions FAIL there — and 0 of those failures involve an all-digit input**,
  so ordinary numbers and extensions render byte-identically to before. Mobile
  typecheck **0 errors**.
- ⏳ **NOT PROVEN: nobody has pressed `*` on a phone running this.** It is
  shipped on both platforms but proven only by test and by the published
  artifacts — no human has typed a feature code on a handset carrying it.
  **Acceptance is 30 seconds on one phone**: press `*`, `#` and long-press `0`
  and see each character appear; then the negative that matters, that an
  ordinary 10-digit number still reads `347 978 0090` and an extension still
  reads `101`. ⛔ Android customers get it on their **next install** (the fleet
  turns over gradually — nothing pushes it); iPhone testers get it from
  TestFlight now.
- ⏳ **(SUPERSEDED 2026-08-23 evening)** the uncommitted splash flash-fix this
  bullet described was later WIPED from the shared tree by a checkout; a fresh
  boot-flash fix was built, approved by Izzy live, and published — see the
  dedicated boot-flash section below.
