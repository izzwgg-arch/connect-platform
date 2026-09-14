# Deploy monitoring autoban — 2026-09-14

**Proven:** nginx banned the office IP at 22:29 UTC for 670 requests and 74 404s in five minutes. All 74 were the queued deployment's absent log, polled by Deploy Center. Portal deployment actually succeeded at 22:33; blocked browser status was stale. Owner-approved one-IP unblock restored both logins and API health (200); no allowlist or threshold changes.

API + portal fix deployed and container/browser verified (API `dae5a245`, portal descendant `68cac2f4`): known-job waiting logs are HTTP 200, queued log polling stops, visible polling is sequential with backoff, finished logs stop and stale data is labelled. 15 focused + 6 safeguard tests pass; portal tsc passes; API has 84 existing diagnostics. Full evidence, permissions and release checklist: `docs/ai-context/AGENT_HANDOFF_DEPLOY_LOG_AUTOBAN_2026-09-14.md`.

Live queued-log test: eight HTTP 200 responses, zero 404s; no renewed IP ban across a full monitoring window. Full release evidence is in the handoff.
