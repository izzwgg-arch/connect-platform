# Dashboard design concept — 2026-09-14

Request: suggest a futuristic 2027 SaaS dashboard and show a mockup. Owner switched the existing browser tab from A plus center to active Gesheft during the work; the final concept uses the latter.

Observed via Chrome: This Week (Sep 8–14) showed 3,207 total calls: 1,874 incoming, 1,276 outgoing, 57 internal; 6 missed and 173 canceled. Three connected calls were present at inspection. Phone was not registered. Dashboard voicemail and unread totals were 0, while sidebar Chat and notifications showed 65. This discrepancy is observed, not diagnosed; scope and freshness must be investigated before asserting an unread total.

Mockup: `C:/Users/izzyw/.codex/visualizations/2026/09/14/01a0a144-d865-71a3-b6ee-bb8094bc02d9/loopcom-dashboard-2027.html`.

Design: simplified navigation with secondary modules grouped, compact weekly metrics, a proposed briefing whose sources can be inspected, missed/canceled call review, active-call snapshot with masked numbers, and an accurate direction mix. No invented answer rate, staffing prediction, callback completion, or daily trend. Unified inbox and briefing are proposed experiences, not shipped features. Appearance, card radius, and briefing visibility are adjustable through the host design controls.

Verification: rendered with the visualize wrapper, opened in real Chrome, inspected the layout/accessibility state, switched Overview to By direction and back. Values changed to 1,874 / 1,276 / 57 and restored to 3,207 / 6 / 173. Responsive breakpoints are authored; narrow viewport rendering and host-only design controls were not browser-tested. No production writes or application edits; nothing to deploy. Production implementation remains outside this mockup request.

## Owner intent clarification

The owner likes the current dashboard and asked for professional assessment because customers have different preferences. Do not frame this as dissatisfaction or assume the proposed mockup is superior. Existing strengths include familiar navigation, visible call categories, trend chart, and active calls. Observed unread-count inconsistency deserves verification; navigation density was viewed as Support with extensive administrative access and may differ for ordinary users. Layout changes and an AI briefing are hypotheses, requiring representative user task testing. The concept loses the time trend and hides some navigation, so it has tradeoffs. No further UI changes, tests, or deployment in this clarification turn.


## Visual preference after comparison

Owner explicitly said the current dashboard looks better than the mockup. Record this as owner preference, not proof of universal user preference. The concept flattened the existing layered surfaces, color distinctions, and time-series presentation. Retain the current visual direction as the baseline for any future evidence-based assessment. No UI edits, tests, or deployment in this feedback turn.


## Targeted professional polish review

Owner requested specific corrections while preserving the current appearance. Existing tab had moved to Solidify Concrete Chat, so inspected dashboard in a separate temporary Chrome tab without changing the selected tenant. Prior Gesheft observations retained as historical evidence.

Confirmed in loaded dashboard: outgoing is teal in chart but violet in KPI; internal is violet in chart but teal in KPI. Incoming curve dips below zero around zero-call days; last x-axis date clips at right edge. DateRangeFilter maps This Week to 7d and This Month to 30d; displayed weekly chart is Sep 8–14 on Monday Sep 14. Communications card heading is Unread Messages but renders all recent items even with 0 unread. Dashboard page explicitly fetches communications per user without the date range, while calls use selected tenant/range. Earlier Gesheft sidebar 65 versus dashboard 0 remains a scope/count discrepancy needing diagnosis, not proof of leakage.

Source checks: components/dashboard/CallVolumeChart.tsx uses unconstrained Catmull-Rom smoothing, 16px right padding, centered edge ticks, and 10px axis text. CallActivityRow.tsx and globals.css have separate color mappings/cascade; any implementation must preserve shared component consumers. CommunicationsRow.tsx maps messages.recent without filtering by unread. DateRangeFilter.tsx provides rolling-range keys. app/(platform)/dashboard/page.tsx documents per-user communications. Local source was inspected, not container-verified.

