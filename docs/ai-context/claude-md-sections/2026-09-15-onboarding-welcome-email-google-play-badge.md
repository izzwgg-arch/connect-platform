# ⛔ AGENT HANDOFF — the welcome/invite email offers GOOGLE PLAY, not the APK (2026-09-15) — ✅ BUILT, DEPLOYED and container-verified; ⏳ NOT PROVEN in a real inbox

**Status: ✅ DEPLOYED. api + portal both on `66eb7096`, 0 restarts, the deployed
container builds the badge email, the badge serves 200 on both hostnames.
⏳ NOT PROVEN: no invitation has been SENT since. Nobody has opened one.**

Read this together with
`docs/ai-context/claude-md-sections/2026-08-09-the-apk-link-was-missing-from-sign-up-invitation.md`
and its full handoff `docs/ai-context/AGENT_HANDOFF_INVITE_APK_LINK_2026-08-09.md`
— that is where the two-paths trap this change closes for good is recorded.

## What Izzy asked for

> "https://play.google.com/store/apps/details?id=com.connectcommunications.mobile
> in the onboarding welcome email, right now there is the download APK button.
> Replace it with the real Google Play tag. When you press on it, it opens
> Google Play."

then, before the build: *"Show me what it's going to look like before you build …
I want to see the real onboarding email mockup, and instead of the download APK,
the Google Play symbol."* Mockup shown → **"go"**.

## The two open decisions, and how they were called

Izzy said "go" without answering them, so these were taken as judgment calls and
told to him plainly. **Revisit them here if he wants them the other way:**

1. **Badge only** — no text fallback line underneath. It is what Google's brand
   guidelines want and what he approved in the mockup. The cost is real and
   documented below: image-blocking clients show only the alt text.
2. **The Play listing is the link, with `ANDROID_PLAY_STORE_URL` as an override
   that defaults to it.** Unset — the normal state — it IS the listing, so
   nothing needs configuring; the env var exists only as a swing lever for the
   day the listing has to move (a pulled build, a relisted package).

## What shipped

Commit `cca408dc`, merged to origin as **`66eb7096`**.

