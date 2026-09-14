# ⛔⛔ AGENT HANDOFF — the Coworker HAS HANDS: three allowlisted tasks, approved on a card, run by the desktop app from its OWN allowlist (2026-09-02) — READ FIRST before adding a task kind, before touching `coworker_task`, `/coworker/tasks/*`, `apps/desktop/src/coworker/`, or before letting ANY message carry a path or a command to the desktop

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_COWORKER_BUBBLE_DEAD_2026-09-02.md` §10**
(one commit on `feat/ivr-migration-takeover` across shared + agent + api + portal +
desktop. Deploy state at the end of this section. No migration — the record is the
existing `AgentAction` table under `capabilityId: coworker.task.v1`; no PBX write;
no env change. Izzy, 2026-09-02: *"Approved, build the hands through the co-worker."*
✅ **portal DEPLOYED at `a39d5a22`, api at `8decf1fe` (the 404-first `/result` fix, 14:05Z), both
container-verified 2026-09-02, agent REBUILT and healthy** — `GET /coworker/tasks/pending` answers 200 with a real token and 401
without, `/desktop/coworker` 200 on both hostnames, the knowledge row rewritten 13:28Z, 0
`AgentAction` rows written by any probe. ⛔ **Desktop `Connect-Setup-0.1.17-rc.6.exe` is BUILT
and artifact-verified but NOT installed and NOT published** (feed stays 0.1.16) — both are
Izzy's call. Full deploy state: handoff §10.5.)
Memory: [[coworker-hands-built-three-tasks]] (replaces [[coworker-cannot-act-on-the-computer-yet]]).

- ✅ **THE CHAIN: agent PROPOSES → person APPROVES → desktop RUNS → api RECORDS.**
  `coworker_task` (agent, customer tier) writes a DRAFT `AgentAction`; the docked
  popover polls `GET /coworker/tasks/pending` and draws the what / where / why / undo
  card; "Do it" hits `POST /coworker/tasks/:id/approve` (single-use `updateMany`,
  30-min TTL → 410 + EXPIRED) and hands the RETURNED task to
  `window.coworkerWidget.runTask`; the desktop executes and the card posts
  `…/result` (once, APPROVED rows only). `my_computer_tasks` lets the assistant
  answer "did it finish?" from the row instead of from hope.
- ⛔⛔ **THE ALLOWLIST IS THREE KINDS ON THREE FOLDER NAMES, AND THE DESKTOP HOLDS
  ITS OWN COPY.** `folder_summary` / `organize_folder` / `system_snapshot` on
  `downloads` / `desktop` / `documents` — `packages/shared/src/coworker/tasks.ts`
  (specs, card, strict parse: an EXTRA KEY like `path` is refused) and
  `apps/desktop/src/coworker/tasks.ts` (the desktop cannot import the monorepo; a
  drift guard reads the shared file and fails if the lists differ). **The renderer
  is the hosted portal, so anything it can express a compromised server can
  express** — which is why `coworker:run` re-parses and re-decides on arrival, the
  folder is resolved from its NAME under `os.homedir()` and realpath-checked to
  still be inside home, and **no message anywhere carries a path or a command.**
- ⛔⛔ **MOVES ONLY, NEVER DELETE, NEVER OVERWRITE.** `organize_folder` renames
  top-level FILES into subfolders by type (Images / Documents / Spreadsheets / PDFs /
  Presentations / Installers / Archives / Videos / Audio / Other); a name clash gets
  " (2)"; folders, symlinks, hidden files, `~$` locks, `desktop.ini` and in-flight
  `.crdownload` files are never touched; a locked file is skipped and NAMED in the
  result. The desktop test greps `executor.ts` for `unlink|rm|writeFile` and fails on
  any. The full-path `moves` list stays on the desktop side (log + a future undo);
  the page gets names and counts.
- ⛔ **`coworker_task` REFUSES OUTSIDE THE BUBBLE** (`ctx.viewingPath` must start with
  `/desktop/coworker` — `ToolContext` gained `viewingPath` + `conversationId`, passed
  from `engine.ts`). A draft from a browser tab would sit forever with nothing to run
  it, and "it's on your screen" would be the unearned-fix class. ONE live draft per
  person; a policy `deny` never becomes a card; a write is `ask` under the SAFE
  profile (the default) and `allow` under TRUSTED — chosen in the popover's shield
  button, stored as `DesktopSettings.coworkerPermissions`; **a live call always turns
  a write back into ask** (`isPhoneOnCall()` reads `latestPhoneStateEnvelope`).
- ⛔ **`/coworker` is `permission: null` in `PORTAL_API_PERMISSION_RULES`** — the
  customer whose computer it is holds no admin key; every route is self-scoped
  (`tenantId` + `requestedBy = sub`) and a colleague's row is **404, never 403**.
  The api imports no `fs`/`os`/`child_process` (guard-tested): **the api runs nothing.**
- ⛔⛔ **THE PROMPTS WERE REWRITTEN, NOT APPENDED.** The 2026-09-02 morning wording
  "the Coworker cannot act on the computer" is gone from `SYSTEM_PROMPT`,
  `STAFF_SYSTEM_PROMPT`, both `viewingBlock` branches and
  `docs/agent-knowledge/system.md` — a prompt that still says "cannot" beside a tool
  that can is [[a-capability-the-prompt-denies-is-not-a-capability]]. The tests that
  pinned the OLD wording (`coworkerAwareness.test.ts`, `agentKnowledgeCoworker.test.ts`)
  were updated to pin the NEW one; do not "fix" them back.
- ⛔ **`@connect/shared/coworker` is a NEW subpath** (package.json `exports` +
  `tsconfig.base.json` `paths`); the root index still exports only diagnostics.
- ✅ **Proven:** shared 10/10 + full suite 572/572; desktop 15/15 + full 192/192;
  agent 15/15; api 11/11 (real Fastify, fake db); portal 9/9 + full 517/519 (the two
  documented pre-existing). **Eleven source guards, every asserted symbol reads 0 in
  `HEAD`.** Typechecks: shared/desktop/portal 0, agent 14 = baseline, api 81 with 0 in
  any touched file (+5 are another session's remoteSupport/webrtc files).
- ⏳ **NOT PROVEN: nobody has typed "organize my Downloads" into the bubble and
  pressed the button.** The desktop half rides rc.6 and is on no machine
  until Izzy says install; the fleet feed stays 0.1.16. Acceptance (§10.4): from a
  browser tab the assistant must say it only works from the bubble; from the bubble a
  folder count lands in chat and the row reads EXECUTED; an organize moves files into
  subfolders with nothing deleted; **the negatives: No → DENIED and no file moved; on
  a live call the write waits; a second window pressing the same card gets "already
  answered".**
