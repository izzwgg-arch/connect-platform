# Dashboard polish — 2026-09-14

Full handoff: `docs/ai-context/AGENT_HANDOFF_DASHBOARD_DESIGN_CONCEPT_2026-09-14.md`.

**DEPLOYED: f2460c4f**, portal job 2e769464-fc72-40b7-a399-a38169faecdc. Owner authorized implementation in both themes, commit/push/deploy after preferring the existing dashboard to a broader redesign.

Preserved existing layout/surfaces and separate palettes: light blue/purple/teal; dark blue/green/violet. Fixed chart/card/badge consistency, below-zero smoothing, clipped/crowded dates, whole-call axis ticks, rolling-range wording and actual date/timezone caption. Recent Messages has a separate unread count and personal/all-dates scope. Keyboard/touch help defines incoming missed calls versus canceled/busy calls across directions.

Verification: 4 chart/date tests passed; portal typecheck passed. Local production compile passed but concurrent uncommitted desk-phone code blocked its type stage; that code was excluded. Clean production release build/typecheck and all 185 generated pages passed. Blue/green candidate and stable readiness/public checks passed; final upstream :3000. Script verified running container .build-commit matches f2460c4f; final done log matches. Fresh live browser checked both palettes, actual 7/30-day captions, flat zero curve, full edge dates, message label and keyboard help; both mobile themes checked at 390px. Additional manual container dashboard-code grep unavailable because canonical SSH tool is absent; live compiled content verified instead.

Historical sidebar/dashboard unread-count discrepancy remains uninvestigated beyond the source scope review; no backend count change. Earlier mockups and rejected redesign are documented in the full handoff. Preserve this narrow-polish direction in future work.

Voicemail fixes DEPLOYED 7d12c14f (job 477e8dce-fa24-4016-8ef1-ce1589b83315): stable read/unread rows and markers, explicit inbox scope/count, centered empty/loading/unavailable states, voicemail navigation icon, conditional separator. Actual-component desktop/mobile fixtures passed both themes; full production build, blue/green readiness/public probes and container commit-marker check passed. Fresh live empty card verified in both themes; light restored. Populated live voicemail rows unavailable in this account. Manual container code grep unavailable; details in full handoff.
