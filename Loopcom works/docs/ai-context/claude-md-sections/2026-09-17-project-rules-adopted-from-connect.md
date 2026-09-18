# ⛔⛔ AGENT HANDOFF — project rules adopted from Connect; Loopcom joint-project decision; `loopcom` branch; repo sync hook (2026-09-17) — READ FIRST before any task in this repo, and before touching `.claude/`, the branch layout, or anything that pushes

Full handoff: **`docs/ai-context/AGENT_HANDOFF_PROJECT_RULES_2026-09-17.md`**.
Memory: [[project-loopcom-repurpose]], [[trimpro-multitenant-state]].

- **What happened:** Izzy: *"we're going to follow the same MD file rules as in Connect …
  Copy all the project rules from Connect. Same rules apply to this project."* The Connect
  rulebook (`CLAUDE.md`, `AGENTS.md`, `MEMORY.md`, `TESTS_RUN.md`, `docs/ai-context/` with
  `claude-md-sections/` summaries + `AGENT_HANDOFF_*.md` full handoffs) was copied into this
  repo, adapted only where Connect names a Connect-specific system.
- **What the project is now:** a **joint project with Loopcom**. Two servers; an API between
  them lets Loopcom control the whole thing; the whole thing is shown inside the Loopcom UI.
  Reskin first (light + dark, matched to the Loop Customer Portal; mockups approved, not
  built), then multi-tenant + the cross-server API.
- **Git layout (decided the same day):** `izzwgg-arch/Trimpro` = untouched original, never
  receives Loopcom work. New local branch **`loopcom`** (cut from `restore/pluto-final` at
  `699c049`) holds Loopcom work until Izzy provides a separate repository. No local backup
  folder: git is the backup. `restore/pluto-final` stays a clean mirror of origin.
- **Sync hook:** `.claude/git-sync.ps1` fast-forwards the checked-out branch to its upstream
  (refuses on divergence or collision; logs to `.claude/git-sync.log`). Wired as a
  `SessionStart` hook in `.claude/settings.local.json`. ⛔ On the `loopcom` branch it logs
  "no upstream" and does nothing — that is correct until the new remote exists. `.claude/`
  is in `.git/info/exclude`, so it is never committed.
- **Rule adaptations (the only deltas from Connect):** Fourth rule's three files are
  `components/layout/sidebar.tsx` + `lib/permissions-page-modules.ts` /
  `lib/permissions-catalog.ts` + `prisma/seed.ts`. "Server access" is a placeholder: no
  server yet. Deploy queue: none yet; "deployed" may not be claimed. Task-dashboard
  signature reserved: `SIG::CURSOR-LOOPCOM-APP-01`.
- ✅ **Done:** rule files written; `loopcom` branch created; committed by pathspec.
  ⏳ **Unpushed** — the Loopcom remote does not exist yet.
- ⏳ **NOT PROVEN / open:** the SessionStart hook has not fired in a new session yet (the
  settings file was created mid-session; open `/hooks` once or restart). Loopcom repo URL
  pending. Server pending.
