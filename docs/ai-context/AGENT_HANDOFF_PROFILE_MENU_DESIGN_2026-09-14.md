# Profile menu mockup — 2026-09-14

**2026-09-14 follow-up:** server logs now prove this deployment succeeded at 22:33 UTC; the office IP had been automatically banned at 22:29 by 74 expected queued-log 404s. A later running portal `12d2c318` contains the implementation and its compiled marker was verified. Owner-approved unblock restored HTTP access. Permanent prevention is tracked in `AGENT_HANDOFF_DEPLOY_LOG_AUTOBAN_2026-09-14.md`; live DND call acceptance remains pending.


## Release verification blocked — 2026-09-14 18:42 Eastern

Implementation commit `8b866ed68ab73ac8aa5d67a88dde60ca65257836` is pushed. The second portal job `10fee31a-fd98-45b7-9071-0e856e6bb7e5` started at 18:28:39 after API job `928e0b0c-219...` completed. It passed git sync/change detection and entered the production Docker/Next build with the expected build marker. Last observed status was RUNNING / build; log ended at `Creating an optimized production build ...`. No final `[deploy-portal] done` line, running-container verification, or fresh production menu verification was obtained.

At approximately 18:41 a fresh Chrome reload of both `/admin/deploy-center` and `/dashboard` returned nginx `403 Forbidden`. Independent workstation HTTP checks also returned 403 for `https://app.loopcom.net/login`, `/ready`, and `https://app.connectcomunications.com/login`. This establishes denial from this connection, not a global outage or its cause. The first workstation checks were socket-blocked by the local sandbox; approved network-enabled checks returned the actual HTTP 403. No server infrastructure was changed and no access restriction was bypassed. Canonical Linux SSH is unavailable in this session, so the active build/final result cannot currently be inspected further. Do not enqueue a duplicate or claim deployment succeeded.

Resume by restoring authorized access, inspecting the existing job and final log for SHA `8b866ed68ab73ac8aa5d67a88dde60ca65257836`, verifying the running-container marker/code via the canonical method, then checking the live menu in light/dark. A live extension-wide DND call acceptance test still needs the owner-selected company/extension; the viewed Support account has none. No live DND, greeting, or PBX configuration changes were made by this task. Local fixture server stopped and scratch fixture sources removed.

## Release checkpoint — 2026-09-14

Runtime commit `8b866ed68ab73ac8aa5d67a88dde60ca65257836` was pushed to `origin/feat/ivr-migration-takeover` and pinned release branch `origin/codex/profile-menu`. Deploy Center fallback used because the canonical Linux SSH tool is unavailable in this session.

- Dry run `4f104c91-3517-4f4f-af0f-ebd388177b68` passed at 18:13 Eastern: correct target, no overlap with nine dirty server paths, blue/green enabled.
- First real attempt `1ee9806f-db7f-43d3-b469-5c33df86004a` stopped before build/rollout at 18:16 with `HEAVY JOB ALREADY RUNNING: deploy-queue:portal:compose-build-portal`. No lock bypass, service restart, or infrastructure edit was attempted. Server Health showed all services healthy. Queue idle does not establish that the separate heavy-build lock is free.
- After inspection and waiting, one bounded retry was queued at 18:24, job prefix `10fee31a-fd9`, behind an active API build. Final result still pending at this checkpoint.
- Fresh production dashboard at 18:22 still showed the old menu. Browser fixture server was stopped and its temporary source/bundle directory removed after verification.
## Implementation authorized — 2026-09-14

Izzy: “Fix it, add it in, and do the profile menu. As it is in the mockups.” Follow-up requires actual extension-wide DND, not a cosmetic toggle. This supersedes the historical mockup-only scope below. Portal implementation completed; deployment pending at this checkpoint.

ProfileMenu now matches the approved two-tab layout with scoped light/dark CSS, explicit theme buttons, quiet security/sign-out footer, visible photo affordance, close/focus return, arrow-key tabs, extension/loading/error identity, voicemail email dependency and greeting prerequisites. Existing upload, call-to-record job/polling, native audio preview, custom reset, diagnostics and API destinations are retained. Concurrent greeting actions and drops without an assigned extension are blocked; preference errors are surfaced. The redundant popup Play button is replaced by the retained native audio controls. ViewportDropdown has an opt-in content ResizeObserver, enabled only here, to reclamp asynchronous/tab height changes; default behavior of its other callers is unchanged.

useProfileDnd uses the existing GET/POST `/voice/extensions/me/dnd`. No new PBX endpoint or configuration change. Traced backend POST to setPbxDiversion → helper `/set-diversion` → tenant path `/diversions/<extension>/DND` AstDB enable value; GET reads the same family. This affects the whole extension, independent of the browser-local mute flag. The UI requires `confirmed:true` plus a boolean before showing a saved On/Off state; failures/unconfirmed responses stay unknown with a read-only retry. Request generations ignore stale responses; reopening waits for an in-flight write before reading. No writes on open, refresh or retry.

Validation: portal `tsc --noEmit --incremental false` passes. Focused DND state + existing dropdown tests 6/6 pass, and API PBX mutation safeguard tests 6/6 pass. Initial sandbox tsx invocation failed before test execution on Windows user lookup; unsandboxed test execution passed. Actual React component plus actual processed global/scoped CSS exercised in Chrome with local API fixtures: no-extension and read-failure rows stay visible; confirmed On/Off sends the expected POST bodies; close/reopen reads after save; unconfirmed and failed writes show unknown; retry sends GET only; SMS failed save reverts and shows error; voicemail transcription disables when email is off; custom greeting player/replace/record/reset controls remain; tabs and Escape/focus behavior work. Light desktop and dark 390px screenshots reviewed; 320×640 custom voicemail menu stays scrollable inside the viewport. Some Playwright calls timed out in the browser backend; native AX actions completed the same checks. No live PBX preference, call, greeting upload or reset was performed.

Live DND acceptance remains pending: asked Izzy which company/extension may briefly block incoming calls and restore its original state; current Support account has no extension. Do not claim a real incoming-call test until it happens. Canonical Linux SSH tool is unavailable; approved Deploy Center fallback will be used. Existing API deployment was running at preflight; wait for queue idle before portal dry run. `scripts/build-changed.sh` requires the server-only /opt/connectcomms/ops/run-heavy.sh, so local portal typecheck/component build and the scripted production portal build are the usable checks.

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

**Live visual acceptance (2026-09-14):** profile menu inspected in both light and dark mode in Chrome; Support correctly displays No extension assigned and unavailable DND with an explanation. Original light theme restored. No real DND/call mutation; incoming-call acceptance still awaits a chosen test extension.