Feedback: consistent semantic colors; nonnegative chart interpolation; complete edge labels; accurate date preset labels; clear personal/company and recent/unread scopes; tooltip definitions for Missed and Canceled without guessing call disposition. This is review only, no source edits or deployment. No automated tests; keyboard/mobile/contrast compliance not audited.


## Existing-design polish mockup

Owner requested a mockup of the narrow polish corrections after preferring the live design to the first redesign. Created C:/Users/izzyw/.codex/visualizations/2026/09/14/01a0a144-d865-71a3-b6ee-bb8094bc02d9/loopcom-dashboard-polish.html. Preserves the layout order, gradient cards, chart, five colored metrics, active-call rows, communications panels, IVR summary, and expanded navigation. Wordmark is a text approximation; secondary navigation is abbreviated for the mockup.

Corrections shown: consistent incoming blue/outgoing teal/internal violet; bounded Bezier curves that cannot pass below zero; larger complete inward-anchored date labels; Last 7 days/Last 30 days with selected dates; Recent Messages plus separate unread badge and personal/all-dates scope; local help for missed/canceled counts. Help avoids claiming an unverified backend disposition definition. Optional host controls toggle polish, highlight changed areas, and switch appearance.

Data: historical Gesheft totals and masked active-call snapshot from earlier inspection. Daily distribution and message previews are explicitly illustrative; no live connection and no false reconciliation of the 65-versus-0 discrepancy. Existing first mockup retained separately.

Verification: wrapper render succeeded; read back literal fragment; inspected Chrome accessibility tree and screenshot; canceled-call help expanded with expected text. Responsive CSS included but narrow viewport and host-only controls not directly tested. No production application edits, deployment, or PBX action. Mockup is for review, not implementation approval.


## Separate light-mode treatment

Owner clarified that dark and light dashboards have separate designs/colors and asked about light mode. The previous automatic shared-theme mockup did not adequately represent that distinction. Reviewed the actual light dashboard again in Chrome (current tenant Solidify Concrete); did not change any production theme setting.

Created C:/Users/izzyw/.codex/visualizations/2026/09/14/01a0a144-d865-71a3-b6ee-bb8094bc02d9/loopcom-dashboard-light.html. Fixed light-only colors and color-scheme; removed automatic appearance switching and theme picker. Keeps the established light tile palette blue Incoming / purple Outgoing / teal Internal / amber Missed / gray Canceled; updates chart legend, series, and outgoing call badge to agree within this light design. Retains white gradient cards, soft blue background, sidebar and layout. Prior generic polish and redesign files retained for history.

Verification: read-back, wrapper render, Chrome accessibility state and screenshot. Screenshot confirms purple outgoing chart/tile/badge and teal internal chart/tile. Historical Gesheft totals/active snapshot remain in the mockup; daily curves/messages remain explicitly illustrative. No application changes/deployment. Dark mode has not been independently audited or rebuilt, and this does not assert separate React implementations.


## Authorized implementation in both production themes

Owner: "Do it on both" and "Light mode and dark mode, and then commit, push, deploy." This supersedes the earlier mockup-only scope, without approving the rejected redesign.

Changes: scoped dashboard-polish.css maps chart/legend/tooltips/live direction badges to the existing KPI colors. Browser computed colors prove dark #60a5fa/#34d399/#a78bfa and light #2563eb/#7c3aed/#0d9488. Shared global tokens and other pages are untouched. Card visuals/layout stay intact. CallVolumeChart uses segment-bounded cardinal controls (flat zero runs cannot undershoot), width-dependent ticks with first/last dates anchored inward, 11px text, larger plot insets, and whole-call Y ticks. Existing trailing 120ms ResizeObserver behavior retained. DateRangeFilter has only one production consumer; its presets now say Last 7 days/Last 30 days. Window caption consumes API windowFrom/windowTo and timezone (end exclusive), chart/tooltip dates use the same timezone. Caption says updating while the resource refreshes.

