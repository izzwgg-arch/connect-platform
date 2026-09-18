## ⛔⛔⛔ HOW THIS FILE IS ORGANISED — KEEP CLAUDE.md SMALL (adopted from Connect, 2026-09-17)

`CLAUDE.md` is loaded automatically into EVERY session, every turn. In the Connect repo it
once grew to **1.7 MB (~400,000 tokens)** because every task appended a full handoff
section to it. That cost ~400k tokens per session and buried the rules nobody could find.
Izzy: *"put in the project rules to keep doing it that way so it stays the right way."*
The same rule applies here from day one:

- **This file holds ONLY standing rules + an index.** The rules are the sections below.
  The index (bottom of this file, "HANDOFF INDEX") has one line per area, pointing at
  that area's summary file in `docs/ai-context/claude-md-sections/`.
- ⛔ **START of a task:** read this file (it is short), find your area in the HANDOFF
  INDEX, and OPEN that summary file **and** the full handoff it names before the first
  tool call. Search the index for any keyword you are unsure of (`grep -i` the index or
  `docs/ai-context/claude-md-sections/`). Not opening them is skipping the gate.
- ⛔ **END of a task:** update the area's summary file (or create one named
  `YYYY-MM-DD-short-slug.md`), the full handoff, `TESTS_RUN.md` if you ran tests, and
  memory. Then add or refresh that area's **single index line** here (date · title ·
  path, one line, no bullets under it). That index-line edit IS the required
  "update CLAUDE.md".
- ⛔⛔ **NEVER add a handoff section, a findings list, or multi-line bullets to this
  file.** New standing rules (applying to ALL work, not one area) may be added above
  the index, kept short. **Size budget: this file stays under 80 KB.** If it goes over,
  the fix is to move content OUT into a summary file, never to raise the budget.
- The legacy status files in the repo root (`DEPLOYMENT-*.md`, `IMPLEMENTATION-*.md`,
  `FINAL-*.md`, etc.) predate these rules. They are history, not rules. Do not add to
  that pattern; new write-ups go under `docs/ai-context/`.

## ⛔⛔⛔ THE GATE — READ THE MD FILES BEFORE YOU START, UPDATE THEM BEFORE YOU FINISH. THIS IS THE FIRST THING IN THIS FILE BECAUSE IT IS THE BIGGEST GATE THERE IS.

**Core project rule (Izzy, reaffirmed 2026-09-14 on Connect, extended to this project
2026-09-17):** Read `CLAUDE.md` freshly at the start of every user task, before doing the
work. After finishing the work, update the MD files before the final response. Every task,
every time, including small tasks, repository refreshes, and documentation-only work. A
prior read or remembered summary is not a substitute. Reading these instructions is the
necessary first action. This rule is also recorded at the top of `AGENTS.md` and in the
persistent project memory `MEMORY.md`.

Izzy, 2026-09-11, verbatim: *"Never, ever, ever, ever start a task without reading the MD
files. Never, ever finish a task without updating the MD files. Ever. It's the biggest
gate out there."*

⛔ **BEFORE the first tool call of any task** — read this file, then the area's summary in
`docs/ai-context/claude-md-sections/` (find it in the HANDOFF INDEX at the bottom) AND the
`docs/ai-context/AGENT_HANDOFF_*.md` it names, for the area you are about to touch. The
handoff for that exact area almost certainly records the trap you are about to walk into.
⛔⛔ **Reading CLAUDE.md's summary bullets is NOT reading the MD files** — the summary
tells you a feature exists; the handoff tells you how it fails.

⛔ **BEFORE reporting done** — update the area's summary file + its ONE index line in
`CLAUDE.md` (never a new section here), the matching handoff, `TESTS_RUN.md` if you ran
tests, and memory + `MEMORY.md`; then commit → push → deploy and tell Izzy which files you
touched. Full procedure: **THE TWO RULES THAT WRAP EVERY TASK**, below.

⛔⛔ **WHAT SKIPPING IT COSTS — a worked example from Connect, 2026-09-11, on a LIVE
customer line.** An agent worked off CLAUDE.md's summary plus live reads and skipped the
area handoff. It hand-edited a tenant inbound route. The handoff said in its own words
that a reconciler regenerates that file, so any hand edit reverts. The reconciler reverted
the edit **three separate times**, each within minutes. Three failed attempts, a live
customer's main number re-pointed and reverted repeatedly, and Izzy had to give the
instruction twice. ⛔ **Ten minutes of reading would have cost nothing and saved all of it.**

# Loopcom App (formerly Trim Pro) — working rules for Claude

## ⛔⛔ WHERE THIS FOLDER LIVES NOW (2026-09-18) — read before any git command

