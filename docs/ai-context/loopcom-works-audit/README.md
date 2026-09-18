# LoopCom Works — audit reports (2026-09-18)

Eight read-only audits run in parallel by Sonnet subagents on 2026-09-18, each
fenced to one area, each claim carrying a `path:line`. The lead re-read all eight;
the decisions built on them are in `../AGENT_HANDOFF_LOOPCOM_WORKS_2026-09-18.md`.
Line numbers are against `Loopcom works/` at `trim pro 2` `loopcom@d380533` and
Connect at `feat/ivr-migration-takeover@8fad6359`; they drift with every edit.

| File | Scope |
|---|---|
| `A1-branding.md` | every TrimPro string/asset/domain in the Works copy, classified customer-facing vs internal |
| `A2-ui-inventory.md` | all 96 pages, all components, tokens as-is, the 3,990 hard-coded colours, microcopy samples |
| `A3-mobile.md` | the Expo app under `apps/mobile/` — config, 33 screens, auth, assets, risks |
| `A4-security.md` | all 277 API routes for tenant isolation + auth/session/webhook/upload/header/secret/dependency findings (13 critical) |
| `A5-connect-design-system.md` | the Loopcom portal's real tokens, shell, components, login, assistant pattern |
| `A6-connect-agent.md` | how the Loopcom AI service authenticates callers, its conversation API, tools, persona, and the seam for Works |
| `A7-connect-telephony-messaging.md` | the Connect api's auth, SSO precedents, click-to-call, live call events, history, SMS, entitlement — and the gap list |
| `A8-deploy.md` | how Connect deploys, how Works deploys today (hazards), the migration state, env vars, and the Works server plan |
