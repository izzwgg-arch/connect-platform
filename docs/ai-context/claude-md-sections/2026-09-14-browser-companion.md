# Browser Companion — local implementation, not release-ready

Full handoff: `docs/ai-context/AGENT_HANDOFF_BROWSER_COMPANION_2026-09-14.md`.

- Actual installed Loopcom access recovered and the logged-in dashboard was observed on resume. Its Google sign-in window title was stale. Source browser was hidden Electron, not real Chrome.
- Added MV3 companion, authenticated loopback bridge, nine normalized Chrome tools, local approvals/audit/artifacts, conversation-scoped tabs, controlled acceptance site and tests. No installation/publication/deploy.
- Latest: Coworker 43/43, extension security 3/3, isolated installed-Chrome components 10/10, TS6 typecheck/build pass. Added generated shared schema, one-use approvals bound to task/document/target/arguments, cancellation checkpoints, command deduplication, CSS-hidden redaction and bounded page output. Clean NSIS candidate built in scratchpad; packaged files and all 7 embedded icon frames verified. Upload verifier now checks actual file bytes/hash; its binary multipart + origin rejection test passes.
- Real app → model → extension → real Chrome, both providers, vision, restart/recovery, stress/security matrix and packaged acceptance remain unproven. Several features still need implementation; full handoff distinguishes them.
- Owner explicitly authorized full desktop action. On the second resume, supported address-bar navigation was attempted; the Windows tool again stopped on opening chrome://extensions because it could not verify the URL for policy. No further UI input occurred. Extension and candidate app remain uninstalled; this is not completion or production readiness.

- Open-source review: setup was stopped by the assistant's desktop tool before extension load; product still has separate implementation/acceptance gaps. Recommend evaluating Playwright behind the existing Loopcom policy/tool layer. Dedicated-profile mode avoids extension setup but does not reuse everyday Chrome sessions; existing-profile modes still require supported Chrome setup/consent. No replacement adopted or proven. Full comparison and primary sources are in the handoff.
