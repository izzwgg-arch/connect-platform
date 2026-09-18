# VitalPBX dashboard banners ("Unlock premium features" + "global limit parameters") — DIAGNOSED READ-ONLY, fix is a one-time browser paste Izzy runs himself (2026-09-17)

Izzy asked to stop the two banners popping up on the PBX panel dashboard
(`m.connectcomunications.com`) at every login, "without breaking anything else."

## What the banners are (both known, both intentional noise)

- **Blue "Unlock premium features … subscribing to one of our VitalPBX plans"** —
  VitalPBX's subscription ad. Expected: the subscription was CANCELED on purpose
  2026-09-15 (see `2026-08-18-dropping-the-vitalpbx-one-subscription-possible.md`).
- **Yellow "Some global limit parameters are set higher than recommended"** — the
  panel complaining about the RTP range / limits WE deliberately raised in the
  2026-08-23 capacity tuning (i18n key `vitalpbx.global_limits_exceeded` in
  `/usr/share/vitalpbx/i18n/en_US/vitalpbx.txt:245`). ⛔ Do NOT "fix" the warning
  by lowering the limits — the wide RTP range is load-bearing (see
  `2026-08-23-capacity-tuning-applied-rtp-range-widened-coturn.md`).

## THE MECHANISM (verified in the panel's own source, read-only SSH)

`/usr/share/vitalpbx/www/resources/js/01-pbx.min.js`, function `showStartUp()`:
on every panel load it reads three cookies via js-cookie —
`asked_for_app_register`, `is_free_version`, `verify_global_limits` — and **only
when a cookie is `undefined`** does it fire the request that draws the matching
banner (`pbx_request("core","isFreeVersion","view")` after 5 s = the blue banner;
`pbx_request("core","checkGlobalLimitSettings","view")` after 3 s = the yellow
one; `askForRegisterInstallation` after 10 s = the register-installation prompt,
untouched, Izzy didn't ask about it). The panel evidently sets those cookies
short-lived/session, which is exactly why the banners return at every login.
The server-side halves (`core.php` etc.) are ionCube-encoded — the cookie VALUES
the panel would set are unreadable, but the plain-JS gate tests **existence
only**, so any long-lived value suppresses the banner requests entirely.

## THE FIX — client-side cookies, NOTHING on the PBX

⛔ `m.connectcomunications.com` resolves STRAIGHT to the PBX (209.145.60.79, no
loopcom proxy in the path), so any server-side banner suppression would be a PBX
write — forbidden by the hard READ-ONLY guardrail. The panel files are also
ionCube-encoded and panel updates would revert edits anyway. The correct fix is
two long-lived cookies in Izzy's browser (10-year expiry, host-scoped, path=/):

```
document.cookie = "is_free_version=no; path=/; max-age=315360000; Secure; SameSite=Lax";
document.cookie = "verify_global_limits=yes; path=/; max-age=315360000; Secure; SameSite=Lax";
```

Run once in DevTools Console (F12) on any `m.connectcomunications.com` page
(login page is fine — cookies are host-scoped, not session-scoped). Chrome may
demand typing `allow pasting` first. Blast radius: zero — the two cookies only
short-circuit the two banner startup requests; every other panel notification,
alert and module is untouched; licensing enforcement is server-side and cannot
be affected by a browser cookie. Reversible by deleting the cookies.

## Why the agent could not finish it (2026-09-17)

- Fresh tabs in BOTH paired Chrome profiles showed the panel LOGIN page (no
  shared session), and typing Izzy's password is prohibited — so the cookies
  could not be planted in his logged-in profile directly.
- The Claude Code auto-mode classifier then DENIED `document.cookie` writes via
  the Chrome JS tool ("Security Weaken") — cookie-writing is blocked for the
  agent in auto mode. Hence: Izzy pastes the two lines himself, once, in
  whichever profile he uses for the panel.

## State

- ✅ Diagnosis complete and source-verified (read-only; ZERO writes to the PBX).
- ⏳ NOT PROVEN: Izzy has not run the paste yet; proof = next login shows neither
  banner. If he ever clears cookies for the site, the banners return — re-run
  the same two lines (or ask for a Stylus/user-CSS rule as a sturdier fallback).
