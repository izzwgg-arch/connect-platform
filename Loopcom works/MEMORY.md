# Loopcom app (formerly Trim Pro) — project memory

## Fundamental task rule — owner instruction, 2026-09-14 (Connect), extended here 2026-09-17

Every time Izzy gives an agent a task:

1. Read `CLAUDE.md` freshly before starting the work. The instruction read itself is the
   first action; do not substitute prior context or memory.
2. After completing the work, update the docs before reporting completion. Record the
   outcome, evidence, and unresolved work accurately. Details go in the area's file under
   `docs/ai-context/claude-md-sections/`; `CLAUDE.md` gets only that area's ONE index line
   (it is rules + index only, under 80 KB — never append a handoff section to it).
3. Apply this to every task, including small tasks, repository refreshes, and
   documentation-only work. Never wait for a reminder.

The agent entry point `AGENTS.md` and `CLAUDE.md` both carry this rule so future sessions
can recover it from disk.

## Project decisions (newest first)

Moved into the Connect repo (2026-09-18): this folder is `Loopcom works/` in `connect-platform`, branch `works/loopcom-works` (worktree `C:\dev\projects\c2-works`); nested `.git` backed up to `C:\dev\projects\_backups\`. Product name LoopCom Works, domain works.loopcom.net. Inventory, architecture and mockups done; nothing built; 13 critical security findings first. See the Connect handoff `AGENT_HANDOFF_LOOPCOM_WORKS_2026-09-18.md`.

Joint project with Loopcom (2026-09-17): this app runs on its own server; an API between
that server and the Connect server lets Loopcom control the whole thing; the whole thing
is shown inside the Loopcom UI. Same MD-file rules as Connect, copied into this repo.
`izzwgg-arch/Trimpro` on GitHub stays the untouched original; Loopcom work lives on the
local `loopcom` branch until Izzy provides a separate repository. Never push Loopcom work
to the Trimpro remote. No local backup copy was made: git is the backup.

Repo sync (2026-09-17): `restore/pluto-final` is kept as a fast-forward mirror of origin
by `.claude/git-sync.ps1`, run from a SessionStart hook in `.claude/settings.local.json`.
The script refuses to merge if the branch has diverged or local edits collide, and logs to
`.claude/git-sync.log`. An every-five-minutes Windows scheduled task was proposed and NOT
registered.

Reskin mockups (2026-09-02, revised same day): look must match the Loop Customer Portal
(portal.loopcommunications.com), not the marketing site. Light + dark for every screen.
Canvas: https://claude.ai/code/artifact/23d3619c-a195-49c7-b4fd-b03a1a50b079. Not built.
Tokens map 1:1 onto the app's `--brand-*` vars; dark mode goes in the unused `.dark` block.

Multi-tenant state (2026-09-02): Tenant model exists, 61/87 models carry tenantId, but no
host-based tenant resolution and no tenant provisioning; effectively single-tenant. All
276 API routes use session auth; no API-key model. Telephony placeholders exist (VitalPBX
WebRTC, VoIP.ms SMS in the integration registry).

## Where the fuller memory lives

`C:\Users\izzyw\.claude\projects\C--dev-projects-trim-pro-2\memory\` (index `MEMORY.md`
there). This repo-root file is the on-disk copy other agents can read.
