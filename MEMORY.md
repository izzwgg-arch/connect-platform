# Loopcom / Connect project memory

Current Laybel repair (2026-09-16, supersedes older local-state notes below): live words reached Loopcom; server 500 was Prisma rejecting channel VOICE in fresh conversations (16:49Z requests req-8ou/req-8p1). Local VOICE->CHAT mapping plus direct Yiddish Labs mic STT/translation and English-speech/Yiddish-chat wiring implemented in isolated scratchpad/laybel-release. 74 agent + 31 portal tests pass; no live proof/deployment. Pending two-branch GitHub push approval still blocks release; do not bypass prior auto-review denial. Production portal advanced to 47584ef6, so reconcile remote work before pushing. No PBX/config/schema changes or customer rollout. Read latest Laybel handoff for full evidence and acceptance steps.

Laybel release gate (2026-09-16): bb16c34b committed in isolated scratchpad/laybel-release, not pushed/deployed. Auto-review blocked the two-branch GitHub push; explicit owner approval requested for codex/laybel-live-video-20260916 + feat/ivr-migration-takeover at izzwgg-arch/connect-platform. Do not bypass. Assistant-only restart approval is already granted. Final portal typecheck passed; no live latency claim.

Laybel latency update (2026-09-16): owner confirms call works. Implemented final-answer-only streaming through the existing Assistant/tool gates; no commentary/tool arguments, no partially spoken replay. 76 agent + 23 portal tests pass. Owner approved Assistant-only release with rollback (queue lacks agent target); deployment/live speedup pending. Timing means speech queued, not audible playback. English output can precede YL chat translation; YL video microphone input remains unwired. See Laybel handoff.

## Fundamental task rule — owner instruction, 2026-09-14

Every time Izzy gives an agent a task:

1. Read `CLAUDE.md` freshly before starting the work. The instruction read itself is the first action; do not substitute prior context or memory.
2. After completing the work, update the docs before reporting completion. Record the outcome, evidence, and unresolved work accurately. Details go in the area's file under `docs/ai-context/claude-md-sections/`; `CLAUDE.md` gets only that area's ONE index line (it is rules + index only, under 80 KB — never append a handoff section to it; 2026-09-14).
3. Apply this to every task, including small tasks, repository refreshes, and documentation-only work. Never wait for a reminder.

The agent entry point `AGENTS.md` and `CLAUDE.md` both carry this rule so future sessions can recover it from disk.

Talk to Laybel (2026-09-16): owner requires concrete user-visible proof BEFORE claiming working; tests/tokens/deploy are insufficient. Restricted Anam key saved encrypted, approved custom portrait configured; customer enabled=false. Live test exposed 21.6px collapsed video. Portal 40c3ba2a layout fix deployed and container/browser verified; real portrait now 310.4x174.6px. First call microphone transcription and Assistant chat replies observed, audible output unverified. Post-fix call connected then disconnected; repeat End > Talk > Start connected in controlled Chrome, but owner reported start trouble. No post-fix spoken question/reply confirmed. Ended test, microphone off, Start screen open. End-to-end acceptance, disconnect cause, voice/Yiddish, retention/duration and SignalWire comparison still open. See `docs/ai-context/AGENT_HANDOFF_FACE_TO_FACE_AI_SUPPORT_2026-09-15.md`. New owner requirement: YL Yiddish STT -> English translation -> existing AI -> YL Yiddish chat; speak original English through avatar until Yiddish voice ready. This split is not wired yet; video currently uses Anam STT and speaks reply rather than contentEn. Never claim live language acceptance from existing text-bridge code alone.

Profile menu review (2026-09-14): mockup only, not implementation approval. Preserve browser mute versus extension DND scope and the exact label “Include transcription in email.” Explain unassigned-extension greeting controls and avoid treating default Available presence as proven call readiness. See profile-menu design handoff.

DND visibility (2026-09-14): ProfileMenu hides it unless the own-extension GET returns supported:true. This requires an ACTIVE owned extension, linked PBX/helper, and successful read; temporary read/request failure hides it too, discarding the reason. Unknown is not Off. Admin access to a company does not assign an extension. Source diagnosis recorded in the profile-menu handoff; no live DND changes.

