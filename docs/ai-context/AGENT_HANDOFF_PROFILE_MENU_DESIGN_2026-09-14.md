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

## Follow-up: why some users see DND (2026-09-14)

Izzy liked the mockup and requested investigation of inconsistent Do Not Disturb visibility. This follow-up is source diagnosis, not authorization to change live DND or PBX configuration.

The exact gate is `extDndSupported` in `apps/portal/components/ProfileMenu.tsx:437`. On every menu open, GET `/voice/extensions/me/dnd` sets it from `supported`; any rejected request sets it false. The frontend discards the API's `reason` and silently removes the control.

`apps/api/src/server.ts:20101` resolves the target and `:20119` reads the state. Requirements:

1. An ACTIVE extension in the caller's current tenant with `ownerUserId === user.sub` (`resolveVoicemailGreetingExtension`, around line 19941). An administrator seeing a company's extensions is not itself an assignment. A displayed/JWT extension value is not this database ownership check. If multiple active extensions belong to the user, the oldest-created one is selected.
2. A LINKED tenant PBX record with both instance and PBX tenant IDs.
3. Configured route helper for that PBX instance.
4. Successful live `getPbxDiversion(... feature: "DND")` read. The helper calls `/get-diversion`, not a new integration.

Unsupported reasons are `no_extension`, `no_tenant`, `tenant_not_linked`, `route_helper_not_configured`, and `read_failed`. In practice the resolver returns null for no tenant before the later `no_tenant` check, so that case normally surfaces as `no_extension`. Authentication, permission, network, or other request failures also hide the control through the frontend catch. It starts hidden while loading. Ordinary USER and EXTENSION_USER roles pass the broad `canViewCustomers` gate; this is not specifically an administrator-only feature or a custom-role DND toggle.

This explains both stable account differences and temporary disappearance: a read outage is represented as unsupported, then removed without explanation. It does not mean DND is off. No affected-user roster or fresh live API response was collected, so do not attribute every reported user's absence to one specific cause. The previously observed Support account had no extension shown, consistent with the first gate.

Design recommendation: keep a stable DND row under Calls, distinct from browser mute. Show Loading, On/Off only after a confirmed read, No extension assigned when appropriate, and Temporarily unavailable with Retry on read failure. Never render unknown as Off. The existing mockup already includes DND in the assigned-extension example; it still hides that row in the default unassigned state, so the stable disabled/error state refinement is a recommendation, not yet drawn or implemented. No tests were run for this read-only source trace; no runtime or PBX changes and no deployment.
