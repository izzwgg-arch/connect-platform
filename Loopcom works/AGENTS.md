# Core project rule — every task, every time

Owner instruction reaffirmed 2026-09-14 on Connect; extended to this project 2026-09-17.
Applies to every agent (Claude, Cursor, Codex, any subagent) working on the Loopcom app.

1. Read the repository's `CLAUDE.md` at the start of **every user task**, before
   investigation, commands, or edits. Reading the instructions themselves is the necessary
   first action. Prior reads, summaries, and memory do not replace a fresh read.
2. After completing the work, update the docs **before the final response**, recording the
   outcome, verification, and anything still unresolved. This applies even to small tasks,
   repository refreshes, and documentation-only tasks. ⛔ `CLAUDE.md` holds ONLY standing
   rules + a one-line-per-area HANDOFF INDEX: write the details to that area's file in
   `docs/ai-context/claude-md-sections/` (and its full `AGENT_HANDOFF_*.md`), then
   add/refresh its single index line in `CLAUDE.md`. Never paste a handoff section into
   `CLAUDE.md` — it is loaded into every session and must stay under 80 KB.
3. Keep this rule in persistent project memory (`MEMORY.md`). Do not wait for the user to
   remind you. Name the updated documentation in the final response.

# Where this folder lives (2026-09-18)

Inside the Connect repo (`C:\dev\projects\Connect 2\Loopcom works`, GitHub `izzwgg-arch/connect-platform`), committed on branch `works/loopcom-works` through the worktree `C:\dev\projects\c2-works`. The Connect `AGENTS.md`/`CLAUDE.md` rules apply on top of this file. Never push to `izzwgg-arch/Trimpro`.

# What this repo is (read `CLAUDE.md` → "WHAT THIS PROJECT IS" for the full version)

The Trim Pro field-service app, being repurposed as a joint project with Loopcom. It will
run on its own server; an API between that server and the Connect server lets Loopcom
control it, and it is presented inside the Loopcom UI. The GitHub remote
`izzwgg-arch/Trimpro` is the untouched original and must never receive Loopcom work.
Loopcom work goes on the local `loopcom` branch until its own repository exists.

# Agent deployment rules

> Read this file **before every deploy-related action.**

⏳ **There is no server and no deploy queue for this project yet.** Until there is:

- The only environment is local: `npm run dev` on port 3000, Postgres at
  `localhost:5432/trimpro`, schema applied with `npm run db:push`.
- "Deployed" may not be claimed for anything. Say "verified locally in a real browser" and
  name the page and the action that was exercised.
- When a server is provisioned, copy Connect's deploy-queue model (`AGENTS.md` there,
  `docs/safe-deploy-queue.md`): all deployments through a queue, never `docker compose`,
  `pnpm build`, or `prisma migrate` by hand on the server; agents enqueue, never deploy
  directly. Fill in `CLAUDE.md` → "Server access" the same day.

# Absolute guardrails (carry over from Connect, apply from day one)

- ⛔ The Connect server (45.14.194.179) and the PBX (209.145.60.79) are **out of scope for
  this repo**. This app never SSHes to them, never reads their databases, never calls their
  internal routes. The only path between the two systems is the API that will be built
  between the two servers.
- ⛔ Never touch payments (Sola, QuickBooks) on any live system without Izzy's explicit,
  per-operation, in-the-moment permission.
- ⛔ Never `git add -A`. Stage explicit paths; commit with `git commit -F - -- <paths>`.
  Full reasoning in `CLAUDE.md` → "THE TWO RULES THAT WRAP EVERY TASK".
- ⛔ Never propose a fix whose blast radius you have not traced. `git grep` every caller
  first. `CLAUDE.md` → "THE THIRD RULE".
- ⛔ A new page ships with its sidebar entry, its permission keys in the catalog, and its
  role toggles, in the same commit. `CLAUDE.md` → "THE FOURTH RULE".
- ⛔ Browse in real Chrome (`mcp__claude-in-chrome__*`), never the in-app browser pane.
  `CLAUDE.md` → "BROWSE IN REAL CHROME".

# Task-dashboard signature routing (ALWAYS APPLY, if the dashboard is used for this repo)

Every task added to the jacob-dev-orchestrator task dashboard MUST carry a routing
signature in its title and detail, so only the intended agent claims it. Put it in BOTH the
title (`[SIG::…] …`) and the first line of the detail (`ROUTING SIGNATURE: SIG::… — …`).
Signatures are per agent and STABLE; never invent a per-task one.

Current signatures:
- `SIG::CURSOR-LOOPCOM-APP-01` — reserved for the Cursor agent that will work this repo.
  (Rename on Izzy's request; if renamed, update it everywhere.)
