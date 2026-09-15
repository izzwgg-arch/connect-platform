# Loopcom Browser Companion — implementation in progress, NOT release-ready

## Status / stopping point

**Latest, 2026-09-14 20:04 EDT:** Owner asked “Fix it. Make it work” and explicitly authorized full desktop action. Refreshed Chrome's returned window, observed the address bar, successfully focused it and typed `chrome://extensions/`; pressing Return produced the same tool-level URL-policy stop as before. No further UI input or alternate control-channel attempt occurred. This is an automation-tool restriction, not a Loopcom bridge error. Owner declined the proposed manual extension-load step and asked the agent to do it. Do not repeatedly ask the same permission or weaken/bypass Chrome or tool security. App and extension are still **not installed**, and real-agent acceptance is still **not proven**.

### Clean installer and verifier completed on second resume

- Added reproducible `apps/desktop/scripts/browser-companion/prepare-package.mjs`: stages compiled desktop, assets and extension only, removes dev/scripts metadata, and pins the installed production electron-updater version (6.8.9). Production dependencies installed into the isolated directory with lifecycle scripts disabled (16 packages); no monorepo dependency collection errors.
- NSIS installer successfully built using Electron 41.5.0 and existing unchanged application identity/version (`0.1.17-rc.16`). Candidate: `C:/dev/projects/Connect 2/scratchpad/browser-companion-package-20260914235634428/release/Connect-Setup-0.1.17-rc.16.exe`, **100,560,159 bytes**, SHA256 **29A6CD35CE9253FAAE424957356B602A31EE53A9A09003F7A32173AFCAC14E26**. This is a local test candidate, not a published release.
- ASAR inspection: 479 entries; compiled bridge, extension worker, generated schema, settings page and electron-updater all present. Initial check falsely reported missing files because asar used Windows separators; normalizing separators proved all present. Existing `verify-built-icon.ts` against this exact candidate passed all 7 icon sizes and no foreign icon. No installed-app runtime smoke test occurred.
- Portal multipart receipt now hashes the actual uploaded file bytes and records filename/length, rather than only the multipart envelope. New `portal.test.mjs` passes a binary-file exact-hash test plus cross-origin rejection. Syntax checks passed for both changed scripts. This is verifier evidence, not Chrome C6 acceptance.
- OpenAI and Anthropic official tool-result image documentation was consulted; both support image content in tool results. **No vision implementation or provider deployment occurred.** Sources: https://developers.openai.com/api/docs/guides/function-calling and https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls .
- All earlier implementation gaps still apply except clean installer construction and multipart receipt verification. Installation, extension pairing and complete runtime acceptance remain outstanding. No PBX/server changes, commit, push, fleet publication or Chrome policy changes.

2026-09-14 19:49 EDT update: Owner authorized resumption and desktop use. App access has recovered (logged-in dashboard observed); the Google sign-in window title was stale. During selection of Chrome's existing Extensions tab, Windows Computer Use returned: “Computer Use has been stopped for this turn because it could not determine the current browser URL on Windows with enough confidence to enforce policy.” No further UI input occurred. **Do not label this complete, installed, deployed, or production-ready.** Changes remain local and uncommitted. No fleet publication, server deployment, PBX access, or production account acceptance actions occurred. The earlier physical-Escape interruption is historical.

## Resume implementation and verification (latest)