Profile menu implementation authorized (2026-09-14): replace with approved light/dark mockup and actual extension-wide DND. New UI keeps DND visible and requires confirmed phone-system read-back; never seed it from browser mute or treat an unconfirmed POST as On/Off. Local implementation/checks complete, rollout and live call acceptance tracked in the profile-menu handoff. Owner asked to identify a safe test extension; none selected yet.

Browser navigation (2026-09-14): opened and verified the Loopcom dashboard in real Chrome; keep requested tabs open with `markDeliverable()`. Record: `docs/ai-context/AGENT_HANDOFF_BROWSER_NAVIGATION_2026-09-14.md`.

Dashboard concept (2026-09-14): owner supplied an active Gesheft dashboard for the 2027 mockup. Use observed totals; do not infer callback status or answer rate from missed/canceled counts. Concept and verification: `docs/ai-context/AGENT_HANDOFF_DASHBOARD_DESIGN_CONCEPT_2026-09-14.md`.

Dashboard evaluation preference: Izzy likes the current dashboard; wants independent professional assessment for diverse customers. Separate evidence from taste, account for user roles, and do not treat mockups as proven improvements.


Dashboard visual preference (2026-09-14): owner prefers the existing dashboard to the generated 2027 concept. Preserve its visual character; the mockup is not an approved replacement.


Dashboard polish review: retain design; concrete observed issues are inconsistent direction colors, curve below zero, clipped date labels, rolling-range wording, and personal/recent messages labeled unread. Record in dashboard design handoff; no fixes applied.


Dashboard polish mockup: loopcom-dashboard-polish.html is the existing-design version; loopcom-dashboard-2027.html is the earlier unapproved redesign. Prefer the polish version for this discussion. Historical totals plus explicitly illustrative daily distribution; no live changes.


Owner instruction: evaluate light and dark dashboards as separate designs; do not model them as one automatic palette swap. Dedicated light mockup: loopcom-dashboard-light.html. Preserve light KPI colors and make chart match within that theme.


Both-theme dashboard implementation authorized 2026-09-14, including commit/push/deploy. Preserve light blue/purple/teal and dark blue/green/violet KPI palettes. API date bounds are exclusive-end and use PBX timezone; missed means incoming unanswered, canceled includes busy across directions. See dashboard handoff for implementation and final deployment status.

Dashboard polish is deployed as f2460c4f (2026-09-14), both themes verified live. Earlier mockup/review "no fixes applied" notes are historical and superseded. Canonical SSH tool absent: Deploy Center fallback completed blue/green and container commit-marker check; fresh browser confirmed deployed behavior. Full release evidence and limits are in the dashboard handoff.

Dashboard voicemail review (2026-09-14): unread pseudo-element is an extra in-flow grid item shared with message previews; read/unread alignment differs in both themes. Source diagnosis, not populated live verification; current account empty. Preserve newest-first API order and existing palettes. Full dashboard handoff records review; no fix deployed.

Dashboard voicemail fix (2026-09-14): replace in-flow unread pseudo-element with an avatar dot; keep three grid children. Actual-component fixture checks passed read/unread, missing/long names, both themes and mobile. Distinct loading/empty/unavailable states and navigation icon. Rollout pending; full dashboard handoff tracks deployment.

Dashboard voicemail fix DEPLOYED 7d12c14f (2026-09-14): production build and blue/green/container commit checks passed; live empty card verified light/dark, original light restored. Populated rows verified via actual-component fixtures in both themes/mobile; no live rows in current account. Full dashboard handoff contains job evidence.

Profile menu release (2026-09-14 18:42 Eastern): runtime `8b866ed6` pushed; job `10fee31a-fd98-45b7-9071-0e856e6bb7e5` last seen building before both hostnames returned nginx 403 from this connection. Deployment and live DND acceptance remain unverified. Restore authorized access and inspect that job before any new enqueue. Canonical Linux SSH unavailable; no bypass or PBX changes.

Deploy autoban (2026-09-14): a queued job without a log is an expected waiting state, never a repeated public 404. All 74 404s in the office ban were Deploy Center log polling; deployment itself succeeded. Deployed API/portal fix covers all services, pauses hidden tabs, bounds retries and labels stale status. Owner approved read-only Windows SSH exception and one-IP unblock only. Do not weaken the monitor or add an allowlist. See deploy-log-autoban handoff.