Izzy, 2026-09-18: *"For committing and pushing, use the regular Loopcom Connect Git repo."*
This folder is now **`Loopcom works/` inside `C:\dev\projects\Connect 2`** (GitHub
`izzwgg-arch/connect-platform`). Its own nested `.git` was moved to
`C:\dev\projects\_backups\loopcom-works-nested-git-2026-09-18\`. Work is committed on the
Connect branch **`works/loopcom-works`** via the private worktree `C:\dev\projects\c2-works`
(never in the shared tree, which other sessions edit). ⛔ Never push to `izzwgg-arch/Trimpro`.
The product is **LoopCom Works** (`https://works.loopcom.net`); the full plan, the eight audits and
the mockups are in the CONNECT repo: `docs/ai-context/AGENT_HANDOFF_LOOPCOM_WORKS_2026-09-18.md`,
`docs/ai-context/loopcom-works-audit/`, `docs/mockups/loopcom-works/mockups-v1.html`. The
sections below (written 2026-09-17 for the `trim pro 2` checkout) still hold as RULES; where they
describe the old repo layout (`loopcom` branch, "no remote"), the paragraph above wins.

## ⛔⛔ WHAT THIS PROJECT IS (2026-09-17)

This repo is the Trim Pro field-service app being repurposed as a **joint project with
Loopcom** (Loop Communications). Decided by Izzy 2026-09-17:

- **Two servers, one UI.** This app runs on its own server, separate from the Connect
  server. An **API between the two servers** lets Loopcom control the whole thing, and the
  whole thing is presented inside the **Loopcom UI**. Loopcom is the front door.
- **Look:** reskin only, matched to the Loop Customer Portal, light AND dark mode. No
  layout, option, or feature changes in the reskin. Approved mockups:
  https://claude.ai/code/artifact/23d3619c-a195-49c7-b4fd-b03a1a50b079
- **Git:** `izzwgg-arch/Trimpro` on GitHub is the untouched source of truth for the
  ORIGINAL app. ⛔ **Never push Loopcom work to that remote.** The Loopcom version lives on
  the local `loopcom` branch until Izzy provides its own separate repository; then that
  branch gets its own remote. `restore/pluto-final` stays a clean mirror of origin (the
  session-start hook in `.claude/git-sync.ps1` fast-forwards it).
- **Same rules as Connect.** Everything in this file is the Connect rulebook applied here.
  Where Connect has a server-specific procedure (SSH, deploy queue, PBX) this project does
  not have one yet — see "Server access" below — and the placeholder must be filled in the
  moment a server exists, not after.

## ⛔⛔ BROWSE IN REAL CHROME, NEVER THE IN-APP BROWSER PANE (2026-08-31, Izzy's standing instruction) — the pane CRASHES CLAUDE DESKTOP on this machine

Izzy, 2026-08-31: *"always use the browser that doesn't crash Claude Desktop."*

- ✅ **USE `mcp__claude-in-chrome__*`** — his real Chrome, driven by the extension. It
  renders in **Chrome's** process tree, so if its GPU dies Chrome recovers by itself and
  Claude Desktop never notices. Measured on Connect: **836 calls in one day, zero
  attributable crashes.**
- ⛔⛔ **NEVER USE `mcp__Claude_Browser__*` (the in-app Browser pane) — it kills the app,
  usually within seconds.** It renders inside Claude Desktop's OWN process tree, so its
  compositing goes through Claude's GPU process, and this machine's **Intel HD Graphics
  4000 driver (2012, `10.18.10.5161`, terminal)** cannot survive it. Every death is the same
  `GPU process gone … exitCode: 101457950`. This is a MACHINE property, so it applies to
  this repo exactly as it applies to Connect.
- ⛔⛔ **THE TOOL'S OWN DESCRIPTION TELLS YOU TO DO THE DANGEROUS THING** — it reads *"the
  in-app browser… Default to this."* **This file overrides it.**
- ⛔ **A single clean pane open proves NOTHING** — the failure rate sits around 40–90%, so
  surviving once is the expected outcome. The dev-server preview for THIS app is therefore
  opened in real Chrome at `http://localhost:3000`, never via `preview_start`.
- **Triage recipe if it recurs:** the live log is `%LOCALAPPDATA%\Claude\Logs\main.log`;
  `grep -aE "Created browser preview|GPU process gone" main.log` gives the trigger→crash
  timeline in one command.

## ⛔⛔ THE TWO RULES THAT WRAP EVERY TASK (2026-08-16, Izzy's standing instruction) — these are not optional and they are never waived by "it's a small change"

**START of every prompt / every task — READ THE MD FILES FIRST.** Before any
investigation, any edit, any command: read this file (`CLAUDE.md`) and the relevant
`docs/ai-context/AGENT_HANDOFF_*.md` handoffs for whatever you are about to touch. ⛔ Do
not start work off memory, off the file tree, or off a guess about what a system does.
Izzy should never have to say "read the MD files."

