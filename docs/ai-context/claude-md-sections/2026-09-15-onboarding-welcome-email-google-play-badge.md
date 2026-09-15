# ⛔ AGENT HANDOFF — the welcome/invite email's "Download Loopcom for Android" button becomes the GOOGLE PLAY BADGE (2026-09-15) — MOCKUP ONLY, NOTHING BUILT, NOTHING DEPLOYED, two decisions open with Izzy

**Status: ⏳ MOCKUP PUBLISHED, AWAITING IZZY. No source file changed. No email
template edited. Nothing queued, sent or deployed.**

Read this together with
`docs/ai-context/claude-md-sections/2026-08-09-the-apk-link-was-missing-from-sign-up-invitation.md`
and its full handoff `docs/ai-context/AGENT_HANDOFF_INVITE_APK_LINK_2026-08-09.md`
before touching this email — that is where the two-paths trap is recorded.

## What Izzy asked for

> "https://play.google.com/store/apps/details?id=com.connectcommunications.mobile
> in the onboarding welcome email, right now there is the download APK button.
> Replace it with the real Google Play tag. When you press on it, it opens
> Google Play."

then, before any build:

> "Show me what it's going to look like before you build … I want to see the real
> onboarding email mockup, and instead of the download APK, the Google Play symbol."

## The mockup

- **Artifact: `YSi8QdS7P9NDFBUZJfEjWH`** — <https://claude.ai/artifact/YSi8QdS7P9NDFBUZJfEjWH>
- **In repo: `docs/mockups/onboarding-email/`**
  - `google-play-badge.html` — the review page
  - `email-today.html`, `email-proposed.html` — the FULL emails
  - `block-proposed.html`, `block-blocked.html` — the Android block at 1:1, images on / images off
  - `wordmark.png`, `google-play-badge.png` — assets so the mockup renders offline

⛔ **The two email renders are NOT hand-drawn.** They are the output of the real
`welcomeCreatePasswordEmail()` in `apps/api/src/userEmailTemplates.ts`, produced by
running it under `tsx` with `PUBLIC_PORTAL_URL=https://app.loopcom.net` and the
sample `Ellie / Display Decks / ext 101 / 48h`. `email-proposed.html` is that same
output with ONLY the Android block substituted, so what the page shows is what the
template will emit. ⛔ The asset `src=` values in the committed copies are rewritten
to relative paths (`wordmark.png`, `google-play-badge.png`) so the mockup renders
without network — the real email keeps absolute `https://` URLs (see below).

Repro:

```
npx tsx <script importing welcomeCreatePasswordEmail>   # PUBLIC_PORTAL_URL=https://app.loopcom.net
```

## What the change actually is

ONE block in ONE template. Today (`userEmailTemplates.ts`, `androidSection`):

- copy: "… Use the button below — it opens our secure download page with the latest APK."
- `lcSecondaryButton("Download Loopcom for Android", input.androidApkUrl)` — an
  outlined **text** button
- a trailing note: "Android may ask you to allow installs from this source the first time."

Proposed:

- copy: "… install the Loopcom app to receive calls, voicemail, and mobile features.
  Get it free from Google Play."
- an `<a>`-wrapped `<img>` of Google's official badge, **180 × 70**, linked to
  `https://play.google.com/store/apps/details?id=com.connectcommunications.mobile`
- the "allow installs from this source" note is **deleted** — it is meaningless for Play
- the `text` half of the email changes with it (same Play URL)

The badge asset is Google's own `en_badge_web_generic.png` (646 × 250, 4.9 KB),
fetched from `play.google.com/intl/en_us/badges/…`. ⛔ Its built-in transparent
margin IS the clear space Google's brand guidelines require — do not crop it, do
not re-colour it, do not rebuild it by hand.

## What it touches — traced BEFORE proposing (CLAUDE.md third rule)

- ⛔ **TWO callers, one template.** `server.ts → queueUserWelcomeEmail()` (admin
  invite / resend) and `onboarding/setupOrchestrator.ts → queueInviteEmail()`
  (self-service sign-up) both build this same email and both get their URL from
  `getAndroidApkUrlForInviteEmail()` in `apps/api/src/androidApkInviteUrl.ts`.
  Because the swap lands in the template + that one resolver, both paths move
  together. This is exactly the resolver that was created on 2026-08-09 after the
  APK link went missing on the sign-up path only.
- ⛔ **The badge must be hosted by us, absolute.** Mail clients cannot read a
  relative path or a `data:` URI, and Google's CDN is not a supportable hotlink
  target. Plan: commit the PNG to `apps/portal/public/brand/google-play/` and
  reference `https://<canonicalPortalOrigin()>/brand/google-play/…`, resolved at
  CALL time, the same way `brandLogoUrl()` already resolves the wordmark.
  ⛔ Resolve it in the template, never as a caller input — that is the rule
  written on `brandLogoUrl()` and it exists because of this exact email.
- **The APK is NOT withdrawn.** `/api/mobile/android/download`, the download page
  and the portal Install link keep serving `connectcomms-latest.apk`. Only what
  the welcome email offers changes.
- **iOS is untouched** — this email has never carried an iOS link, and the App
  Store build is in review, not published.
- **Guard test:** `androidApkInviteUrl.test.ts` already reads BOTH call-site
  sources. It gains a case asserting the Play URL + badge markup appear in the
  built body, so a later edit cannot quietly revert to the APK button.

## ⏳ THE TWO DECISIONS — do not build past these without Izzy's answer

1. **Badge only, or badge + a text fallback line?** Outlook (and some Gmail
   accounts) block images on first open, and a badge is an image. Badge-only is
   what Google's guidelines want and what is mocked; the alt text
   "Get it on Google Play" stays clickable. A small
   "Or open play.google.com/store/apps/details?id=…" line underneath would give
   image-blocked readers a visible link at the cost of clutter. `block-blocked.html`
   in the mockup shows exactly what images-off looks like.
2. **Hard-code the Play URL, or keep the env override?** Today
   `ANDROID_APK_DOWNLOAD_PAGE_URL` overrides the link and otherwise it falls back
   to the APK page **only when a real ≥1 KB APK exists**. Simplest is that the
   email always points at the Play listing. Keeping an override means one env var
   could swing every future invite back to the APK page — useful the day Play
   pulls a build, a foot-gun otherwise. ⛔ If an override is kept, remember
   CLAUDE.md's rule that an env-only api change still needs a carrying commit.

## Not proven

⛔ Nothing here has been proven in an inbox. The renders are browser renders of
the template's HTML; **Outlook's Word engine has not been tested with the badge
`<img>`**, and no invite has been sent. When this is built, prove it the way the
2026-08-09 handoff proves it: query the last `USER_INVITE` `EmailJob` bodies and
check BOTH paths — admin invite and self-service sign-up — carry the Play URL.
