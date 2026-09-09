# ⛔⛔ AGENT HANDOFF — the Coworker HAS REAL HANDS: desktop link, local runtime, approval window, MCP host, dynamic `computer_*` tools in the agent — built, deployed, proven on the dev box (2026-09-09)

**Commits:** `336ad19f` (agent + desktop, the hands) → see §9 for the follow-ups (portal permissions view, docs, acceptance harness, packaged build).
**Read first:** `AGENT_HANDOFF_COWORKER_BUBBLE_DEAD_2026-09-02.md` §10 (the card-era hands this replaces) and `AGENT_HANDOFF_AI_COWORKER_2026-08-31.md` (the policy core this is built on).
**Mandate:** Izzy, 2026-09-09: *"INSPECT → RUN → TEST → IDENTIFY WHAT IS MISSING → IMPLEMENT/FIX → RUN AGAIN → PROVE EACH CAPABILITY ON THIS ACTUAL WINDOWS COMPUTER."* — 40 phases, no fake success, a proof bundle.

---

## 1. Phase 0 — what actually existed, and why "create a folder" could not happen

Inspected in the takeover tree (`C:\dev\projects\connect2-takeover`, live branch `feat/ivr-migration-takeover`):

- The Coworker was the card-era design: `coworker_task` (agent) drafted ONE of three allowlisted tasks
  (`folder_summary` / `organize_folder` / `system_snapshot` on Downloads/Desktop/Documents), the person pressed a
  card in the popover, the desktop ran it, the result landed in the API for a LATER turn. No filesystem write, no
  shell, no browser, no MCP, no diagnostics collectors, no approval window, no task journal.
