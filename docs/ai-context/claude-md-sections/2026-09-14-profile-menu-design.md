# Profile menu design review — 2026-09-14

Mockup only; no runtime settings or portal source changed. Preserve Loopcom's current visual character. The live Support / Solidify Concrete menu has an unassigned extension, a green Available label, six equally prominent control tiles, unexplained disabled greeting actions, and an oversized sign-out area.

DND follow-up: source-confirmed visibility requires an ACTIVE extension owned by the signed-in user, LINKED tenant PBX, configured helper, and successful live status read. Loading, unsupported configuration, and request/read failures all hide the row; frontend drops the reason. Ordinary users can pass the role gate. Recommend a stable row with a reason/loading/retry state; unknown must never mean Off. No per-user live audit, runtime changes, or DND writes performed.

Interactive proposal separates Quick settings and Voicemail, clarifies browser versus extension call controls, uses explicit Light/Dark choices, nests transcription under voicemail email, explains greeting prerequisites, and reduces footer prominence. Exact label “Include transcription in email” is retained.

Chrome checks passed for theme switching, tabs, email/transcription dependency, close/reopen and Escape focus return. Light quick settings inspected at 390px; dark voicemail inspected at 320px without horizontal overflow. Production implementation and save/error handling remain unimplemented. Full record: `docs/ai-context/AGENT_HANDOFF_PROFILE_MENU_DESIGN_2026-09-14.md`.