- Generated extension `schema.js` from the desktop protocol source with `scripts/browser-companion/schema.mjs`. Build checks parity. Exact types, per-action fields, required values, integer bounds, prototype-name rejection and negative scroll deltas now enforced on both boundaries.
- Added `approvals.js`: protected actions first inspect the actual page, return a one-use random authorization, and run only if task, conversation, command, arguments, document epoch, semantic target, form state and context still match. Local approval shows observed site/target/form context and exact arguments. Tokens stay between desktop and extension, never model/catalog/journal. Download now explicitly requires local approval too. Full runtime/extension integration of this path is still untested.
- Added origin/checkpoint validation immediately before script injection, open and close. Fixed per-task cancellation matching, aborts on shared-tab user input, bounded bridge cancellation queues and task sets, distinct timeout error, and pre-dispatch command ID persistence across worker restarts. Reconnection/full stress remains unproven.
- Page extraction prunes CSS-hidden/private regions, includes link/form destinations in element signatures, and caps combined JSON output below the desktop link limit. No vision transport was added.
- Latest tests: **43/43 Coworker**, **3/3 extension security**, **10/10 installed-Chrome DOM components**, **TS6.0.3 typecheck and build PASS**. Additional components verify CSS-hidden redaction and refusing form/link changes after approval. 10,000-row filtered extraction took about 5.2 seconds in this run.
- Commands: `node --import tsx --test apps/desktop/src/coworker/*.test.ts`; `node --test apps/desktop/scripts/browser-companion/security.test.mjs`; `node apps/desktop/scripts/browser-companion/dom-components.mjs`; `node node_modules/.pnpm/typescript@6.0.3/node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json [--noEmit]`.
- Current raw component evidence has 10 results in `scratchpad/browser-companion-component-proof/component-tests.json`. **Correction: scratchpad is untracked, not gitignored.** Never stage it wholesale. Existing timestamped proof bundle is the earlier 8-component snapshot, not the latest run.
- Native observations: installed Loopcom main window id 1838054, title “Sign in - Google Accounts”, actually showed logged-in Home dashboard with zero active calls. Window 1445066 was the floating widget. Chrome window 67582 was minimized; supported restore succeeded. Its existing Extensions tab was observed, but the subsequent selection was stopped by the tool. Handles must be refreshed on continuation.

Remaining security review includes upload file/target TOCTOU, approval binding completeness for large/hidden form state, credential/URL redaction in approval descriptions, multi-profile bridge session ownership, key revocation, and complete challenge/restart/resource tests. All real agent, both-provider, vision and packaged acceptance requirements below still apply. Resume through supported UI only; do not bypass the tool's URL-policy failure with another control channel.

## Phase 0 evidence

- Freshly read CLAUDE.md, the Coworker summary, `AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md`, policy handoff, and the card-era handoff before implementation.
- Actual installed Loopcom was already running at `C:/Users/izzyw/AppData/Local/Programs/@connectdesktop/Loopcom.exe`. Activated its uniquely identified main window. It displayed **403 Forbidden / nginx**, preventing access to Coworker chat. Owner confirmed someone else was fixing access; this task did not change nginx or infrastructure.
- Current desktop source/package version: `0.1.17-rc.16`. Installed version could not be read through the restricted filesystem; do not infer it from repository version.
- Existing browser implementation is a hidden Electron BrowserWindow in `persist:loopcom-coworker-browser`, not installed Chrome. Its API cannot reuse Chrome sessions. Earlier rc.9 missing-hands diagnosis is historical and was not assumed to describe this installation.
- Existing normalized computer tools, local approval window, shared policy mirror, stdio MCP manager, filesystem fences, XLSX tools, journal, and server-side Claude/OpenAI model loop were retained. Server sends conversationId already; desktop now preserves it to scope browser tabs across turns.

## Current implementation

| Area | Files / behavior |
|---|---|
| Extension | `apps/desktop/browser-companion/`: MV3 module service worker, popup, isolated-world DOM executor, authentication module. No external-message handler, cookies permission, history permission, arbitrary model JavaScript, or remote scripts. |
| Transport | `src/coworker/browserCompanion/bridge.ts`: explicitly binds 127.0.0.1:39174; exact Host and extension Origin; HMAC-SHA256 packets both ways; request nonce echoed in signed reply; 30-second freshness; replay cache; request/body/concurrency caps. HTTP only permits authenticated extension polls/results/control, never model command submission. |
| Pairing | Desktop random 256-bit key encrypted through Electron safeStorage. Exact packaged Settings document + main-frame IPC check required to display key. Extension pairing state uses trusted-context-only extension storage. Key never enters manifest/model/journal. Pairing is local and currently manual. This is not protection against a compromised same-user OS account. |
| Tools | Nine `computer_chrome_*` tools: tabs, open, read, act, download, upload, screenshot, wait, close. Typed arguments checked before execution. Existing tool catalog, permissions and journal perform enforcement. Real Chrome manifest replaces the hidden-browser tools when ChromeRuntime is wired. Legacy browser calls explicitly fail then. |
| Risk policy | All potentially outward Chrome operations have `alwaysRequireApproval`; HIGH risk alone does not force approval in existing policy! This was checked and regression-tested. Browser journal records action/tab/outcome, not field values or raw page content. |
| Tab ownership | New tabs use active:false and conversation-scoped COWORKER ownership. USER tabs excluded from enumeration and execution. SHARED requires popup gesture; trusted user input pauses shared tab. Explicit tabId everywhere. Origin changes fail closed. |
| DOM/accessibility | Isolated-world structured roles/names/controls/tables and limited text. Password/OTP/payment controls excluded. References include document epoch and semantic signature; detached node can relocate only to a unique match. No XPath or coordinate guessing. This is a DOM-derived accessibility representation, not Chrome's complete accessibility tree. |
| Files | Download tracks a task-specific Chrome download ID, waits for completion, fences local source/destination, copies into workspace and registers artifact. Upload selects one locally approved fenced file via optional debugger DOM.setFileInputFiles; submission is separate. Both capped at 25 MB. |
| Screenshot | Optional Chrome debugger Page.captureScreenshot, bounded PNG, workspace artifact. **No model-vision transport or coordinate fallback implemented.** A saved screenshot is not proof of vision. |
| Packaging | Extension directory added to electron-builder files. Desktop compiles; win-unpacked build completed. No installer built/installed and no extension installed. Build had extensive npm extraneous/missing dependency diagnostics; clean-export rebuild plus asar dependency smoke test remains required. |

