# AGENT HANDOFF — Project rules adopted from Connect, Loopcom joint-project decision, branch layout, repo sync (2026-09-17)

Summary line lives in `docs/ai-context/claude-md-sections/2026-09-17-project-rules-adopted-from-connect.md`
and the HANDOFF INDEX in `CLAUDE.md`.

## 1. What Izzy said, in order (2026-09-17, one session)

1. *"Sync the local repo again with Git, and make sure it stays synced with Git. Git is
   the source of truth."*
2. Asked for a backup copy of the folder, then withdrew it: *"no need, because we have the
   git. The git is going to be the source of truth, but our version is going to be
   committed to our [own] git."*
3. *"For this project, we're going to follow the same MD file rules as in Connect. In fact,
   this is going to be a joint project in Loopcom. They're going to be on different
   servers, but there will be an API in between both servers that would pretty much let
   Loopcom control the whole thing. The whole thing would be on the Loopcom UI, but on a
   different server. We have to follow the same rules with the MD files, just like we're
   doing in Connect. Same project rules. Copy all the project rules from Connect. Same
   rules apply to this project."*

## 2. What was copied from Connect and what was adapted

Source: `C:\dev\projects\Connect 2\` — `CLAUDE.md` (743 lines, rules + index),
`AGENTS.md`, `MEMORY.md`, `TESTS_RUN.md`, `docs/ai-context/claude-md-sections/*.md`
(297 summaries), `docs/ai-context/AGENT_HANDOFF_*.md` (248 handoffs).

Copied verbatim in spirit and mostly in wording:
- KEEP CLAUDE.md SMALL (rules + one-line index only; 80 KB budget; summaries in
  `claude-md-sections/`, full handoffs in `AGENT_HANDOFF_*.md`).
- THE GATE (read MD files before the first tool call, update them before reporting done,
  every task, no exceptions), including the worked example of what skipping it cost.
- BROWSE IN REAL CHROME, never the in-app pane. This is a MACHINE property (the Intel HD
  4000 driver), so it applies to this repo as-is. ⛔ Note: this same session used the
  in-app pane many times before the rule was copied over. It did not crash this time. Per
  the rule, that proves nothing; from now on the dev server is viewed in real Chrome.
- THE TWO RULES (read first / update after; work tree empty by end of day; commit →
  push → deploy; explicit pathspecs, never `git add -A`; `git commit -F - -- <paths>`;
  the per-file direction triage).
- THE THIRD RULE (never propose a fix without tracing its blast radius; user-visible
  proof, not green tests).
- THE FOURTH RULE (a new page ships with its toggles in the same commit).
- Task-dashboard signature routing.
- The `AGENTS.md` core rule and its deploy-rules shape.

Adapted, because Connect names Connect-specific systems:
| Connect | This repo |
|---|---|
| `apps/portal/navigation/navConfig.ts` + `/admin/permissions` + `/admin/roles/[id]` | `components/layout/sidebar.tsx` + `lib/permissions-page-modules.ts` / `lib/permissions-catalog.ts` + `prisma/seed.ts`; roles editor at `/dashboard/settings/roles` |
| SSH to loopcom / pbx from the Linux sandbox | ⏳ No server yet. Section is a placeholder that must be filled the day a server exists. Connect server + PBX are explicitly OUT of scope for this repo. |
| Deploy queue (`/ops/deploy/enqueue`) | ⏳ None yet. "Deployed" may not be claimed. |
| `SIG::CURSOR-CONNECT-01` | `SIG::CURSOR-LOOPCOM-APP-01` reserved |
| PBX read-only guardrail | Replaced by: never touch payments (Sola, QBO) live without per-op permission |

Not copied: the 297 area summaries and 248 handoffs. They are Connect's history, not
rules. Two summaries were written fresh for this repo (this one and the reskin mockups).

## 3. Branch and remote layout (decided this session)

- `origin` = `https://github.com/izzwgg-arch/Trimpro.git`. **Untouched original.** Never
  receives Loopcom work.
- `restore/pluto-final` = the branch the other machine pushes to. Kept as a fast-forward
  mirror of `origin/restore/pluto-final`. Tip at the time of this handoff: `699c049`
  (2026-09-17 18:33 +0200, "Add Job Name/Stage to Production card, port Production board
  to mobile").
- `loopcom` = new local branch cut from `699c049`. All Loopcom work goes here. **No remote
  yet.** When Izzy provides the Loopcom repository URL: `git remote add loopcom <url>` and
  `git push -u loopcom loopcom`.
- No backup folder was made. Izzy withdrew that request; git is the backup.

## 4. Repo sync hook

- `.claude/git-sync.ps1`: fetches origin; if the checked-out branch has an upstream and is
  strictly behind, `git merge --ff-only`; if diverged or the merge fails, logs and exits
  without touching anything. Logs to `.claude/git-sync.log`, and notes when
  `prisma/schema.prisma` or `package.json` changed so the reader knows to run
  `npm run db:push` / `npm install`.
- Proven: rewound `restore/pluto-final` one commit, ran the script, it fast-forwarded
  back to `699c049` and logged it.
- Wired as a `SessionStart` hook in `.claude/settings.local.json` (created this session;
  ⏳ has not fired in a fresh session yet).
- `.claude/` is listed in `.git/info/exclude` so none of this is ever committed.
- A Windows scheduled task (every 5 minutes) was offered and **not registered**.
- ⛔ On the `loopcom` branch the hook logs "no upstream" and does nothing. Correct until
  the remote exists.

## 5. Local DB state

`npm run db:push` applied the 2026-09-17 schema change (`Invoice.originalTotalAtConversion
Decimal?`) and regenerated Prisma Client. The local DB was reset + reseeded on 2026-09-02
(admin@trimpro.com / admin123).

## 6. What is NOT done

- Reskin: mockups approved, zero code written.
- Loopcom repo URL: pending from Izzy.
- Server: none. `CLAUDE.md` → "Server access" is a placeholder.
- Cross-server API to Loopcom: not designed. Known starting point in
  [[trimpro-multitenant-state]]: 276 session-auth routes, no API-key model, Tenant model
  present but no host resolution.
- Hook firing in a fresh session: unverified.