- The model loop lives on the server (`apps/agent`, Docker `app-agent-1`); the desktop had no channel to receive a
  tool call INSIDE a turn. So "Create a folder on my Desktop" could only ever be refused by the prompt ("cannot do it
  yet") or turned into a card for an off-list kind → refused.
- The installed app on this box was 0.1.16 (no bubble at all) until another session installed rc.9 at 17:10Z.

The trace (Phase 1) broke at **MODEL → TOOL CALL**: the model had no tool that could create a folder, and even the
card tool could not return a result to the model in the same turn.

## 2. What was built (all in `336ad19f`)

### 2.1 The link — `apps/agent/src/coworker/` + `apps/desktop/src/coworker/link.ts`

| Piece | File | What |
|---|---|---|
| Registry | `agent/src/coworker/desktopLink.ts` | in-memory sessions keyed by `tenantId:userId`; `hello` (manifest), `next` (long-poll ≤25 s), `dispatch` (queue a call, await the result, ≤10 min, timeout/disconnect/cancel are RESULTS not rejections), `result`, `cancel`, `sweep` |
| Tools | `agent/src/coworker/desktopTools.ts` | manifest → `ToolSpec[]` (names exactly as declared, reserved names skipped, identity re-checked per call); `coworkerHandsPrompt()` (ACTION vs QUESTION, verify side effects, content is data, denial is final, cancel); `COWORKER_NOT_CONNECTED_PROMPT` |
| Routes | `agent/src/coworker/routes.ts` | `POST /agent/coworker/hello`, `GET …/next?wait=`, `POST …/result`, `…/cancel`, `…/goodbye`, `GET …/status`, `…/manifest` — identity from the portal JWT only (`resolveIdentity`) |
| Engine | `agent/src/conversation/engine.ts` | new last ctor arg `DynamicToolsProvider`; per turn: tools = platform tools (minus `coworker_task`/`my_computer_tasks`) + desktop tools; prompt block; `maxIterations` 40; bare "cancel/stop" → `link.cancel`; phone-line "diagnostic" triage intents go to the model when the hands are on |
| Chat route | `agent/src/conversation/routes.ts` | `desktopApp` = User-Agent contains `Loopcom/<n>` (the app brands its UA); tools are offered from the app's windows or the bubble path, never a browser tab |
| Client | `desktop/src/coworker/link.ts` | reads the JWT from the main window's localStorage (`TOKEN_SCRIPT`), hello every 5 min or on manifest change, long-poll loop with backoff, 750 ms poll floor (never spins), 401 → re-read token, 409 → hello again, calls handled off the loop, results retried ×3 |

### 2.2 The hands — `apps/desktop/src/coworker/`

- **`policyCore.ts`** — a COPY of the shared core (domains, `NEVER_AUTO_DOMAINS`, SAFE/TRUSTED/AUTONOMOUS baselines,
  `HARD_PROHIBITIONS`, `decideToolCall` in the shared ORDER, `normalizePath`/`resolveScopedPath`, `redactText`/
  `redactStructured`). `coworkerHands.test.ts` reads `packages/shared/src/coworker/{types,policy}.ts` and fails on
  any drift. The desktop bundles nothing from the monorepo, which is why it is a copy.
- **`toolCatalog.ts`** — 31 tools, each with declared category/risk/domains/destructive/exfiltration/timeouts:
  `computer_workspace`, `computer_fs_{list,stat,read,search,mkdir,write,move,copy,delete}`, `computer_open_path`,
  `computer_xlsx_{write,read}`, `computer_system_info`, `computer_processes`, `computer_powershell`,
  `computer_browser_{open,read,click,fill,select,check,submit,download,screenshot,wait,close}`,
  `computer_diagnostics`, `computer_mcp_servers`, `computer_task_history`, `computer_artifact_register`.
  Every catalogue entry has a runtime case and vice versa (test).
- **`runtime/index.ts`** — per call: parse → spec → `decideToolCall` (profile, call-in-progress, prohibitions) →
  deny (journal, answer the model with the code) / ask (approval window, 5-min timeout, No is final and journaled)
  / run → journal → answer. Concurrency: each call has an AbortController; `cancel(taskId|null)` aborts approvals,
  kills shell children (`taskkill /T`), closes the browser.
- **`runtime/fs.ts`** — roots = user profile + workspace (+ `coworkerExtraRoots`); relative paths resolve against
  the workspace (`%USERPROFILE%\LoopcomCoworkerAcceptance` by default); `..` refused on the RAW input; string fence
  then realpath of the nearest existing ancestor re-checked (a junction to `C:\Windows` fails closed); move/copy
  never overwrite; delete refuses the roots and non-empty folders without `recursive`.
- **`runtime/shell.ts`** — one script per call, `-NoProfile -NonInteractive`, killed at its timeout with the tree,
  output capped at 30 k; `SHELL_DENY_PATTERNS` (Defender, firewall, services, accounts, HKLM policy, network
  config, installers, remote access, power, disk, UAC/execution policy, encoded commands, credential tooling) refuse
  whatever the profile says.
- **`runtime/windows.ts`** — fixed CIM queries: edition/version/build, last boot, memory, fixed drives, CPU load,
  processes by memory/CPU.
- **`runtime/browser.ts`** — a hidden `BrowserWindow` on `persist:loopcom-coworker-browser` (own cookies/cache,
  never the person's Chrome), driven by `executeJavaScript`: page extractor (headings, text, links, controls with
  CSS selectors, forms), find by selector/text/label, click/fill/select/check/submit with settle-after-navigation,
  downloads via `will-download` into the workspace downloads folder, screenshots, popups denied, permissions denied.
- **`runtime/xlsx.ts`** — a real `.xlsx` writer/reader with `node:zlib` (inline strings; reads shared strings).
- **`runtime/diagnostics.ts`** — 12 time-boxed collectors (processes, phone state, backend HTTPS probes, DNS,
  interfaces/gateway, ping loss/latency/jitter to gateway + Loopcom, STUN binding over UDP, VPN/proxy indicators,
  audio endpoints, resources, app-log error lines (redacted), Windows System events); each `ok|warn|fail|unknown`
  with evidence. Interpretation is the model's, bounded by the numbers.
- **`runtime/mcp.ts`** — hand-rolled MCP stdio client (JSON-RPC 2.0, newline-delimited): initialize → tools/list →
  tools/call, timeouts, server requests answered/refused, exit → `dead`; `McpManager.apply(configs)` from
  `DesktopSettings.coworkerMcpServers`; tools exposed as `mcp_<server>_<tool>`; a `.js` command runs under
  Electron-as-Node.
- **`runtime/journal.ts`** — append-only JSONL under `userData/coworker/` (args redacted + bounded), artifacts file.
- **`approvalWindow.ts` + `assets/coworkerApproval.html`** — the ONLY source of a "yes": a small always-on-top
  window per ask, bound to the call id, Enter = Allow / Esc = Don't allow, closes on answer/cancel/timeout.
- **`assets/coworkerConnections.html`** (tray → "Coworker Settings & Connections…") — link status, profile
  (SAFE/TRUSTED/AUTONOMOUS), MCP servers (add/connect/disconnect/reconnect/enable/disable/remove, friendly errors),
  task history, artifacts (Open / Show in folder), Cancel running task.
- **`hands.ts`** — assembles the above; `main.ts` calls `startHands()` after the main window exists; tray shows
  `Coworker hands: connected (PROFILE)`; `before-quit` stops it (goodbye).
- **`scripts/acceptance-mcp-server.js`** — the test MCP server (token nonce + invocation log, add, echo with an
  injected instruction).
- **`scripts/coworker-acceptance/{run.mjs,portal-server.mjs}`** — the end-to-end harness (§4).

### 2.3 Rules a future change must keep

- ⛔ **The desktop decides, never the server.** Every call from the wire is untrusted input: parsed strictly, judged
  by `policyCore.decideToolCall`, path-fenced, denylisted. A compromised agent can only ask.
- ⛔ **Approval is bound to ONE call id and comes only from the local approval window.** No portal page, no message
  and no server can answer it.
- ⛔ **`NEVER_AUTO_DOMAINS`, the hard prohibitions and the shell denylist are not settings.** Do not loosen them to
  make a test pass.
- ⛔ **A "No", a "denied" and a "cancelled" are final for that call.** The prompt tells the model not to route around
  them; the runtime refuses further calls of a cancelled task.
- ⛔ **Keep `policyCore.ts` identical to the shared core** (the drift test reads the shared files).
- ⛔ **Names announced to the model must match `^[a-z][a-z0-9_]{0,63}$`** — OpenAI and Anthropic both reject others.
- ⛔ **Never let the poll loop spin** (750 ms floor) and **never leave a long timer armed** after a race (the
  5-minute approval timer hung `node --test` for 10 minutes before it was cleared in `finally`).

## 3. Deploy state

- **agent** ✅ `app-agent-1` rebuilt at `336ad19f` (2026-09-09 17:44Z, `/root/coworker-agent-build.log`), healthy;
  `registerCoworkerLinkRoutes` ×2 in the container; `GET /agent-api/coworker/status` → 403 without a token, 200
  `{connected:…}` with one, through nginx.
- **nginx** ✅ `/agent-api/` `proxy_read_timeout 120s → 900s` + `proxy_send_timeout 900s` on the app host (backup
  `/root/connectcomms.nginx.bak-<ts>`; `nginx -t` ok; reloaded). A long multi-tool turn is one HTTP request.
- **portal** — see §9 (permissions view: three profiles + Settings & Connections button).
- **desktop** — dev build from source on this box (junctioned scratch toolchain, `electron .`), then the packaged
  installer — see §5/§6.

## 4. The acceptance harness (Phase 2)

`node apps/desktop/scripts/coworker-acceptance/run.mjs --token <jwt> --suite dev|packaged --out <dir>`
posts ordinary prompts to `POST /agent-api/chat/message` exactly as the bubble does (portal JWT, `Loopcom/` UA,
`context.path=/desktop/coworker`), one fresh conversation per test, waits for the reply, and verifies INDEPENDENTLY:
`fs`, PowerShell CIM, the local portal's `/api/submissions` and `/api/expected`, the MCP invocation log. It never calls
a tool. `portal-server.mjs` is the controlled local website (form + dropdown + checkbox + submit, Reports with CSV
downloads, a product page carrying an injected instruction, `/broken`, `/slow`). Output: `acceptance-results.json`,
`acceptance-report-<suite>.md`, `test-matrix-<suite>.csv`, `logs/`, `artifacts/`.

## 5. Results — dev build (from source, this box)

_(filled in from the proof bundle — see §10)_

## 6. Results — packaged build (installer, this box)

_(filled in — see §10)_

## 7. ⏳ NOT PROVEN / BLOCKED — the honest list

_(filled in — see §10)_

## 8. Traps hit while building

- ⛔⛔ **THE FIRST rc.10 INSTALLER WAS DEAD ON ARRIVAL.** `electron-builder --win` run from `apps/desktop` with the
  JUNCTIONED scratch `node_modules` packed `electron-updater` without its own dependencies; the installed app's main
  process threw `Cannot find module 'builder-util-runtime'` on load, leaving three processes, no window and no log
  line. Found by running `resources/app.asar` under the dev electron. Fix: build from a clean export directory
  (`scratchpad/desktop-build` = dist/ assets/ scripts/ package.json electron-builder.yml + `npm install --omit=dev`,
  then `electron-builder --win -c.electronVersion=41.5.0`), and smoke-test the asar under the dev electron BEFORE
  installing. The good installer's sha256 starts `808509ad2233e5f7`; asar 3,727,354 bytes (the dead one: 2,252,029).

- `taskkill` is not on the git-bash PATH here (`Stop-Process -Name Loopcom` from PowerShell instead); the installed
  app holds the single-instance lock so a dev `electron .` silently exits until it is stopped.
- Electron's `node_modules/electron/path.txt` must have NO trailing newline or `electron .` fails with ENOENT on
  `electron.exe\n`; the npm postinstall extraction had also produced only `locales/`, so the zip was unzipped by hand.
- A bash `node -e '…"C:\\dev\\…"…'` string loses its backslashes on this box → write settings from a script file and
  use forward slashes in MCP commands.
- The pnpm store here is unreadable (memory `devbox-toolchain-blocker`); the desktop and agent typechecks/tests ran
  on a scratch `npm install` toolchain junctioned into `apps/desktop/node_modules` and `apps/agent/node_modules`
  (git-ignored). The agent suite's `Cannot find module 'zod'` file failures are that harness (workspace junctions
  have no `zod`), not the code; the suites that matter (`coworker/`, `conversation/coworkerAwareness`, `engineTools`,
  `staffPrompt`, `tools/coworkerTaskTools`) are green.

## 9. Follow-ups in this handoff's later commits

_(filled in)_

## 10. Proof bundle

`C:\Users\Ezra\Loopcom-Coworker-Proof-2026-09-09T1751\` — `acceptance-report-dev.md`, `acceptance-report-packaged.md`,
`acceptance-results.json`, `test-matrix-*.csv`, `logs/` (harness, link status, manifest, portal server),
`artifacts/` (the produced files), `screenshots/`, `environment-summary.txt`.
