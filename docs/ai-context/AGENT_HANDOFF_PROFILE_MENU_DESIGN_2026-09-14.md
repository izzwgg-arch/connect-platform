# Profile menu mockup — 2026-09-14

## Request and scope

Izzy requested a professional review and mockup of the name/profile menu. Earlier dashboard deployment authorization does not turn this new design request into approval to replace the menu. No runtime source, preferences, account security, greeting audio, or PBX configuration changed. Documentation-only repository changes need no deployment.

Read CLAUDE.md, dashboard design summary/full handoff, the voicemail transcript-label summary, and the visualization skill. Inspected the live Support / Solidify Concrete menu in Chrome and ProfileMenu.tsx / ViewportDropdown.tsx plus relevant CSS and preference consumers.

## Observations and proposal

- Current menu measured about 390 × 887px in the desktop viewport. Nested cards and heavily emphasized labels make calls, email, greeting, security, and sign-out compete visually.
- Account shows “Ext Not assigned” and green “Available.” Source defaults presence to AVAILABLE; this does not establish actual call readiness. Proposal shows the explicit extension state rather than making a readiness claim.
- Browser mute and extension DND are separate controls with different scope. Keep them separate; do not substitute local muting for actual extension DND. Rename technical ringer copy to “Incoming call sound.” Browser mute storage was only found in ProfileMenu during the portal search; its end-to-end effect was not verified.
- Explicit Light/Dark selection is easier to interpret than an unlabeled binary theme switch.
- Voicemail gets its own tab. “Include transcription in email” stays verbatim, nested beneath email delivery and disabled with explanatory copy when voicemail emails are off.
- Greeting actions explain that an extension is required. The proposal does not claim that a default greeting is active when no extension is linked.
- Security and sign-out become quiet footer rows. Profile photo editing and close controls remain discoverable.
- Real implementation should expose preference-save failures, preserve existing recording/upload/play/reset behavior for assigned extensions, and verify keyboard focus handling. The mockup simulates actions locally; it does not test backend behavior.

## Mockup

`C:/Users/izzyw/.codex/visualizations/2026/09/14/01a0a144-d865-71a3-b6ee-bb8094bc02d9/loopcom-profile-menu.html`

Contained interactive fragment with opaque light/dark surfaces. Initial state reflects the observed unassigned account. Host design options include theme, corner radius, and an explicitly illustrative assigned Extension 101 state. No network calls or persistence. Greeting/security/sign-out/photo actions report preview-only status. Temporary preview served on localhost:8847 for verification.

## Verification and limits

- Rendered in real Chrome with the visualization wrapper. Light desktop quick settings visually inspected at 736px viewport, about 650px menu height.
- Dark theme and Voicemail tab switch verified through DOM; dark voicemail visually inspected at 320px viewport. No horizontal overflow (root scrollWidth equals clientWidth).
- Turning voicemail emails off disables transcription and updates its explanation; re-enabling succeeds.
- Close hides the menu and returns focus to the name trigger; reopening succeeds. Escape also closes and returns focus.
- Light quick settings visually inspected at 390px; menu about 646px high. Viewport override reset afterward.
- Full-page screenshot timed out once; normal screenshots and DOM inspection succeeded. Screenshot capture can lag an immediately preceding viewport/action, so subsequent stable screenshots were used.
- Assigned-extension host Tweak example is implemented but was not exercised in the standalone renderer. No production save, actual call, upload, or backend test was performed or claimed.

Outcome: reviewable mockup, not an approved or deployed menu replacement. Original live dashboard retained; live preferences unchanged.