Browser Companion (2026-09-14, resumed): local implementation only; NOT installed/deployed/production-ready. Existing hidden Electron browser cannot control real Chrome. MV3 bridge/tools plus target-bound one-use approvals, generated schema, cancellation/deduplication and bounded DOM extraction implemented. Latest Coworker 43/43, extension security 3/3, isolated-Chrome components 10/10 and TS6 build pass. Actual Loopcom access recovered; stale Google sign-in title was not a login blocker. Owner authorized desktop use, but Windows tool stopped on Chrome URL-policy verification while selecting Extensions. No extension installation or agent acceptance occurred. See docs/ai-context/AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md; preserve all work and do not publish this candidate as complete.

Deploy-log safety release verified: API dae5a245, portal descendant 68cac2f4; live queued-log reads returned 200 and the office remained unblocked. Read both direct-deploy processes/logs and queue state before retrying: a direct release may be running even when queue runningCount is zero.

Browser Companion latest continuation (2026-09-14 20:04 EDT): clean NSIS candidate built and payload/icon verified; actual binary upload verifier passed. Chrome Extensions navigation again triggered the desktop tool's URL-policy stop after owner authorized full computer use. App/extension remain uninstalled and actual-agent acceptance unproven. Candidate path and SHA256 are in AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md. Do not label this release-ready or bypass the tool safeguard.

Browser Companion alternatives review (2026-09-14): distinguish assistant-tool URL-policy setup stop from unfinished product tests. Playwright is recommended as the execution foundation, preserving Loopcom policy/ownership; dedicated-profile mode is a separate capability, not proof of access to everyday Chrome sessions. Existing-session Playwright/Chrome DevTools routes still require browser setup/consent. Alternatives researched only, not installed or proven; see Browser Companion handoff.

Browser Companion Playwright implementation (2026-09-15): Loopcom now launches installed Chrome in its own Loopcom Coworker profile through Playwright Core, with normalized tools, conversation tab fences, one-use state-bound approvals and workspace artifact limits. It never reads ordinary Chrome tabs or sessions. Local headless installed-Chrome test and clean NSIS payload/icon checks pass; candidate is not installed, published or live-chat accepted. Do not call this an existing-session feature or production-ready. See `docs/ai-context/AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md`.

Browser Companion installation (2026-09-15): owner approved the GitHub push and local installer. `3b414de0` is on the shared remote branch and the verified NSIS candidate was installed/restarted at the regular Loopcom path. The installed ASAR was inspected and contains the Playwright runtime/core and branded settings page. A targetable Loopcom window was unavailable to the desktop-control service after restart, so installed live-chat/provider acceptance remains unproven.

Coworker IDE redesign preview (2026-09-15): owner requested a mockup before any implementation. The preview uses one consistent IDE workspace in light and dark themes: recent tasks on the left, task conversation and composer in the center, live computer/tool activity plus approvals/artifacts on the right. No product UI, deployed behavior, or browser-control policy changed; await design feedback before building it. See `docs/ai-context/AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md`.

## Universal search — 2026-09-14

Use the live navigation catalog and authoritative custom permissions. Every record provider must preserve its own tenant/ownership/role rules; search cannot widen access. See `docs/ai-context/AGENT_HANDOFF_UNIVERSAL_SEARCH_2026-09-14.md`. Core rule remains: read CLAUDE.md fresh at task start and update area docs, index and memory before finishing.

Gesheft pay line (2026-09-17): the POS register's `"Customer PIN required."` means the account has NO PIN in the POS and cannot be served by anyone — hand to a person, never re-ask; `"Invalid customer PIN."` means a PIN exists. Izzy's test numbers (562-209-6644 → 1001021, 845-238-0884 → 4322) are no-PIN, no-card accounts. Caller-ID rule built + deployed e6875027: matched caller keys nothing (silent probe), asked once only when the POS has a PIN we lack, foreign number keys the PIN every time. Desk "Phone PIN" control enrolls PINs from the Orders desk. See `docs/ai-context/claude-md-sections/2026-09-17-pay-line-caller-id-rule.md`.
