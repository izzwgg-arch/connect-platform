# Loopcom Community — audit + target architecture + v1 mockups (2026-09-18) — DESIGN ONLY, nothing built

Full handoff: `docs/ai-context/AGENT_HANDOFF_LOOPCOM_COMMUNITY_2026-09-18.md` (read it before touching anything named `community/`).

Izzy, 2026-09-18: the full "Loopcom Community" brief (Jewish-focused B2B professional network — identity, profiles, companies, graph, feed, messaging, search, groups, events, jobs, marketplace, RFQ, opportunities, referrals, mini-CRM, notifications, iOS/Android, analytics, moderation, admin), prefaced with *"give it the nice connect theme look, light mode and dark mode."*

- **Mockups: https://claude.ai/artifact/NKRSEmuPNncn8fq3h9z7yW** — 24 screens on Connect's OWN tokens (bare `:root` dark, `[data-theme="light"]` opt-in, in-page switch, never `prefers-color-scheme`), repo copy `docs/mockups/loopcom-community/mockups-v1.html`. Web shell + admin console + 2 iPhone + 2 Android frames. Names/companies/prices are EXAMPLES.
- **Audit verdicts (the handoff §1 has the table):** `User` cannot be the Loopcom ID (`tenantId` required, `email` globally unique) → new `CommunityPerson` linked to `User`; `LoopcomDirectIdentity` + `directPolicy.ts` is the TEMPLATE (per-user isolation, one-message request cap, deep-equal not_found); reuse `apps/realtime` ws + S3 attachments + reactions, `mfa/` OTP/TOTP, Google login-only, FCM push, EmailJob lane, the agent LLM lane for RFQ extraction; new = passkeys, Apple Sign In, FTS+trgm+pgvector search, media pipeline, `Community*` tables (additive, one DB), org RBAC table.
- **Mobile decision:** extend `apps/mobile` (Expo 54/RN 0.81) with a Community tab set; no second native codebase.
- **Build order:** Foundation (identity/orgs/RBAC/audit/analytics/flags + the 20× Tier-1 harness) → Core network → Community → Commercial (RFQ idempotent accept) → Employment → Loopcom integration → Intelligence. Every phase ends with the brief's completion report + proof package.
- ⛔ Traps: Community threads carry NO `tenantId` (guard test like Direct's); new portal pages ship nav + both toggle screens in ONE commit; register Community as a plugin file, never inline in the 43k-line `server.ts`.
- ⏳ **Waiting on Izzy: approve the design language (or ask for changes) → phase 1 starts.** No schema, routes, tests or deploy exist yet. Nothing to deploy from this task (docs + a static mockup file).