Messages render Recent Messages, a compact explicit unread badge, and Your conversations / All dates; initial unavailable data no longer claims zero unread. No backend counts changed. Help buttons are native keyboard/touch buttons with aria-expanded/controls and Escape dismissal, with a shared in-flow explanation that avoids card clipping. Backend source verified: normalizeDashboardDisposition maps missed/no answer/no_answer/unanswered to missed; aggregate counts missed only for incoming. Canceled includes canceled/cancelled/busy across every direction. Help avoids claiming callback completion or lost inbound calls.

Verification checkpoint: 4 chartGeometry.test.ts tests passed (tsx outside restricted shell, plus equivalent TypeScript-transpiled node tests); full portal tsc --noEmit --incremental false passed. Restricted tsx first failed uv_os_get_passwd ENOMEM, an environment lookup limitation, not a test assertion. Local Next dev compiled /dashboard and served 200. Chrome verified independent theme colors agree with chart, live badges, complete edge dates; canceled help opens and Escape closes. 390px dark screenshot shows readable nonclipping chart endpoints and compact Recent Messages badge; added mobile preset wrapping. Existing visual QA data only, no production API writes. Live theme was temporarily inspected and restored to light.

Deployment checkpoint: production Next build running; not yet deployed. Canonical mcp__workspace__bash is absent from callable tools, so direct SSH is unavailable. Approved Deploy Center fallback is accessible, queue healthy/running 0/queued 0. Use portal only, dry-run first, and verify expected SHA in final log plus fresh browser behavior. Raw container verification still requires canonical SSH; do not claim container proof without it. Other agents are editing desk-phone/API/mobile files in this shared worktree; commit only owned paths and preserve unrelated staged/worktree changes.

Build checkpoint: Next production webpack compilation passed, then its type phase failed on another agent's untracked packages/shared/src/deskPhoneSetup/deviceMechanisms.ts importing a nonexistent VendorSlug. This file and its related dirty desk-phone files are excluded from this dashboard commit. Earlier full portal typecheck passed before those concurrent edits appeared. Production release build must verify the clean committed source. Light-mode 390px check also passed without horizontal page overflow; mobile presets wrap and Recent Messages uses a compact unread badge.

## Release result — DEPLOYED 2026-09-14

Code commit f2460c4fab09f7b35793d7d21d6bc266beeb6084 pushed to origin feat/ivr-migration-takeover and fixed release branch codex/dashboard-theme-polish. Used a temporary --work-tree snapshot plus explicit commit paths so the unrelated Solidify CLAUDE index line and concurrent desk-phone/mobile changes remained outside this commit.

Approved Deploy Center fallback used because canonical Linux SSH tool is unavailable. Dry run d862f0de-4aab-4b5e-b415-3fc5fe98e168 succeeded: target f2460c4fab09; 9 dirty production paths, none overlapping the 20 target-changed paths. Live script dry run synchronized the queue clone (despite older docs describing it as no git mutations); no service rollout during dry run. Real portal job 2e769464-fc72-40b7-a399-a38169faecdc succeeded in 363599ms, approximately 16:50:27 America/New_York. Production Next build compiled, passed type validation, generated 185/185 pages, and completed. Blue/green candidate :3005 readiness passed; public readiness verified; stable :3000 readiness passed; final nginx_active_port=3000; candidate removed. Final log: [deploy-portal] done f2460c4f requested_by=izzywgg@gmail.com (Deploy Center).

Container verification: the deployed scripts/deploy-portal.sh verify phase ran docker exec to read /app/.build-commit and require equality with NEW_HEAD, then finished successfully. Docker build log stamped the full f2460c4f SHA. An additional manual unique-dashboard-code grep inside the running container was unavailable without canonical SSH. Fresh live browser inspection independently confirms the new compiled dashboard content and CSS; do not describe this as a manually executed container code grep.