**END of every task — UPDATE THE MD FILES, AUTOMATICALLY.** Izzy will never ask you to.
Before you report a task done:
1. **Update the area's summary file in `docs/ai-context/claude-md-sections/`** — edit the
   existing one so it stops being wrong, or create a new one — and add or refresh its ONE
   index line at the bottom of `CLAUDE.md`. ⛔ Never paste a handoff section into
   `CLAUDE.md` itself. Say plainly what is DEPLOYED and verified vs ⏳ NOT PROVEN.
2. **Write/update the full handoff** under `docs/ai-context/` when the work has detail
   that does not fit in a summary bullet.
3. **Update the memory files** under the memory dir + its `MEMORY.md` index when the
   lesson outlives this repo state.
4. ⛔ **Tell Izzy in your reply that you updated them, and which files.** An update he
   doesn't know about is an update that didn't happen.

**THE WORK TREE MUST BE EMPTY BY THE END OF THE DAY.** So every finished task ends:
**commit → push → deploy.** Not "committed, will push later."
- ⛔ Stage **explicit paths, never `git add -A`** — other sessions may edit this same tree
  (see [[shared-worktree-commit-hazard]]), and CLAUDE.md in particular often carries
  another session's in-flight text. Check `git status` and `git diff --cached --name-only`
  before every commit.
  ⛔⛔ **STAGING EXPLICIT PATHS IS NOT ENOUGH — proven the hard way on Connect
  2026-08-16.** `git add <mine> && git diff --cached --name-only && git commit -m …` as
  ONE chained command swept another session's staged files into the commit, because they
  staged in the gap between the `add` and the `commit`. **Always `git commit -F - --
  <explicit paths>`** (the pathspec makes the rest of the index irrelevant), and run the
  staged-list check as its **own** command that you actually read first.
  ⛔⛔ **AND "CLEAR THE WORK TREE" IS A TRIAGE, NEVER `git add -A` + commit.** A file that
  is `MM` but ABSENT from `git diff HEAD` has HEAD == worktree, so only the INDEX is stale
  → `git add` those paths. **A WORKTREE file can be OLDER than HEAD**, so "commit
  everything dirty" can write a FALSE record. ⛔ **Direction is PER FILE and must never be
  assumed — read the diff.** Four buckets: index stale → `git add`; worktree stale →
  `git checkout HEAD --`; real work → commit by pathspec; artifacts → delete. **Back up
  anything you discard to the scratchpad first.**
- ⛔ **Until the Loopcom repo has a remote, "push" means: commit on the `loopcom` branch
  and SAY in the reply that it is unpushed because the remote does not exist yet.** The
  moment the remote exists, push everything outstanding. Never push to
  `izzwgg-arch/Trimpro`.
- Deploy per the deploy section below once one exists, then **verify the running
  service**, and say so.
- If something genuinely cannot be deployed (a change Izzy has to approve, no server
  yet), say that explicitly in the reply instead of quietly leaving it — an unstated gap
  is how "it's fixed" becomes false.

## ⛔⛔ THE THIRD RULE THAT WRAPS EVERY TASK (2026-08-23, Izzy's standing instruction) — NEVER PROPOSE A FIX WITHOUT FIRST CHECKING WHAT IT BREAKS

Izzy, verbatim: *"Never fucking suggest a fix to me that will break something else, ever …
Check before you fucking do something. Stop giving me suggestions on stuff, fixes, and
patches without even fucking checking what it's gonna break."*

- ⛔⛔ **A fix is not proposable until its blast radius has been TRACED, not guessed.** Do
  the tracing BEFORE you offer it. Handing him a fix with an attached "the risk is…" list
  is the failure itself — it moves the checking work onto him.
- ⛔ **Before proposing ANY change:** `git grep` the symbol, find every caller, every
  branch, every consumer. Read each call site. If you are moving code between two
  branches, DIFF THE TWO BRANCHES and state the delta as a verified fact, never as a
  suspicion.
- ⛔ **If you have not checked, do not propose it.** Say you are checking, then check.
- ✅ **Prefer a fix that is a provable RESTORE to a known-good state** over a new design —
  it is the only kind whose blast radius can be fully enumerated.
- **Show concrete user-visible proof before claiming something works** (Izzy, 2026-09-16).
  Green tests, clean typechecks and container greps are not proof. State any unverified
  leg explicitly.
- ⛔ **"Fixed" means a human did the thing and it worked.** For this app that means the
  page opened in a real browser and the action completed, not that `next build` passed.