## Verification completed

1. Existing baseline Coworker suite: **39/39 PASS** (before code changes). Restricted shell initially failed inside tsx before tests due `uv_os_get_passwd ENOMEM`; approved elevated run succeeded.
2. Updated suite: **43/43 PASS**. New tests cover signature direction/key/tamper/expiry/version, unsafe URL/argument rejection, mandatory approval for all profiles, real loopback HTTP Origin/auth/replay rejection, command correlation and cancellation.
3. Desktop typecheck and TypeScript build: **PASS** using installed TS 5.9 with `--ignoreDeprecations 5.0`. Repository config requests TS6; TS6 also exists under .pnpm and should be used for release checks. Do not modify tsconfig to hide toolchain mismatch.
4. JavaScript syntax checks for extension and portal: **PASS**.
5. Installed Chrome, **isolated headless profile with Chromium sandbox enabled**, DOM component tests: **8/8 PASS**. These do not load the extension or use the actual agent. Exact form values received by controlled server; fake password excluded from page representation; Customer 73 amount 9125 in 10,000-row table; dynamic UI; dialog; semantic relocation after DOM replacement; stale ref across navigation refused; injection text stays data and read causes no upload; second page input unchanged.
6. First DOM test run failed because wrapping select labels included option text. Fixed accessible-name extraction to remove descendant controls and support aria-labelledby; rerun all 8 passed.

Commands:

```text
node --import tsx --test apps/desktop/src/coworker/*.test.ts
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.json --noEmit --ignoreDeprecations 5.0
node apps/desktop/scripts/browser-companion/dom-components.mjs
```

Component test toolchain: official npm `playwright@1.63.0`, installed under gitignored `scratchpad/browser-companion-toolchain`, no production dependency added. Raw evidence: `scratchpad/browser-companion-component-proof/{component-tests.json,portal-events.jsonl,component-form.png}`.

## Acceptance site

`apps/desktop/scripts/browser-companion/portal.mjs`: loopback-only, Host check, POST Origin check, body bound. Routes: form (fake password/checkbox/radio/select), 100/10,000-row table, CSV report, upload, dynamic UI, modal, replaced DOM, malicious instruction, workflow, canvas vision target. Server-side event log plus independent expected values at `/api/evidence`. Expected CSV: 100 rows, total **631250**, largest **12500**, Customer 73 **9125**. Multipart upload currently records body byte count/hash, not independently extracted file content/hash; improve this verifier before C6 acceptance.

## Required next work / known gaps

These are implementation or verification gaps, **not all external blockers**:

- Actual extension load, real-profile bridge pairing, Chrome downloads/uploads, full multi-tab ownership and stop semantics are untested. Audit worker cancellation (per-task cancellation currently relies on checkpoint; every in-flight mutation needs final authorization check) and reconnection before release.
- Test and fix bridge disconnect/extension reload/restarts, replayed side effects, protocol mismatch UI, tab closing, 50 tabs, concurrent conversations, large output bounds, network loss, download failure, authentication prompts, and extension credential rotation/revocation.
- Current site allowlisting is per-origin and manual. Redirect to another origin stops execution; popup has no completed reauthorization flow for an existing tab. Build that flow safely. No navigate-in-place tool, complete browser history, console/network diagnostics, or reusable deterministic workflows yet.
- DOM extraction only covers the main document (no frame or shadow DOM support). Hidden-text and credential leakage need adversarial coverage. Strict schema validation needs field-type/range completeness and extension-side validation parity.
- Approval currently shows tool/arguments with bounded generic description. Add independently observed target/site/action details, including external recipient/value and financial effects where identifiable; bind approval to unchanged page target. Never allow model assurances to authorize financial writes.
- DOM failures do not invoke model vision. Router currently stringifies tool results and desktopLink caps them at 60,000 chars. Implement bounded screenshot evidence through BOTH providers before claiming vision. Optional screenshot alone is insufficient.
- Human CAPTCHA/2FA/passkey pause/resume workflow not implemented. No bypass behavior should be added.
- Download → read → analysis → XLSX → response must run through actual chat and be independently checked. No such end-to-end run occurred.
- Background component test only proved DOM input isolation; it did NOT prove a human can actively use their Chrome tab while the extension works, nor zero OS focus/mouse interference in installed app.
- No real-provider tests (Claude or OpenAI), authenticated-session test, actual-agent prompt injection test, full security attack matrix, sustained resource/handle stress measurements, or packaged natural-language acceptance yet.
- Supported production distribution requires Chrome Web Store or legitimate managed enterprise deployment. No Chrome security switches/policy bypasses were used. Current public manifest key establishes deterministic development ID `alogeebhboibbnncnkchchogajlejnpp`; store-assigned production identity must be reconciled and pinned in bridge before release.
- Initial packaged build uses shared dependency tree and emitted diagnostics. Build from clean export, verify asar imports/icon/bridge files, produce NSIS installer, install on this machine, and repeat C1–C8 through installed Loopcom.
- UI interaction stopped by the owner. Do not resume Windows Computer Use without a new turn/request. App access repair belongs to another session.

## Release rule

**Local work in progress. No commit, push, deployment or installation performed.** A green test suite is not production readiness. Preserve unrelated shared-worktree changes. On continuation read this handoff and fresh CLAUDE.md, complete implementation/acceptance, update this file plus summary/index/MEMORY/TESTS_RUN, then commit only explicit owned paths. Do not publish this candidate while the above gaps remain.

## Open-source alternatives review — 2026-09-14

The observed stop was in the assistant's Windows automation tool while opening Chrome's extension manager. It occurred before the companion was loaded; it is not evidence that Chrome rejected this extension, that an open-source license failed a check, or that the bridge failed an installed runtime test. Separately, the product is unfinished: vision, both-provider real-agent tests, installation/pairing, restart/stress and the complete security matrix remain outstanding. Prior status messages put too much emphasis on the setup blocker.

Recommendation (assessment, not implemented or proven): use Microsoft Playwright as the browser execution engine behind Loopcom's existing normalized tool/MCP layer, retaining Loopcom-owned tab scopes, local approvals, upload fences and audit. The current MCP client can launch a JS stdio server, list its tools and call them, but exposes discovered tools generally; a constrained adapter is required before attaching broad browser tools to a personal profile. Do not expose arbitrary evaluate/script, credentials or unrestricted tabs. Generic MCP attachment is not a replacement for these safeguards.

- Playwright / Playwright MCP: Apache-2.0. Structured accessibility snapshots and browser automation. Dedicated browser profile can serve as an independent product mode without extension installation, but does not inherit the user's everyday Chrome login sessions and does not satisfy the original same-profile requirement on its own. Existing-profile modes use the published Playwright extension or supported CDP connection after Chrome setup/consent. Current docs also support connecting by channel name after remote-debugging consent.
- Chrome DevTools MCP: Apache-2.0. Official Chrome project using Puppeteer for automation, screenshots, network/console inspection. Default is a separate persistent profile. Chrome 144+ autoConnect supports existing sessions but requires chrome://inspect/#remote-debugging setup and browser permission. Broad profile access means it needs Loopcom ownership enforcement; it is not a turnkey production replacement or a guaranteed solution to this tool's internal-page limitation.
- Browser Use: MIT core; an alternative browser-agent framework. Lower fit as the first choice here because Loopcom already has its own model reasoning/tool orchestration. Switching frameworks does not itself supply the missing acceptance evidence or remove legitimate browser consent.

Primary sources inspected: https://github.com/microsoft/playwright-mcp ; https://github.com/microsoft/playwright.dev/blob/main/mcp/configuration/browser-extension.mdx ; https://github.com/ChromeDevTools/chrome-devtools-mcp ; https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md ; https://github.com/browser-use/browser-use ; repository license files. No alternative was installed, connected to the user profile, or tested through Loopcom in this review. No claim that an alternative has passed. No runtime changes or tests in this review.