Live verification: app.loopcom.net/dashboard reloaded. Light card and graph computed colors match #2563eb/#7c3aed/#0d9488; dark match #60a5fa/#34d399/#a78bfa, with each theme's surfaces retained. Actual Solidify data has a flat zero plateau, no below-zero curve, full Sep 14 endpoint, and whole-call ticks. Actual date caption Sep 8–14, 2026 / America/New_York; switching Last 30 days produced Aug 16–Sep 14 then restored Last 7 days. Recent Messages shows 0 unread separately and Your conversations / All dates. Missed help opened by Enter and closed by Escape. Live 390px light and dark viewports: no page overflow, wrapped presets, both edge ticks in bounds; original light theme and default viewport restored after checking. No API/PBX/config changes. Existing historical sidebar/dashboard unread discrepancy remains outside this presentation fix, not falsely reconciled.

## Voicemail organization review — 2026-09-14

Owner asked to inspect disorganized dashboard voicemails. Live Chrome dashboard (Support / Solidify Concrete) currently has no voicemail rows. Screenshot confirms a large empty card beside five message rows, repeated zero/no-new/no-recent status, and an unlabeled large voicemail count versus the compact explicit message unread count. This is an inspection, not a deployed fix.

Source diagnosis: globals.css .dash-v2-comm-item-link uses three auto-placement columns (30px 1fr auto), but .is-unread adds a relative-positioned generated ::before grid item before the three real children. Consequently unread rows shift avatar/body placement and move time into a second grid row, unlike read rows. The selector is shared only by dashboard voicemail and message previews; both themes inherit it. Light overrides change surfaces/hover only. Recommended correction is to remove the phantom in-flow item or position a real unread marker outside grid flow, preserving explicit avatar/body/time alignment. Populated live rows were not available to visually reproduce this in the current account; diagnosis is from the exact DOM-generating component and CSS, not a claim of live populated-row verification.

Additional source findings: Play is decorative and the entire row navigates to /voicemail, so it implies playback without playing or selecting that voicemail. Metadata unconditionally inserts a separator, producing a leading dot when the caller name/number pair is absent. The API already orders the latest five inbox voicemails by receivedAt descending; do not claim a sorting defect. The current component can also show false empty status while loading/unavailable. No runtime edits, playback, mailbox mutations, tenant changes, tests, or deployment for this review. Next implementation should cover read/unread rows, missing names, empty/loading/error states and both theme palettes without touching PBX or API behavior.

## Voicemail organization fix — implementation and local verification

Owner authorized fixing all reviewed issues. CommunicationsRow now uses a voicemail icon (navigation, not implied playback), conditional caller-number separator, explicit compact unread count, personal inbox/all-dates scope, and distinct empty/loading/unavailable text. Empty communications content fills and centers within the paired card instead of leaving its message near the top. Unread markers are absolutely positioned on avatars with screen-reader unread text; the generated fourth grid item is removed. The shared voicemail/message grid uses minmax(0,1fr) so long content truncates and time stays aligned. Existing themes, newest-first API ordering, destinations and mailbox behavior remain unchanged. Only CommunicationsRow.tsx and its dashboard selectors in globals.css change runtime behavior.

Validation: portal tsc --noEmit --incremental false passed; git diff --check passed. Local QA server rendered the actual component using React server rendering plus processed actual globals/polish CSS with synthetic named, number-only, unknown, long-name, read/unread and message records, plus empty/loading/unavailable cases. Real Chrome checked light/dark at 2752px and 390px: all six populated rows are 46px high, avatar/time centers match, caller body stays between icon and time, no mobile overflow, no leading metadata separator, and no play icon. Screenshots confirm theme surfaces and readable unread dots; accessibility tree includes Unread only on unread rows. Browser viewport restored. Production build/deploy and fresh live verification pending. No API/PBX writes or audio playback added.