## ⛔⛔ THE FOURTH RULE THAT WRAPS EVERY TASK (2026-08-31, Izzy's standing instruction) — A NEW PAGE IS NOT DONE UNTIL IT HAS ITS TOGGLES

Izzy, verbatim: *"whenever we build a new page, there should be a toggle for it in its
section, on and off, and in custom roles, roles for everything, toggles for all
permissions. Always, always, always."*

- ⛔⛔ **Shipping a page without its toggles is shipping half a page.** In THIS repo the
  three things that land in the SAME commit as any new sidebar page are:
  1. its entry in the nav list in **`components/layout/sidebar.tsx`** (with its
     `permission` key);
  2. its module + permission keys in **`lib/permissions-page-modules.ts`** /
     **`lib/permissions-catalog.ts`** (this is what `/dashboard/settings/roles` renders);
  3. the seed (`prisma/seed.ts`) granting it to the system roles that should have it, plus
     a toggle for EVERY permission key the page adds.
- ⛔⛔ **The failure this rule is made of: there were TWO permission editors on Connect and
  fixing one was the default mistake** — 23 real pages ended up with no toggle anywhere in
  custom roles. **Never fix one permission surface without checking every other one that
  reads the same catalog.** In this repo, `git grep` the permission key across `lib/`,
  `app/api/`, `components/permissions/` and the mobile app before calling it done.
- ⛔ **A toggle that lies is worse than no toggle.** If a page is force-gated somewhere
  (role check in a route guard, `RoutePermissionGuard`), the roles editor must show that
  gate, not offer a live switch that does nothing.

## Server access (ALWAYS APPLY) — ⏳ NOT YET DEFINED FOR THIS PROJECT

Connect's canonical method (stage the repo key from a git-ignored `.connect-ssh/`-style
folder, `ssh -i` from the Linux sandbox, never through the PowerShell MCP) is the template.
**This app's server does not exist yet.** When it does, fill this section in the same
shape: name · role · host · key file · exact copy-pasteable login, plus guardrails. Until
then the only environment is local (`npm run dev` on port 3000, Postgres on
`localhost:5432/trimpro`, `.env` git-ignored).

Hard guardrails that carry over regardless of server:
- Never touch payments (Sola, QuickBooks sync) on a live box without Izzy's explicit,
  per-operation permission.
- The Connect server and the PBX are **out of scope for this repo entirely**. This app
  talks to Loopcom only through the API that will be built between the two servers.
- Deploy/restart only via whatever queue or script this project adopts; no ad-hoc
  `docker compose` / `prisma migrate` on a server by hand.

## Other standing rules
- Schema changes go through `prisma/schema.prisma` + a migration under `prisma/migrations/`
  (the repo also uses `db push` locally; production must use migrations).
- Tests: the suites are `node:test` — run `npx tsx --test tests/*.test.ts` (NOT vitest; `qbo-line-amounts.test.ts` alone imports vitest and fails without it).
  Record every run in `TESTS_RUN.md`.
- Branding is data-driven (`BrandingSettings` + `components/branding/BrandingProvider.tsx`
  → `--brand-*` CSS vars). The reskin goes through that layer, not through component edits.
- Memory dir for this project:
  `C:\Users\izzyw\.claude\projects\C--dev-projects-trim-pro-2\memory\` (index `MEMORY.md`
  there; the repo-root `MEMORY.md` is the on-disk copy other agents can read).

## HANDOFF INDEX — one line per area (newest first; add new ones at the top)

- 2026-09-18 · LOOPCOM WORKS — folder moved into the Connect repo; inventory (8 audits), architecture and 30-board mockups DONE; **the looks-only reskin + rebrand is BUILT** (palette-by-CSS-vars in `tailwind.config.ts` + `lib/branding/loopcom-palette.ts`, portal tokens/shell/dark mode in `app/globals.css`, Signal Core assets in `public/brand/`, 59-file string sweep, mobile rebranded) and click-through-proven on a prod build (`tests/e2e/reskin-clicks.js`); run `npm run dev:3001`; ⛔ prod build redirects localhost → use `http://works.localtest.me:3002`; 13 CRITICAL security findings still to fix (next phase) → Connect repo `docs/ai-context/claude-md-sections/2026-09-18-loopcom-works-audit-architecture-mockups.md`

- 2026-09-17 · PROJECT RULES ADOPTED FROM CONNECT + LOOPCOM JOINT-PROJECT DECISION (two servers, API between, Loopcom UI is the front door; separate repo pending; `loopcom` branch; sync hook) → `2026-09-17-project-rules-adopted-from-connect.md`
- 2026-09-02 · LOOPCOM RESKIN MOCKUPS (light + dark, matched to the Loop Customer Portal; 13 artboards; approved look, NOT built) → `2026-09-02-loopcom-reskin-mockups.md`