- **`apps/api/src/userEmailTemplates.ts`**
  - new `GOOGLE_PLAY_LISTING_URL` + `googlePlayListingUrl()` (env override → constant)
  - new `googlePlayBadgeUrl()` → `${canonicalPortalOrigin()}/brand/google-play/get-it-on-google-play.png`
  - `lcSecondaryButton()` (the outlined APK button) **replaced** by `lcPlayStoreBadge()`
  - `androidSection` is **unconditional** now, and `androidApkUrl` is **gone from
    the input type**
  - copy: "…Get it free from Google Play." The sideload note ("Android may ask
    you to allow installs from this source") is **deleted** — wrong next to Play
  - plain-text half carries the same listing URL
- **`apps/api/src/androidApkInviteUrl.ts`** — `getAndroidApkUrlForInviteEmail()`
  **deleted**; its only purpose was this email. `apkDownloadDir()`,
  `apkPublicBaseUrl()`, `androidApkDownloadPageUrl()` and `APK_LATEST_FILENAME`
  stay — the sideload route still uses them.
- **`server.ts`** and **`onboarding/setupOrchestrator.ts`** — both stop resolving
  and passing an Android URL entirely.
- **`apps/portal/public/brand/google-play/get-it-on-google-play.png`** — Google's
  unmodified 646×250 `en_badge_web_generic.png`, 4,904 bytes.

## ⛔ THE STRUCTURAL POINT — this is what actually fixes the 2026-08-09 class

The old block was conditional on an `androidApkUrl` **the caller supplied**, and
ONE caller passing `null` is exactly how the link vanished from every
self-service sign-up while admin invites were fine. The fix is not "pass it from
both places correctly" — it is that **the template resolves both URLs itself, at
call time, and accepts nothing**. Same rule already written on `brandLogoUrl()`.
⛔ **Never reintroduce an Android URL as an input of `welcomeCreatePasswordEmail`.**
A guard test fails if anyone does.

## Markup details that are load-bearing — do not "tidy" these

- `width="180" height="70"` are **ATTRIBUTES as well as CSS**. Outlook's Word
  engine ignores the style and would draw the image at its natural 646px,
  blowing the 600px card apart. 180×70 holds the 646:250 ratio exactly.
- `line-height:0;font-size:0` on the `<td>` kills the phantom descender gap
  Outlook and Gmail add under an image in a table cell.
- ⛔ The badge asset's transparent margin **IS** the clear space Google's
  guidelines require. Never crop, recolour or redraw it.
- ⛔ The badge must be served by US, absolute https. Mail clients cannot read a
  relative path or a `data:` URI, and Google's CDN is not a supportable hotlink
  target (it 403s without the right Referer — never forge one).

## Proof

- **api + portal `.build-commit` = `66eb7096c6f96bcfed71682d520bbe8fe73d0ff9`,
  0 restarts, both running.**
- **The DEPLOYED container builds it** — `welcomeCreatePasswordEmail()` executed
  inside `app-api-1` emits the badge `<img>` linked to the listing, and the
  plain-text half carries the URL. Not a grep: the real function, in the real
  container, with its own env (it resolved the badge to
  `https://app.connectcomunications.com/brand/google-play/…`, the canonical
  origin). Temp file removed afterwards.
- **Badge serves `200`, `4904` bytes, `image/png` on BOTH hostnames**
  (`app.loopcom.net` and `app.connectcomunications.com`).
- **`/api/mobile/android/download` still `200`** — the APK is not withdrawn.
- **Tests:** `apps/api` top-level 1,423 tests, **1,414 pass, 9 fail**. ⛔ All 9
  are PRE-EXISTING and unrelated: 7 × `syncPbxTenantDirectoryFromRows`, the
  schema transposition-trap test, and a `publicOrigins` check that flags a
  hostname literal present in `server.ts` **at HEAD** (verified by reading
  HEAD's copy). `onboarding/setupOrchestrator.test.ts` also fails wholesale on
  `resolvePbxRouteHelperConfig is not a function`, introduced by `1c1d067e`
  (another session's PBX-mirror work) — the test never mocks that module.
  **Zero type errors in any file this change touched** (the repo has 87
  pre-existing api type errors elsewhere).

## ⏳ NOT PROVEN — what is still owed

⛔ **No invitation has been sent since the deploy, and no one has opened one in a
real client.** Everything above is the code path plus live 200s. In particular
**Outlook's Word engine has never rendered this badge** — that is the one thing
the renders cannot tell you.

**To close it** (the 2026-08-09 method, which is the only one that ever caught
this class): invite a spare address, then query the last `USER_INVITE`
`EmailJob` bodies and check that **both** paths — admin invite AND self-service
sign-up — carry `play.google.com/store/apps/details?id=com.connectcommunications.mobile`.
Reading the template proves nothing; the defect last time was a caller.

## Images-off: the one thing this costs, by design

Outlook and some Gmail accounts hide images until the reader clicks "download
pictures". The badge is an image, so those readers see the alt text
"Get it on Google Play" — still inside the `<a>`, so still clickable. The old
outlined button was live text and needed no such click. Izzy was told this
before the build and chose badge-only. If it ever turns out to bite, the fix
already scoped is a small "Or open play.google.com/…" line under the badge.

## The mockup that was approved

- **Artifact `YSi8QdS7P9NDFBUZJfEjWH`** — <https://claude.ai/artifact/YSi8QdS7P9NDFBUZJfEjWH>
- **`docs/mockups/onboarding-email/`** — the review page plus the two full email
  renders, the block at 1:1, and the images-off view.
  ⛔ Those renders are the REAL `welcomeCreatePasswordEmail()` output (run under
  `tsx` with `PUBLIC_PORTAL_URL=https://app.loopcom.net`), with asset `src`
  values rewritten to relative paths so the mockup renders offline. They are a
  snapshot of the pre-build proposal and are NOT regenerated on every change —
  re-render them if this email moves again.
