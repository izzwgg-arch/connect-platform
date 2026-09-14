# Loopcom / Connect project memory

## Fundamental task rule — owner instruction, 2026-09-14

Every time Izzy gives an agent a task:

1. Read `CLAUDE.md` freshly before starting the work. The instruction read itself is the first action; do not substitute prior context or memory.
2. After completing the work, update the docs before reporting completion. Record the outcome, evidence, and unresolved work accurately. Details go in the area's file under `docs/ai-context/claude-md-sections/`; `CLAUDE.md` gets only that area's ONE index line (it is rules + index only, under 80 KB — never append a handoff section to it; 2026-09-14).
3. Apply this to every task, including small tasks, repository refreshes, and documentation-only work. Never wait for a reminder.

The agent entry point `AGENTS.md` and `CLAUDE.md` both carry this rule so future sessions can recover it from disk.

Profile menu review (2026-09-14): mockup only, not implementation approval. Preserve browser mute versus extension DND scope and the exact label “Include transcription in email.” Explain unassigned-extension greeting controls and avoid treating default Available presence as proven call readiness. See profile-menu design handoff.

DND visibility (2026-09-14): ProfileMenu hides it unless the own-extension GET returns supported:true. This requires an ACTIVE owned extension, linked PBX/helper, and successful read; temporary read/request failure hides it too, discarding the reason. Unknown is not Off. Admin access to a company does not assign an extension. Source diagnosis recorded in the profile-menu handoff; no live DND changes.

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
