# ⛔ AGENT HANDOFF — the agent got TOOLS; audio adaptation is measured but not built (2026-08-06) — READ FIRST for apps/agent, the model router, call-quality data, or permission-granting

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff + spec: **`docs/ai-context/PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md`**

- **The agent had NO agentic loop at all** — zero `tool_use` handling anywhere.
  Code pre-fetched data, pasted it in a prompt, and the model narrated it; it
  could never ask a follow-up. Fixed: `completeWithTools` in `llm/router.ts`
  (both providers, 8-round cap, degrades to a plain completion on failure —
  never replays a half-finished tool exchange across providers).
- ⛔ **The security model CHANGED.** The agent used to be safe because it was
  powerless. Now it can *ask* for data, so enforcement lives in
  `tools/toolRegistry.ts`: **no tool schema may declare a tenant**, `executeTool`
  strips any tenant-ish key the model invents and audit-logs the drop, and role
  gating hides internal tools from customers. **Every new tool must follow this.**
- ⛔ **OpenAI tool calls MUST use `/v1/responses`, not chat.completions** —
  `gpt-5.6-luna` (the live picked chat model, set via the owner model-picker,
  which OVERRIDES `DEFAULT_ROUTES`) rejects tools+reasoning there. Caught in prod.
- ⛔ **Thinking shares the `max_tokens` budget** on Opus 5 / Sonnet 5 / gpt-5.
  Four ceilings were too small; chat's 800 could return EMPTY text, which the
  engine silently turned into the canned "passed it to our team" line. Never
  lower these to "save money" — you truncate after paying to think.
- **Phase 1 measured (do not re-derive):** Android quality reporting is healthy
  (~452 reports / 668 connected calls). **iOS reported ZERO** — `platform` was
  hardcoded `"ANDROID"` in the shared RN client — and `networkType` was always
  null. Both fixed in `apps/mobile/src/sip/jssip.ts`, **needs an APK/TestFlight
  build to take effect**. ⛔ Do NOT import `@react-native-community/netinfo`:
  it is in node_modules but in NO package.json and absent from pnpm-lock
  (the undici failure mode) — networkType now comes from WebRTC ICE stats.
- **The tuner is deliberately NOT built.** Only 8 days of history and exactly
  ONE person+network group with both relay and direct arms — it would propose
  nothing. Coverage first (the mobile build above), then the decision layer.
- ✅ **Permission-grant-by-chat is COMPLETE (§7 of the plan doc)** — API apply
  endpoint (`apps/api/src/agentGrantRoutes.ts`) + portal password dialog
  (`apps/portal/components/AgentGrantConfirmDialog.tsx`, wired into BOTH the
  floating bubble and `/assistant`). The agent still only PREPAREs. Authority is
  the EXPORTED `getGrantablePermissions()` from `customRoleRoutes.ts` — there is
  exactly one authority rule; never write a second. The allow-list, deny-list
  and approval hash now live in `@connect/shared`
  (`chatPermissionGrants.ts` root-exported + browser-safe;
  `chatPermissionGrantHash.ts` is `node:crypto`, **subpath only**, and a shared
  subpath needs a `paths` entry in `tsconfig.base.json` or apps/api cannot
  resolve it). ⛔ The password goes to `/api/*` and NEVER `/agent-api/*`. Grants
  land in one per-recipient role `Assistant grants — <email>`. 35 API tests +
  12 agent tests cover every stress case. ✅ **DEPLOYED — container-verified
  2026-08-09**: `agentGrantRoutes.ts` in `app-api-1`, `permissionGrant.ts` in
  `app-agent-1`, and `AgentGrantConfirm` inside the live portal `.next` build.
  ⏳ Still **never walked in a browser** — nobody has typed a password into the
  dialog and watched a real permission land. Do that before trusting it; the
  tests prove the logic, not the round trip.
- Deployed this session: `812674ca` → `c8f12a99` on `feat/ivr-migration-takeover`.
  Agent deploys are a MANUAL compose rebuild (no agent service in the deploy queue).
