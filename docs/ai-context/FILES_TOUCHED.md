# Files touched — the Coworker's hands (2026-09-09)

Commits `336ad19f`, `48511a49`, `0b6b44b6`, `d17be2af`, `1ac3d427` (+ `4654b2ac` by the parallel session: popover hold-on-blur, approval placement, badge). Handoff `AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md`.

| File | Why |
|------|-----|
| `apps/agent/src/coworker/desktopLink.ts` | The link registry: sessions per verified identity, hello/next/result/dispatch/cancel/beginTask/endTask/sweep, bounded results |
| `apps/agent/src/coworker/desktopTools.ts` | Manifest → `computer_*`/`mcp_*` ToolSpecs; the COWORKER prompt block; the not-connected block |
| `apps/agent/src/coworker/routes.ts` | `/agent/coworker/{hello,next,result,cancel,goodbye,status,manifest}` (JWT identity) |
| `apps/agent/src/coworker/desktopLink.test.ts` | 11 tests: strict manifest, round trip, timeouts as results, cancel (in flight + during planning), bounds, tool binding, Fastify routes, source guards |
| `apps/agent/src/conversation/engine.ts` | `DynamicToolsProvider`; hands-on tool set; prompts rewritten (no "cannot do it yet"); cancel shortcut; diagnostic triage yields to the model when the hands are on |
| `apps/agent/src/conversation/routes.ts` | `desktopApp` from the branded User-Agent |
| `apps/agent/src/conversation/coworkerAwareness.test.ts` | Pins the new prompt truth |
| `apps/agent/src/server.ts` | Creates the link, the per-turn provider, registers the routes, sweeps sessions |
| `apps/desktop/src/coworker/policyCore.ts` | Local copy of the shared policy core (drift-guarded) |
| `apps/desktop/src/coworker/toolCatalog.ts` | The 31 tools with declared risk/domains |
| `apps/desktop/src/coworker/runtime/index.ts` | Verdict → approval → run → journal; cancel; xlsx object rows / empty-row refusal |
| `apps/desktop/src/coworker/runtime/fs.ts` | Fenced filesystem hands (raw `..` refused, realpath re-check, never overwrite) |
| `apps/desktop/src/coworker/runtime/shell.ts` | Controlled PowerShell + denylist + tree kill |
| `apps/desktop/src/coworker/runtime/windows.ts` | CIM facts: system info, processes (GiB-labelled) |
| `apps/desktop/src/coworker/runtime/browser.ts` | Hidden own-partition browser: open/read/click/fill/select/check/submit/download/screenshot/wait/close |
| `apps/desktop/src/coworker/runtime/xlsx.ts` | Dependency-free `.xlsx` writer/reader (formulas, numeric strings) |
| `apps/desktop/src/coworker/runtime/diagnostics.ts` | 12 time-boxed collectors with ok/warn/fail/unknown |
| `apps/desktop/src/coworker/runtime/mcp.ts` | MCP stdio client + manager |
| `apps/desktop/src/coworker/runtime/journal.ts` | Redacted, bounded JSONL task journal + artifacts |
| `apps/desktop/src/coworker/link.ts` | The desktop end of the link (token from the main window, long-poll, backoff, poll floor) |
| `apps/desktop/src/coworker/hands.ts` | Assembly + admin IPC (profile, MCP actions, relink, cancel, open path, open connections) |
| `apps/desktop/src/coworker/approvalWindow.ts` | The approval prompt window + the Connections window |
| `apps/desktop/src/coworker/coworkerHands.test.ts` | 17 tests: drift guard, catalogue↔runtime, fs fence on a temp dir, shell, xlsx, runtime verdicts, link on a fake server, MCP against the real acceptance server, source guards, journal |
| `apps/desktop/src/coworker/coworker.test.ts` | Card-era pin updated for the AUTONOMOUS mapping |
| `apps/desktop/src/main.ts` | `startHands()` after the main window; tray entries; stop on quit |
| `apps/desktop/src/preload.ts` | `coworkerApproval` and `coworkerAdmin` bridges |
| `apps/desktop/src/types.ts` | `coworkerPermissions` AUTONOMOUS, `coworkerMcpServers`, `coworkerWorkspace`, `coworkerExtraRoots`, new window kinds |
| `apps/desktop/assets/coworkerApproval.html` | The approval prompt page |
| `apps/desktop/assets/coworkerConnections.html` | Settings & Connections page |
| `apps/desktop/scripts/acceptance-mcp-server.js` | The test MCP server (nonce, add, echo-with-injection) |
| `apps/desktop/scripts/coworker-acceptance/run.mjs` | The end-to-end harness (base + extended phases) |
| `apps/desktop/scripts/coworker-acceptance/portal-server.mjs` | The controlled local website |
| `apps/desktop/scripts/coworker-acceptance/approval-watcher.ps1` | Stands in for the person at the prompt (screenshot + posted key) |
| `apps/desktop/package.json` | version 0.1.17-rc.10 |
| `apps/portal/components/CoworkerTaskCard.tsx` | Permissions view: three profiles + Settings & Connections |
| `docs/ai-context/AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md` | Full handoff |
| `docs/ai-context/CHANGELOG.md`, `TESTS_RUN.md`, `KNOWN_ISSUES.md`, `FILES_TOUCHED.md` | Mandatory doc updates |
| `CLAUDE.md` | New ⛔ AGENT HANDOFF section at the top |
