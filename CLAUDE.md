## ⛔⛔⛔ HOW THIS FILE IS ORGANISED — KEEP CLAUDE.md SMALL (Izzy, 2026-09-14)

`CLAUDE.md` is loaded automatically into EVERY session, every turn. On 2026-09-14 it
had grown to **1.7 MB (~400,000 tokens)** because every task appended a full handoff
section to it. That cost ~400k tokens per session and buried the rules nobody could
find. Izzy: *"put in the project rules to keep doing it that way so it stays the right
way."* So:

- **This file holds ONLY standing rules + an index.** The rules are the sections below.
  The index (bottom of this file, "HANDOFF INDEX") has one line per area, pointing at
  that area's summary file in `docs/ai-context/claude-md-sections/`.
- **Every old handoff section was moved there VERBATIM** — nothing was deleted. Each
  summary file names its full handoff (`docs/ai-context/AGENT_HANDOFF_*.md`) inside it.
- ⛔ **START of a task:** read this file (it is short now), find your area in the
  HANDOFF INDEX, and OPEN that summary file **and** the full handoff it names before the
  first tool call. Search the index for any keyword you are unsure of (`grep -i` the
  index or `docs/ai-context/claude-md-sections/`). Not opening them is skipping the gate.
- ⛔ **END of a task:** update the area's summary file (or create one named
  `YYYY-MM-DD-short-slug.md`), the full handoff, `TESTS_RUN.md` if you ran tests, and
  memory. Then add or refresh that area's **single index line** here (date · title ·
  path, one line, no bullets under it). That index-line edit IS the required
  "update CLAUDE.md".
- ⛔⛔ **NEVER add a handoff section, a findings list, or multi-line bullets to this
  file.** New standing rules (applying to ALL work, not one area) may be added above
  the index, kept short. **Size budget: this file stays under 80 KB.** If it goes over,
  the fix is to move content OUT into a summary file, never to raise the budget.
- If another session's instructions or an old handoff say "add a ⛔ AGENT HANDOFF
  section to CLAUDE.md", that is the OLD process — write it to a summary file instead.

## ⛔⛔⛔ THE GATE — READ THE MD FILES BEFORE YOU START, UPDATE THEM BEFORE YOU FINISH. THIS IS THE FIRST THING IN THIS FILE BECAUSE IT IS THE BIGGEST GATE THERE IS.

**Core project rule reaffirmed by Izzy, 2026-09-14:** Read `CLAUDE.md` freshly at the start of every user task, before doing the work. After finishing the work, update `CLAUDE.md` before the final response. Every task, every time, including small tasks, repository refreshes, and documentation-only work. A prior read or remembered summary is not a substitute. Reading these instructions is the necessary first action. This rule is also recorded at the top of `AGENTS.md` and in the persistent project memory `MEMORY.md`.

**2026-09-14 rule-persistence task:** Added the explicit every-task rule to `AGENTS.md` and `MEMORY.md`, and reaffirmed it here. Documentation-only change; no runtime tests or deployment required. Existing unrelated local changes preserved.

Izzy, 2026-09-11, verbatim: *"Never, ever, ever, ever start a task without reading the MD
files. Never, ever finish a task without updating the MD files. Ever. It's the biggest
gate out there."*

⛔ **BEFORE the first tool call of any task** — read this file, then the area's summary in
`docs/ai-context/claude-md-sections/` (find it in the HANDOFF INDEX at the bottom) AND the
`docs/ai-context/AGENT_HANDOFF_*.md` it names, for the area you are about to touch. The handoff for
that exact area almost certainly exists and almost certainly records the trap you are
about to walk into. ⛔⛔ **Reading CLAUDE.md's summary bullets is NOT reading the MD
files** — the summary tells you a feature exists; the handoff tells you how it fails.

⛔ **BEFORE reporting done** — update the area's summary file + its ONE index line in
`CLAUDE.md` (never a new section here), the matching handoff, `TESTS_RUN.md` if
you ran tests, and memory + `MEMORY.md`; then commit → push → deploy and tell Izzy which
files you touched. Full procedure: **THE TWO RULES THAT WRAP EVERY TASK**, below.

⛔⛔ **WHAT SKIPPING IT COSTS — 2026-09-11, a worked example on a LIVE customer line.**
Asked to make 845-723-1213 ring T101 ext 101, an agent worked off CLAUDE.md's summary plus
live PBX reads and skipped `AGENT_HANDOFF_IVR_RUNTIME_2026-08-06.md`. It hand-edited the
tenant inbound route. §1.5 of that handoff says in its own words: *"our bake IS the
routing, so any regen by anything reverts a live number. Detection + auto re-bake is the
only defense."* The drift reconciler reverted the edit **three separate times**, each
within minutes — proven by the inode changing (15731645 → 15730853), i.e. the file was
REPLACED, not edited. The same handoff plus one AstDB read would also have shown that the
number's menu has **no working keys at all**, so every option that depended on reaching a
human through it was dead before the first edit. Three failed attempts, a live customer's
main number re-pointed and reverted repeatedly, and Izzy had to give the instruction
twice. ⛔ **Ten minutes of reading would have cost nothing and saved all of it.**

# Connect 2 — working rules for Claude

## ⛔⛔ BROWSE IN REAL CHROME, NEVER THE IN-APP BROWSER PANE (2026-08-31, Izzy's standing instruction) — the pane CRASHES CLAUDE DESKTOP on this machine

Izzy, 2026-08-31: *"always use the browser that doesn't crash Claude Desktop."*

- ✅ **USE `mcp__claude-in-chrome__*`** — his real Chrome, driven by the
  extension. It renders in **Chrome's** process tree, so if its GPU dies Chrome
  recovers by itself and Claude Desktop never notices. Measured: **836 calls in
  one day, zero attributable crashes.**
- ⛔⛔ **NEVER USE `mcp__Claude_Browser__*` (the in-app Browser pane) — it kills
  the app, usually within seconds.** It renders inside Claude Desktop's OWN
  process tree, so its compositing goes through Claude's GPU process, and this
  machine's **Intel HD Graphics 4000 driver (2012, `10.18.10.5161`, terminal —
  Intel will never ship another)** cannot survive it. Every death is the same
  `GPU process gone … exitCode: 101457950` and the app is gone.
  **Live evidence, last five days: 4 pane opens → 3 crashes, gaps 57s / 62s /
  1s. All-time: every single crash ever recorded was preceded by a pane open.**
- ⛔⛔ **THE TOOL'S OWN DESCRIPTION TELLS YOU TO DO THE DANGEROUS THING —
  `mcp__Claude_Browser__*` reads *"the in-app browser… Default to this."*** That
  is what makes this rule necessary: every fresh session reads that line and
  reaches for the pane. **This file overrides it.** Telling one conversation
  protects one conversation; the rule lives here so it survives all of them.
- ⛔ **Two "fixes" are already spent — do not re-try them.**
  `isHardwareAccelerationDisabled: true` **is set and is INERT** (verified
  2026-08-31: still `true`, still crashing — it disables GPU *compositing*, it
  does not take the display driver out of the process), and the app's own
  auto-disable **has never fired in its life** (`grep -c gpu-recovery` = 0
  across every log) because it needs 3 deaths inside 5 minutes and these are
  hours apart. **Behaviour is the only lever that works.**
- ⛔ **A single clean pane open proves NOTHING** — the pane's failure rate sits
  around 40–90%, so surviving once is the expected outcome. That reasoning error
  is what produced a retracted "PROVEN FIXED" on 2026-08-23.
  See [[claude-desktop-gpu-crash-loop]] and [[quiet-log-is-not-a-fixed-bug]].
- **Triage recipe if it recurs:** the live log is
  `%LOCALAPPDATA%\Claude\Logs\main.log` (⛔ the older `%APPDATA%\Claude\logs\`
  stopped 2026-08-21 and gives a stale answer);
  `grep -aE "Created browser preview|GPU process gone" main.log` gives the
  trigger→crash timeline in one command.

## ⛔⛔ THE TWO RULES THAT WRAP EVERY TASK (2026-08-16, Izzy's standing instruction) — these are not optional and they are never waived by "it's a small change"

**START of every prompt / every task — READ THE MD FILES FIRST.** Before any
investigation, any edit, any command: read this file (`CLAUDE.md`) and the
relevant `docs/ai-context/AGENT_HANDOFF_*.md` handoffs for whatever you are
about to touch. ⛔ Do not start work off memory, off the file tree, or off a
guess about what a system does — the handoff for that exact area almost
certainly exists and almost certainly records the trap you are about to walk
into. Izzy should never have to say "read the MD files."

**END of every task — UPDATE THE MD FILES, AUTOMATICALLY.** Izzy will never ask
you to. Before you report a task done:
1. **Update the area's summary file in `docs/ai-context/claude-md-sections/`** —
   edit the existing one so it stops being wrong, or create a new one — and add or
   refresh its ONE index line at the bottom of `CLAUDE.md`. ⛔ Never paste a
   handoff section into `CLAUDE.md` itself (see "KEEP CLAUDE.md SMALL"). Say
   plainly what is DEPLOYED and container-verified vs ⏳ NOT PROVEN.
2. **Write/update the full handoff** under `docs/ai-context/` when the work has
   detail that does not fit in a summary bullet.
3. **Update the memory files** under the memory dir + its `MEMORY.md` index when
   the lesson outlives this repo state.
4. ⛔ **Tell Izzy in your reply that you updated them, and which files.** An
   update he doesn't know about is an update that didn't happen.

**THE WORK TREE MUST BE EMPTY BY THE END OF THE DAY.** So every finished task
ends: **commit → push → deploy.** Not "committed, will push later."
- ⛔ Stage **explicit paths, never `git add -A`** — other sessions edit this same
  tree (see [[shared-worktree-commit-hazard]]), and CLAUDE.md in particular often
  carries another session's in-flight handoff text. Check `git status` and
  `git diff --cached --name-only` before every commit.
  ⛔⛔ **STAGING EXPLICIT PATHS IS NOT ENOUGH — proven the hard way 2026-08-16.**
  `git add <mine> && git diff --cached --name-only && git commit -m …` as ONE
  chained command swept another session's staged CLAUDE.md **and a deletion of
  their brand-new handoff doc** into commit `250af641`, pushed before it could be
  caught — because they staged in the gap between the `add` and the `commit`.
  **The check printed all three files and was useless: it ran inside the same
  chain as the commit.** Always `git commit -F - -- <explicit paths>` (the
  pathspec makes the rest of the index irrelevant, so the race cannot reach your
  commit), and run the staged-list check as its **own** command that you actually
  read first. Recovery recipe in [[shared-worktree-commit-hazard]].
  ⛔⛔ **AND "CLEAR THE WORK TREE" IS A TRIAGE, NEVER `git add -A` + commit —
  proven 2026-08-19, when the obvious move would have reverted the 2FA feature.**
  `git status` showed 10 files as `MM`; the **staged half was a 1,256-line
  REVERT** of the whole tenant login-OTP feature (incl. `decideChallengeReuse`,
  the SMS-flood cap), 522 lines of this file and 295 of TESTS_RUN.md — because
  another session had committed that work with the **private-index technique**,
  so the SHARED index still held the pre-commit snapshot.
  ⛔ **The one-command test: `git diff HEAD --stat` vs `git diff --cached
  --stat`.** A file that is `MM` but ABSENT from `git diff HEAD` has
  HEAD == worktree, so only the INDEX is stale → the fix is **`git add` those
  paths**, which makes them vanish from status. **Never commit them.**
  ⛔⛔ **And a WORKTREE file can be OLDER than HEAD, so "commit everything
  dirty" can write a FALSE record.** Same day: the onboarding number-search
  handoff's dirty copy said *"E911 for (929) 852-4026 is registered at 13
  koznitz rd"* — Izzy's own home — while HEAD correctly recorded it as
  **CANCELLED** (TYH Industries). Committing the dirty file would have replaced
  a true safety-critical fact with one that sends an ambulance to the wrong
  house. **Meanwhile a second doc was dirty in the OPPOSITE direction** (the
  voicemail-email ALERTS_MUTED correction, where HEAD was the stale one).
  ⛔ **So direction is PER FILE and must never be assumed — read the diff and
  check it against this file before committing. "It is dirty, so it is newer"
  is false in this tree.** Four buckets: index stale → `git add`; worktree
  stale → `git checkout HEAD --`; real work → commit by pathspec; artifacts →
  delete (⛔ `apps/portal/tsconfig.tsbuildinfo` is TRACKED and dirtied by every
  `tsc`; `*.orig`/`*.rej` are gitignored as of `dbaa890a`). **Back up anything
  you discard to the scratchpad first** — being wrong about direction is not
  recoverable once you have overwritten.
- Deploy through the queue / `deploy-direct.sh` per the deploy sections below,
  then **verify the running container**, and say so.
- If something genuinely cannot be deployed (mobile build, agent rebuild, a
  change Izzy has to approve), say that explicitly in the reply instead of
  quietly leaving it — an unstated gap is how "it's fixed" becomes false.

## ⛔⛔ THE FOURTH RULE THAT WRAPS EVERY TASK (2026-08-31, Izzy's standing instruction) — A NEW PAGE IS NOT DONE UNTIL IT HAS ITS TOGGLES

Izzy, verbatim: *“whenever we build a new page, there should be a toggle for it
in its section, on and off, and in custom roles, roles for everything, toggles
for all permissions. Always, always, always.”*

- ⛔⛔ **Shipping a page without its toggles is shipping half a page.** Three
  things land in the SAME commit as any new sidebar page:
  1. an entry in **`apps/portal/navigation/navConfig.ts`** (the sidebar IS the
     catalog — everything else derives from it);
  2. its **In-sidebar on/off switch** in its section on **`/admin/permissions`**;
  3. its **permission toggle in its section** on **`/admin/roles/[id]`**, the
     custom-role editor — plus a toggle for EVERY permission key the page adds.
- ⛔⛔ **THE FAILURE THIS RULE IS MADE OF, and it is the shape to watch for:
  there are TWO permission editors and fixing one is the default mistake.**
  On 2026-08-31 `/admin/permissions` was moved off the drifted shared
  `SIDEBAR_ITEMS` catalog and **`/admin/roles/[id]` was left on it** — so **23
  real sidebar pages had no toggle anywhere in custom roles**: Direct, Meetings,
  Desk Phones, Install, all five Store pages and 13 admin pages. It was reported
  as “I don't have every single page in workspace” and it was correct.
  **Never fix one of these screens without the other.**
- ⛔ **Both screens read `navItems` from navConfig. Never rebuild either from
  `SIDEBAR_SECTIONS`/`SIDEBAR_ITEMS`** — that shared catalog is 78 entries and
  has drifted 23 pages behind the real sidebar; it is kept ONLY so its 3 orphan
  billing keys stay grantable (the “Other pages” group at the bottom of the
  custom-role matrix). Dropping that group removes the only place
  `can_view_billing_invoices|payments|receipts` can be granted.
- ⛔ **A page can share its permission key with a sibling** (Direct rides Chat's
  key, Meetings rides Overview's, Install rides Contacts', all five Store pages
  share one). The custom-role row says “shares access with …” because that
  toggle moves the siblings too. **Per-PAGE hiding that does NOT touch siblings
  is the In-sidebar switch on `/admin/permissions`, which keys on NAV IDS.**
- ✅ **FIXED AND DEPLOYED 2026-08-31 (`4035b980`, portal).** Container-verified:
  `app-portal-1` `.build-commit` = `4035b980`, 0 restarts, `/admin/roles` 200 on
  both hostnames, and the SHIPPED CLIENT chunk for `/admin/roles/[id]` carries
  “shares access with” + “Other pages”, with `workspace.direct` /
  `workspace.meetings` / `workspace.desk_phones` / `workspace.install` /
  `store.orders` all present (they had NO row before). The matrix goes
  **78 → 97 rows**; Workspace **8 → 11**; the Store section appears for the
  first time. ⏳ **NOT PROVEN: nobody has opened the screen or saved a custom
  role since.** ⛔ An open tab or desktop window keeps the OLD bundle — the
  desktop app needs a full close + reopen, tray included.
- ⛔⛔ **“I turned on toggles and they don't see it” (2026-09-01) WAS TWO THINGS,
  and neither was the save.** The EZra save landed (PUT 200, 105 keys) and the
  deployed resolver hands every holder exactly those keys — 46 pages show on a
  fresh load. What stayed hidden: **(a)** pages force-lined to platform staff in
  `isNavItemVisibleForUser` while the matrix offered LIVE TOGGLES for them — a
  toggle that lies; **(b)** holders on stale sessions (an open window re-reads
  `/me` only on mount — reload, or fully reopen the desktop app).
  ✅ Fixed (`bbb6be8c`): rows in `OWNER_ONLY_FIXED_NAV_ITEMS` render a **Locked**
  chip + disabled toggle; `OWNER_ONLY_LIFTABLE` rows say they stay hidden until
  the owner launches them; `crm.diagnostics` notes its admin-account gate. The
  **honesty invariant** is a test now: for every page × every holder jwt,
  granting the page's keys either really shows it (simulated through
  `isNavItemVisibleForUser`) or the row declares its gate.
- ✅ **THE OWNER TOGGLE EXISTS (`bbb6be8c`, Izzy's ask): a custom role carrying
  `ACCOUNT_OWNER_PERMISSION_KEY` (`can_act_as_account_owner`) resolves to the
  UNION of the LIVE TENANT_ADMIN bucket and the role's own keys**, computed at
  resolve time — pages added to the tenant-admin bucket later reach owners with
  no re-save. ⛔ Portal permissions ONLY — it never changes the JWT role, so
  platform-staff surfaces (SUPER_ADMIN force lines, /admin/billing, the console
  family) stay closed, and jwt-role-gated routes still refuse a USER jwt.
  ⛔ The owner branch FALLS THROUGH to the ordinary CRM gating instead of
  returning the literal set, and runs BEFORE the authoritative-literal branch —
  both source-guarded (`accountOwnerGrant.test.ts`, 7 tests). In no default
  bucket; deliberately NOT platform-protected, so an account owner may delegate
  ownership of their own account.
- ✅ **BOTH DEPLOYED AND PROVEN 2026-09-01.** api ships in `58ed5a24`, portal in
  `8f1d2e3c` (both contain `bbb6be8c`; 0 restarts; 200 on both hostnames; the
  page chunk carries “Owner — full access to their account” + “Locked” +
  “Platform staff only”; the key literal lives in shared chunk 6051, so grepping
  the page chunk for it reads 0 — not a failed deploy). **The grant is proven
  LIVE, not just by test**: a throwaway owner role on Loopcom Demo assigned to a
  USER-jwt user resolved through the deployed resolver to a set BYTE-IDENTICAL
  to the same person resolved as a real TENANT_ADMIN (101 = 101, zero divergence
  either way, CRM gating included); probe rows deleted and verified gone.
  ⛔ **“Owner = the TENANT_ADMIN bucket” is NOT “every bucket key”** — the CRM
  keys still gate on tenant CRM + CrmUserAccess exactly as they do for a real
  tenant admin; a naive superset assertion reads that as a failure and it is the
  correct behaviour. ⏳ NOT PROVEN: nobody has flipped the Owner toggle in a
  browser, and no EZra holder has signed in since the grant.
- ✅ **Enforced, not remembered:
  `apps/portal/navigation/permissionToggleCoverage.test.ts`** (registered; 6
  tests, **3 fail replayed against the pre-fix HEAD** via `PORTAL_GUARD_ROOT`).
  It reads both screens' SOURCE, because a unit test of either page's helpers
  passes straight through this bug — the defect was WHICH CATALOG the page
  imported. It fails if either screen regresses to the shared catalog, if
  `toggleSection` clears children from a different catalog than it rendered, or
  if any `PORTAL_PERMISSION_KEYS` entry has no toggle anywhere.

## ⛔⛔ THE THIRD RULE THAT WRAPS EVERY TASK (2026-08-23, Izzy's standing instruction, given after the answer-path regression) — NEVER PROPOSE A FIX WITHOUT FIRST CHECKING WHAT IT BREAKS

Izzy, verbatim: *"Never fucking suggest a fix to me that will break something else,
ever … Check before you fucking do something. Stop giving me suggestions on stuff,
fixes, and patches without even fucking checking what it's gonna break."*

- ⛔⛔ **A fix is not proposable until its blast radius has been TRACED, not guessed.**
  Do the tracing BEFORE you offer it. Handing him a fix with an attached "the risk
  is…" list is the failure itself — it moves the checking work onto him. He has spent
  seven months being handed fixes that broke the next thing, each one reported done,
  each one costing him credibility with a paying customer.
- ⛔ **Before proposing ANY change:** `git grep` the symbol, find every caller, every
  branch, every consumer. Read each call site. If you are moving code between two
  branches, DIFF THE TWO BRANCHES and state the delta as a verified fact ("the only
  difference is this one line"), never as a suspicion.
- ⛔ **If you have not checked, do not propose it.** Say you are checking, then check.
- ✅ **Prefer a fix that is a provable RESTORE to a known-good state** over a new
  design — it is the only kind whose blast radius can be fully enumerated.
- ⛔ **This rule exists because of a real, proven case:** `e75be0ec` (2026-06-19) was
  correct in itself and silently left `backendClaimed` meaning something its name did
  not say; `83a5728c` (2026-08-22) then wrote the only sensible-looking line a person
  could write and tripped it, collapsing the mobile answer budget from 4 s × 3 attempts
  to 500 ms × 1 and making the app hang up on the call it had just answered. Nobody
  traced who else read that variable. See
  `docs/ai-context/AGENT_HANDOFF_WARM_ANSWER_DEADLINE_2026-08-23.md` and
  [[never-propose-a-fix-without-checking-blast-radius]].
- **Owner reaffirmed 2026-09-16: show concrete user-visible proof before claiming something works.** For Laybel, show the real animated call and verify heard speech plus a reply; API tokens, tests and deployment success alone are not that proof. State any unverified leg explicitly.
- ⛔ **And "fixed" still means a human did the thing and it worked** — for the call
  path that means a real call, answered, with audio. Green tests, clean typechecks and
  container greps are not proof and must never be reported as one.

## Task-dashboard signature routing (ALWAYS APPLY)

Every task I add to the jacob-dev-orchestrator task dashboard MUST carry a routing
**signature** in its title and detail. The signature tells a specific Cursor agent
which tasks are his; he only claims tasks that carry his signature and ignores all
others. This prevents the wrong agent from picking up a task.

Rules:
- Never create a dashboard task without a signature. No exceptions.
- Put the signature in BOTH the title (e.g. `[SIG::CURSOR-CONNECT-01] ...`) and as the
  first line of the detail (`ROUTING SIGNATURE: SIG::CURSOR-CONNECT-01 — ...`).
- The signature is per Cursor agent / per chat and is STABLE — reuse the same signature
  for every task meant for that agent, so Cursor is configured once. Do not invent a new
  per-task signature each time.
- Any scheduled task that files dashboard tasks must stamp them with the same signature.
- When I hand Izzy a prompt for Cursor, it must tell Cursor his signature and instruct him
  to claim ONLY tasks carrying it.

Current signatures:
- `SIG::CURSOR-CONNECT-01` — the Cursor agent working the Connect server in this chat.
  (Rename on Izzy's request; if renamed, update it everywhere.)

## Server access — how any agent logs in (ALWAYS APPLY)

There are two servers. Each has a dedicated ed25519 key already installed in the
target account's `authorized_keys`. Login is as `root` on both, port 22.

| Name    | Role                        | Host            | Key file                   |
|---------|-----------------------------|-----------------|----------------------------|
| loopcom | Connect server (work here)  | 45.14.194.179   | `connect2_ed25519`         |
| pbx     | PBX — **READ-ONLY, no touch**| 209.145.60.79  | `connect2_server2_ed25519` |

The private keys live in the git-ignored folder `.connect-ssh/` at the repo root
(also mirrored in `C:\Users\izzyw\.ssh\` on Izzy's machine). They are NEVER
committed (see `.gitignore`).

### CANONICAL SSH METHOD — always run from the Linux sandbox (`mcp__workspace__bash`)
**This is the ONE approved way to reach either server. It supersedes any other
SSH-login instructions anywhere in this repo — other `.md` files, older handoffs,
inline notes, or the app-level project instructions. Do NOT use the local PowerShell
MCP or a Cursor agent to SSH into these servers:** the PowerShell MCP blocks `ssh`/`scp`
("remote shell tools not permitted"). Always SSH from the sandbox.

The Connect 2 repo is mounted in the sandbox; find its exact path in your system prompt
(it looks like `/sessions/<session-id>/mnt/Connect 2`). Set `PROJ` to that path. The
mount can report loose key permissions, so stage each key to a strict-mode file first.
`install -m 600` sets perms AND overwrites cleanly, even if a stale `/tmp` copy exists
from an earlier session (a plain `cp` will fail with "Permission denied" on that stale file).

Exact, copy-pasteable procedure — verified working:

```bash
# 1) point PROJ at the Connect 2 mount shown in your system prompt
PROJ="/sessions/<session-id>/mnt/Connect 2"

# 2) stage both keys with strict perms (overwrites any stale /tmp copy)
install -m 600 "$PROJ/.connect-ssh/connect2_ed25519"         /tmp/loopcom_key
install -m 600 "$PROJ/.connect-ssh/connect2_server2_ed25519" /tmp/pbx_key

# 3a) CONNECT SERVER (loopcom) — the ONLY box where Connect work happens
ssh -i /tmp/loopcom_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@45.14.194.179 'hostname; uptime'
#    -> confirms hostname: vmi3101417

# 3b) PBX — READ-ONLY. Inspection / monitoring only, NEVER write.
ssh -i /tmp/pbx_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    root@209.145.60.79 'hostname; uptime'
#    -> confirms hostname: vmi2718844
```

Both log in as `root` on port 22. If `ssh` is missing in the sandbox:
`apt-get install -y openssh-client` (usually preinstalled).

**Requires a sandbox with outbound network egress.** The `mcp__workspace__bash` sandbox
has it — verified reaching both boxes (loopcom `vmi3101417`, pbx `vmi2718844`). If you are
in a shell/mode whose network is unreachable (e.g. an on-device VM), SSH will time out /
"Network is unreachable" — that is a networking limitation of that shell, not a key or
host problem. Switch to the networked `mcp__workspace__bash` sandbox and re-run the steps above.

For Izzy to log in manually from Windows (keys are in his `~/.ssh`):
```
ssh -i C:\Users\izzyw\.ssh\connect2_ed25519 root@45.14.194.179          # loopcom
ssh -i C:\Users\izzyw\.ssh\connect2_server2_ed25519 root@209.145.60.79  # pbx
```

### Guardrails on server access
- **loopcom (45.14.194.179)** is the only box where Connect work happens, and even
  there: deploy/restart only via the deploy queue; no `git add -A`.
- **pbx (209.145.60.79) is strictly READ-ONLY.** Inspect and report only. Never take
  write actions on the PBX — this is a hard guardrail.
- Never touch payments or pension from either box.

## Other standing rules
- Read-only monitoring runs never take write actions on the Connect server, PBX,
  payments, or pension — report only.
- Hard guardrails on all Connect work: Connect server only; never touch payments,
  pension, or the PBX; deploy/restart only via the deploy queue; no `git add -A`.

## HANDOFF INDEX — one line per area (newest first as moved on 2026-09-14; add new ones at the top)

- 2026-09-16 · Index maintenance: seven oversized routing notes preserved verbatim; area summaries unchanged → `2026-09-16-index-detail-archive.md`
- 2026-09-16 · October billing projection/Nexus Sola cutover; missed September overlap and RSBK quantity-override findings → `2026-09-16-october-2026-charge-projection.md`
- 2026-09-16 · 502 ON EVERY PAGE AFTER A BLUE/GREEN DEPLOY — old nginx workers (kept alive for hours by /sip + /ws/telephony WebSockets, no worker_shutdown_timeout) still route to the port active at THEIR reload; removing the candidate (:3005 portal / :3004 api) 502s them — 937 refused to :3004 today; ✅ fix WRITTEN+TESTED on branch `claude/nginx-upstream-backup` (include = active port + other port `backup`, both `max_fails=0`; proven on an isolated test nginx on the box), ⛔ NOT DEPLOYED — needs Izzy's OK; ⛔ worker_shutdown_timeout rejected (cuts softphone WSS every deploy) → `2026-09-16-old-nginx-workers-502-after-blue-green.md`
- 2026-09-16 · ONBOARDING LINK PRICING — COLD CALLING $65/ext + CRM $20/ext (api+portal `014c0399` DEPLOYED): admin ticks both on /admin/onboarding (count or all); ⛔ answers.pricing is server-owned (autosave can't set/clear it); review /quote + first invoice + month 2 (price 6500 / recurring lines) all priced; Swift Mechanics stamped all+all, live quote 1 ext = $90; + phone wizard step-1 dead end fixed (desktop→phone switch demanded a cell with no field); ⏳ real invoice + month 2 unproven → `2026-09-16-onboarding-cold-calling-crm-pricing.md`

- 2026-09-16 · SIGN-UP WIZARD IN THE LOOPCOM LOOK — DEPLOYED portal f77a2468, seen in Chrome: wordmark header, Loopcom palette (light accent #1683d8), card hairline; finish page = glowing infinity on dark / light-mode infinity on light; Connect copy → Loopcom; ⛔ token names unchanged (success page reads them); labels NOT uppercased (they're questions); ⏳ steps 2–7 + phone not eyeballed → `2026-09-16-signup-wizard-loopcom-rebrand-mockups.md`

- 2026-09-16 · CONTACTS ARE PRIVATE PER USER (Relax Tires 101's 4,250 phone-book contacts showed on 102/103): `Contact.ownerUserId` + backfill, one rule in `contactVisibility.ts` (shared + mine, no admin bypass, CRM = shared only), caller-name/dup-check/merge/search/assistant/SMS-email all scoped; ✅ LIVE: 101 sees 4,250, 102/103 see 0; ⛔⛔ first deploy swept another session's uncommitted server.ts lines → MODULE_NOT_FOUND, fixed `5f279499`; ⏳ no human app/call check → `2026-09-16-contacts-are-private-per-user.md`

- 2026-09-16 · SIGN-UP WIZARD SWITCHED TO TELNYX (live, switch=telnyx): search/buy/E911/CNAM/real Telnyx port filing + landing sweep + shared trunk 183; ⛔⛔ 5 live-only bugs fixed (autosave WIPED the carrier stamp → submit pins it; messaging profile needs /messaging PATCH; shared-trunk builds had NO Main DID dispatch → panel saveTenant + applyAndRebake(Main); interrupted builds could not resume + stale REST directory → read ombu_tenants); ✅ real run: 845-777-4807 bought, T143 built, ACTIVE (card NOT charged — test invoice marked paid); ⛔ no Telnyx stock in 212/718/347/646/917/332/201; + evening: 911 postal form (State Route 17M/Ste C) + owner SMS alert + auto/admin retry + FastPort; ⛔ Telnyx 911 blocked until Izzy accepts Emergency ToS; ✅ 723-1213 FastPort SUBMITTED (Telnyx order 58969290, switch Fri 9/18 7AM ET — ⛔ platform pay-link/sign-in texting stops then unless moved; guard keeps it in T35), ⏳ human call, 10DLC EIN → `2026-09-16-telnyx-onboarding-wizard.md`

- 2026-09-16 · TELNYX 10DLC REGISTRATION — BUILT + DEPLOYED (api 34ff3aae, portal 9a04bb2c, browser-proven), live-proven to Ready-to-file, NO real filing yet: /admin/texting-registration → private link + Loopcom email ("to continue using SMS, fill out the 10DLC form") → locked pre-filled public form (customer edits only legal name/type/EIN/IRS address/website) → File with Telnyx runs unattended; ⛔ EIN AES-GCM token destroyed on verification; ⛔ charge = SEPARATE uncharged $24 one-time invoice (traced safe), monthly/marketing hidden; ⛔ own tables, never TenantSmsRegistration; ⛔ links on app.connectcomunications.com; ✅ 9 SMS customers’ drafts PREPARED (no link/email yet — Izzy sends), ⛔ all their numbers are VoIP.ms; ✅ SWITCHER DEPLOYED `56879d0f`: a number that lands ACTIVE on Telnyx flips its texting VOIPMS→TELNYX by itself within 5 min + attaches to the approved campaign (723-1213 will flip Fri 9/18), ⏳ no real landing yet → `2026-09-16-telnyx-10dlc-registration-page.md`

- 2026-09-16 · COLD CALLING (customer ask) — ADVISORY ONLY, nothing built: doable HUMAN-DIALED only (⛔ Telnyx AUP bans predictive/auto-dialing + prerecorded drops; SDC ≤15%); lawful shape = B2B-leaning + customer's own DNC SAN + 8am–8pm called-party hours + real CID + per-ext/per-DID caps + rider indemnifying Loopcom before dial tone; own DIDs + own outbound voice profile isolate blast radius; ⏳ no cap/hours enforcement exists in Connect → `2026-09-16-cold-calling-compliance-rules.md`

- 2026-09-16 · B VISIBLE 101 "no audio both ways, daily" DIAGNOSED READ-ONLY: his Yealink T53W went dead-mic on the 11:02 ET call from 845-428-2290 (rx 6 / tx 917 RTP, not a hold, recording on PBX proves it) — same rx≈6 signature on 101 twice + ext 104, incl. an INTERNAL call (⛔ not the carrier), all office endpoints flap + RTTs 41→355ms on one LAN; all 5 desk phones are Wi-Fi-capable W-series, Wi-Fi-vs-ethernet unverified = first question; PBX healthy; ⚠️ flagged: 10–20% ICMP loss PBX→newyork1.voip.ms (RTP ~0%), T9_101_1 softphone never registered (log noise + no fallback); fix is customer-side, awaiting Izzy → `2026-09-16-bvisible-101-audio-dropouts.md`

- 2026-09-16 · RELAX TIRES RING GROUPS — ⛔ REVERTED BACK TO 101 SAME DAY (Izzy: "back to the way it was this morning"): RG 800+801 member + no-answer VM 669→154 via the same console PATCH, verified in-memory dialplan (Local/101 + VM-101); concurrent api deploy killed the script mid-batch (exit 137, RG 89 done/90 not) → re-read, re-ran 90 alone; ⏳ no real call. ORIGINAL move to Alex: both RGs (800 New Tires / 801 Warranty, the ONLY paths to a person) member 101→102 Alex AND no-answer VM → Alex’s box, via console PATCH /admin/pbx-console/ring-groups/:id — verified in Asterisk’s IN-MEMORY dialplan (Dial Local/102 + VM-102), reconciler can’t revert native RG config; ⏳ no real call placed yet; ⛔⛔ FIVE vm_direct pointers at 101 REMAIN (both IVRs’ invalid+timeout, hidden code 1159 — ALL after-hours voicemails still land in 101’s box) because NO DOOR EDITS NATIVE-IVR EXITS (console has no ivr module; /ivr-action can’t target voicemail, option regex caps at 2 digits) — Izzy must pick target (Alex’s VM vs ring first) before building one → `2026-09-16-relax-tires-ring-groups-to-alex.md`

- 2026-09-16 · UNIFIED MESSAGING — **BUILD APPROVED (mockups v3 accepted with 2 standing rules) · PHASE 1 BUILT: Messaging Router + Telnyx chat wiring.** ⛔⛔ RULE 1: the existing chat look is FROZEN, additive only (color tints OK). ⛔⛔ RULE 2: customers NEVER see a carrier name (Telnyx/SignalWire/VoIP.ms) — failover says "sent via backup route"; carrier detail is platform-staff-only. Artifact 4JJZYVHE9KKkQ1XpQm3eQe (V3). ✅ Phase 1 (tests 186/186 worker + 27/27 telnyx incl. real-Ed25519 webhook suite): `messagingDispatch.ts` registry replaced the job's inline if/else (guards replay-FAIL on HEAD), `TelnyxSmsProvider` + worker adapter (no MP4 conversion, `telnyx:` ids), `/webhooks/telnyx/sms` fail-closed → the ONE ingest + final-states-only DLR, migration `20260916170000` (TELNYX enum + `TenantSmsNumber.fallbackProvider` — backup fires ONLY on explicit `__anySent === false`, partial/unflagged never re-sent; VOIPMS-as-backup not yet a target). ✅✅ DEPLOYED + LIVE-PROVEN ~16:15Z: api `done 287a32e6` + migration read back from the live DB; webhook 401 fail-closed local+public; ⛔⛔ worker deploy SELF-SKIPPED on a false baseline (api deploy had moved the checkout; container verified WITHOUT the new file) → force-rebuilt at tip 2ac9e9fc + file-verified; REAL round-trip through the new dispatch on our own pair: sent VoIP.ms id 111471089 @16:15:10Z → polled back voipms:111471092 @16:15:42. ✅✅ EVENING: **TELNYX OUTBOUND LIVE through the chat door** (messaging profile "Loopcom Chat" + webhook URL wired via API; probe telnyx:4031a0ab → back as voipms:111472663, 9s cross-carrier); backup route ARMABLE from /apps/voip-ms (super-only Carrier column, PLATFORM_ONLY gate, 5 guards); ⛔⛔ RULE-2 LEAK FIXED: raw deliveryError ("Telnyx refused…") shipped to every client since the SignalWire wiring — now a fixed-phrase whitelist server-side (SUPER keeps raw), + sentViaBackupRoute BOOLEAN + portal ✓✓/backup words + mobile parity; api+portal verified IN-CONTAINER at 483930a9 (my commits ancestors — merge-base checked). WhatsApp schema drift = ALREADY FIXED 08-16 (stale audit); full DB↔schema drift measured to /root/drift-20260916.sql — ⛔ never apply wholesale. ⏳ Izzy: paste the Telnyx portal Public Key into /apps/telnyx (inbound/DLR unblocks instantly); no backup route armed/fired in prod yet; RCS agent + Meta verification + Tenor key external; realtime channel + toggles + channel UIs = next → `2026-09-16-unified-messaging-mockups.md`


- 2026-09-16 · SUPPORT WATCHER — the 877-220-5058 ORPHAN ALARM IS MUTED (api `737331c3` deployed+verified: `IGNORED_TRUNK_ORPHANS` = `344022_fox` with EXACTLY `8772205058`; any other number still alarms) and all 10 of its queued tickets are `stopped_by_owner`. ⛔⛔ stopping a ticket: requeue skips the cap check; `.watch-state.json` hand-edits are clobbered (kill when IDLE first); "my ticket settled" ≠ idle (killed live GEAGCD once). ⛔⛔ two `deploy-direct.sh api` runs share ONE server checkout — the last build wins while the first still prints `success` + a matching verify; read `/app/.build-commit` AND grep the change → `2026-08-31-a-customer-s-support-request-now-opens-a-claude.md`

- 2026-09-16 · Extension mirror: c892d4b9 verified; licence/silent-downgrade guards; deploy no-op fix; owner SQL grants required → `2026-09-16-relax-tires-two-new-extensions.md`

- 2026-09-16 · CREATIVE STUDIO **LIVE END TO END** (storyboard → cut → export; 12 pages, 16 keys, none in a default bucket — ⛔ grant them as a SET). Proven on prod incl. the Coworker making a whole film itself. ⛔⛔ SIX bugs only RUNNING it found — the quality check was checking NOTHING, and the queue LIED to the customer. ⛔⛔ **ElevenLabs subscription PAYMENT FAILED: every TTS call 401 platform-wide — Izzy must pay it.** ⏳ nobody has clicked the screens; no key granted → `2026-09-16-creative-studio-built.md`

- 2026-09-15 · Coworker workspace deployed; four live-only defects and desktop boundary; real hands task/rc.17 install unproven → `2026-09-15-coworker-workspace-built.md`

- 2026-09-15 · CREATIVE STUDIO PHASE 0 (superseded by the build above; kept for the mockup, the screen inventory and the licence research — artifact 3SGpm83ss2eor8unoGkGPd) → `2026-09-15-creative-studio-phase-zero.md`

- 2026-09-15 · CREATIVE STUDIO PHASE 0 (superseded by the build above; kept for the mockup, the screen inventory and the licence research — artifact 3SGpm83ss2eor8unoGkGPd) → `2026-09-15-creative-studio-phase-zero.md`

- 2026-09-15 · Android tablet compatibility: vc103 live; optional hardware features, Play search/name collision, ToS gate and real-tablet proof → `2026-09-15-android-tablet-compatibility.md`

- 2026-09-15 · Onboarding Google Play badge: 66eb7096 deployed; shared URLs; actual invite/Outlook proof pending → `2026-09-15-onboarding-welcome-email-google-play-badge.md`

- 2026-09-16 · YIDDISH LEARNING ENGINE + YIDDISH24 — RUNNING 24/7 until Izzy says "stop listening Yiddish24" (api+portal `3ace3d4e`): whole catalog walked, hourly re-check; **Now listening** panel on the Yiddish24 page (`/admin/yiddish/now`, 5s; "hear" = link to the episode on yiddish24.com, MP3 url never sent to the portal); **NO MUSIC** by the site's own category 7 + #233 music videos (4,182 items excluded). METADATA ONLY — ⛔⛔ 0 audio bytes, audio needs publisher permission. ⛔ Defects only production showed: missing `observe`/`aggregate` handlers hid as lawful SKIPs; crawler paused itself on "no new episodes"; nav parser filed news as Torah (7,469 relabelled); ⛔⛔ another session's pinned OLDER-SHA deploy reverted it all once — deploy the origin tip. ⏳ R/CH A/B + music-talk series await Izzy → `2026-09-15-yiddish-learning-engine.md`

- 2026-09-15 · YIDDISH VOICE LAB: DESIGN ONLY — the "YL → OpenAI voice tester" Izzy referenced did not exist anywhere; normalized provider-neutral dataset design (source text / prepared text / request / audio, ratings, word + prosody corrections, contextual dictionary, immutable config versions, A/B, regression, retention-deletes-audio-only); ⛔⛔ YL output is SERVING-ONLY, never training (YL_NO_TRAINING_POLICY.md); first 4 OpenAI gpt-4o-mini-tts Yiddish clips sent, ⏳ ear verdict pending; 14-screen mockup artifact Kxy7NSV8CPw41B7se2NcLp; nothing built → `2026-09-15-yiddish-voice-lab-design.md`

- 2026-09-15 · COWORKER IDE REDESIGN (the APPROVED mockup — SUPERSEDED BY THE BUILD ABOVE, which shipped it): live mockup v1 (artifact 9rkPBPFRp6hqQJcYCaSDXG) — bubble chat with live plain-English steps + in-chat approvals, full page with plan/live-window/settings; BUILT AND DEPLOYED — see the line above; ⛔ in-chat approval vs today's local approval window needs a security call first → `2026-09-15-coworker-ide-redesign-mockup.md`

- 2026-09-15 · COWORKER SCREEN CONTROL + ADMIN POWERSHELL: mockup APPROVED (artifact MG6Myf27kDKhyp1iYHneCR) → BUILT Phase 1 as code, OFF by default (`coworkerScreenControlEnabled` tray toggle). 9 `computer_screen_*` tools (buttons-first UIA click-by-name, cursor fallback) + elevated PowerShell, all gated by `desktop.active` (already NEVER_AUTO — no shared change); blue click-through edge overlay, Escape-to-stop, ask-once-then-flow. ⛔ GATE PROVEN by test (31 new incl. 500-action ask-once stress; 110 coworker+remoteSupport green; tsc clean) — but the LIVE cursor/screen/UAC leg (screenController.ts/overlay/elevatedShell) is UNPROVEN, needs a human on a real Windows screen (like remote-support's injector). Phase 2 = model pixel-vision. Handoff AGENT_HANDOFF_COWORKER_SCREEN_CONTROL_2026-09-15.md → `2026-09-15-coworker-desktop-control-research.md`

- 2026-09-15 · B VISIBLE MISSED CHARGES + RECURRING CUSTOM LINES: flat rate absorbed Lester's ext 111 ($25) and the $40 Contabo server was never configured — one-time catch-up CC-202609-00010 $65 created, emailed AND **CHARGED PAID** (Visa •5023 APPROVED, Sola ref 11051029517, receipt SENT); NEW opt-in engine key `metadata.billingRecurringCustomLines` (api `5573d567` DEPLOYED container-verified) puts both on every cycle invoice — deployed preview proves next cycle + October at $205; ⛔ never ALSO bump the flat rate for Lester (double-charge); ⏳ first real $205 cycle charge is Oct 2 → `2026-09-15-bvisible-missed-charges-recurring-custom-lines.md`

- 2026-09-16 · DISPLAY DECKS SPLIT — ✅ SWAP LIVE: 845-200-3535 + 212-888-0885 now carrier → Main → PBX T142 → Connect IVR on DisplayDX, each its own greeting, all 8 keys = T6's ring groups, proven by REAL carrier calls; Eli's user/ext 101 (T142_101_1)/phones/texting/VM email/CDRs moved, Nexus originals removed (voicemails SOFT), backups loopcom /root; ⛔⛔ apply in the tenant context does NOT regen Main's DID dispatch (apply Main too); ⛔⛔ a migrated IVR schedule with no business hours + an after-hours pointer overrides EVERY number's menu 24/7; e164 is +10 digits; probe calls leave VMs/CDRs; ✅ account renamed Displaydex + new welcome/create-password email SENT 09-16 (Eli INVITED, old password gone); ⏳ Eli signs in with the new password, real answered call/text/VM email by a human, T6 cleanup later. Earlier: Nexus Realty rename + Michael, DisplayDX billing $30, $90 collected → `2026-09-15-displaydx-nexus-realty-split.md`

- 2026-09-15 · GESHEFT STARLINK INVOICE PAID + PERIOD-GUARD FIX: CC-202609-00006 $275 emailed AND charged (Amex •1007 APPROVED, Sola ref 11050894534, receipt SENT); ⛔ the charge exposed that EVERY additive one-time/manual invoice inside a paid advance-billed month was unchargeable (`BILLING_PERIOD_ALREADY_PAID`) — fixed via `isAdditiveOneTimeInvoice()` in both charge doors, DEPLOYED `74e7730a` container-verified; monthly-service-text invoices stay guarded → `2026-09-15-gesheft-starlink-invoice.md`

- 2026-09-16 · Loopcom Mobile full product: 5232cba2; permission-gated, no real lines; next-round/gap-pass mockups await approval → `2026-09-16-loopcom-mobile-full-product-built.md`

- 2026-09-15 · LOOPCOM MOBILE UI MOCKUP PASS (superseded by the build above; kept for the design record): 30-screen mockup + artifact JGi8xGn5FnAVPPPJKvdvmt (v3 adds the email designs) → `2026-09-15-loopcom-mobile-ui-mockup-pass.md`

- 2026-09-15 · FCC BDC FILING (late, June-30-2026 data): DATA COMPLETE + valid — 102 iVoIP subs / 8 NY tracts, all business, pure OTT (Izzy: 7 tenants deleted, Landau test, McNamara held out; ⛔ never touch E911 from BDC work). Cert hard-blocked by "Missing Form499 ID" — BDC help desk ANSWERED ticket #63588: their 499 list refreshes ~monthly, so 839208 (USAC-approved Aug 24) just has to appear, then enter it + ratio-warning note + Izzy certifies. NO transactions in BDC (that’s USAC 499-A). → `2026-09-15-fcc-bdc-filing-late-notice.md`

- 2026-09-15 · SECOND VoIP.ms ACCOUNT attachable: GlobalVoipMsConfig = one row per account (primary keeps id "default" so provisioning/guardrail/billing stay untouched), TenantSmsNumber.voipmsAccountId stamped by sync + followed by outbound send, per-account inbound poll, send-test-sms; accounts panel on /apps/voip-ms; ⛔ second account must allowlist the server IP in ITS VoIP.ms API settings; ⏳ no real second account attached yet → `2026-09-15-voipms-second-account.md`

- 2026-09-15 · GEO FIREWALL after the license cancel: enforcement ALIVE + verified live (231 blocked, us/ca/il/tv open, config clean, survived lapse + Sep-12 reboot), ⛔⛔ channel STAYS DISARMED — unlicensed ionCube builder could rebuild to the free tier's 1 country and the runner's validation would PASS the wipe (no count floor); closing ca/il/tv needs our OWN builder + Izzy's per-country call → `2026-09-15-geo-firewall-after-the-license-cancel.md`

- 2026-09-15 · LOOPCOM MOBILE BUILT on Telnyx wireless: eSIM/SIM/data product end to end (7 additive tables, wireless client, /mobile customer page + /admin/mobile-console, Ed25519 fail-closed webhook door, 15-min sweeps), INERT — key `can_view_workspace_mobile` in no bucket, nothing bought, invoices NOT wired (recount preview only); ⛔ tenant API = `/mobile-service` (`/mobile` is the phone app's), Telnyx Mobile Voice = BETA (report says so), SIM usage record_type = `sim_card_usage` → `2026-09-15-loopcom-mobile-built-on-telnyx-wireless.md`

- 2026-09-15 · Zero-touch Yealink LIVE except handset proof: YMCS v2 OAuth (v1 X-Ca DEAD), ⛔ MAC-ONLY ADD FORBIDDEN 403 → provision by MAC+SERIAL (`265402dd`); live round-trip through prod container proven, cloud clean; ⛔ a resumed run HID the wizard's welcome options — the password dead-end now offers "Set up from the cloud — no password" with MAC prefilled (`7931e768` deployed); ⏳ factory-boot→register leg needs a handset → `2026-09-14-zero-touch-yealink-rps-provisioning-is-built-int.md`

- 2026-09-15 · TELNYX: ⛔ ATTESTATION A PROVEN ON A REAL ANSWERED CALL — account izzy@loopcom.net at VERIFIED, number (845) 306-6825 bought+attached, PBX trunk 183 registered, T102 route 123 + inbound → ext 102 (CID must be the Telnyx number — unowned = 403 D51), dnis_format=national kills the custom-dialplan need, CDRs = record_type `sip-trunking` field `shaken_stir`; /apps/telnyx bench LIVE (lookup needs `type=` params); wizard-carrier switch built (telnyx honestly refused till wizard path exists) → `2026-09-15-telnyx-provider-onboarding-and-bench.md`

- 2026-09-15 · SignalWire DAY TEST: 6775 ROLLED BACK (§5, verified), test v2 now on A plus 845-782-3064 (§7; TRUNK_ID=132 guard IS the anti-loop; CID survives only via the 0001 hop); ⛔⛔ answered calls DROP (cause 58) — PCAP-PROVEN SRTP MISMATCH (SignalWire offers SAVP+crypto, trunk `media_encryption=no`, Asterisk's invalid hybrid SDP dies at the answer-time re-INVITE), NOT direct media; ✅ FIX = 4 PIECES, IVR-PROVEN 12:27 ET: sdes+OPTIMISTIC in `pjsip__60_custom.conf` (⛔ sdes alone 488s ALL — SW INVITEs carry 2 m-lines), SW ciphers = AES_CM_128 only (GCM+256 refused at runtime despite symbols), `CALLERID(dnid)` set in trk-132-in (doorway keys on DNID; "rings then goodbye" otherwise), probes need CID ⏳ answered-bridge proof pending → `2026-09-15-signalwire-day-test-aplus-6775.md`

- 2026-09-15 · iPhone App Store: rejection FULLY WORKED — all 3 issues fixed (purpose strings `db20a0a8`, storefront USA via API, business-model reply SENT + thread-verified), build 60 built/attached, RESUBMITTED at 05:35 ET, `WAITING_FOR_REVIEW` UI-confirmed. ⛔ "Version is not ready" 409 = LYING error; the fix is PATCH the rejected item `{resolved:true}`, never retries. Google Auth → 1.1 (mockup published) → `2026-08-27-the-iphone-app-store-submission-4-of-5-blockers.md`

- 2026-09-16 · Browser Companion: local rc.18 hybrid prefers explicit paired Loopcom MV3 for new tasks, otherwise isolated Playwright; task engines pin. Verified NSIS install and installed ASAR/runtime/icon payload; MV3 still unloaded/unpaired because Chrome control cannot claim `chrome://extensions` and native RPC is unconfigured. No flags/profile/policy bypass; no live provider/distribution/recovery/stress release claim → `2026-09-14-browser-companion.md`

- 2026-09-14 · Deploy 403 prevention deployed/verified: queued-log waiting responses, bounded polling, live 200s and no renewed ban → `2026-09-14-deploy-log-autoban.md`

- 2026-09-14 · Support agent HANDS: acts as the ticket filer via `/act` (phase 1 DEPLOYED `cc8211c1`), owner SMS + STOP/GO gate (phase 2 DEPLOYED in `12d2c318`), watcher hooked up `84a5fc16`; phase 3 code-ship-after-GO DEPLOYED `8bce4506` (nothing shipped through it yet); writes still OFF; phases 4–5 not built → `2026-09-14-support-agent-acts-as-the-filer.md`

- 2026-09-14 · Profile menu deployment proven; office autoban explained/recovered; live DND test awaits extension → `2026-09-14-profile-menu-design.md`

- 2026-09-14 · Ticket 3GTH9M Trust ext 101 "greeting doesn't play": busy calls skipped it; save now mirrors to busy.wav, `5b499073` DEPLOYED + Trust 101/105/107 backfilled, no real call yet → `2026-09-14-trust-3gth9m-busy-greeting.md`

- 2026-09-14 · Outgoing email sender name "Connect" → "Loopcom" (live DB `EmailProviderConfig.fromName` + api fallback `770de892`) → `2026-09-14-email-sender-name-loopcom.md`

- 2026-09-14 · Solidify Concrete: ext 101+102 on TestFlight; SMS shared inbox on 845-557-7879 + 14 texts backfilled; apps pinned to 443 (need re-sign-in); SMS billing OFF pending Izzy → `2026-09-14-solidify-concrete-101-testflight.md`

- 2026-09-14 · Dashboard + voicemail layout DEPLOYED 7d12c14f; both themes and mobile fixtures verified → `2026-09-14-dashboard-design-concept.md`

- 2026-09-14 · Browser navigation: Loopcom dashboard opened and verified in Chrome → `2026-09-14-browser-navigation.md`

Every file below is in `docs/ai-context/claude-md-sections/` (title starts with its date). Open it, then the full `AGENT_HANDOFF_*.md` it names. One line per area — never expand here.

- 2026-09-15 · B Visible IVR: owner’s call disproved Connect recovery; authorized original PBX route 35/destination 293 restored 13:53:13 ET; post-restore call and PBX Main direct extension dialing pending; publisher 500 unresolved → `2026-09-15-b-visible-ivr-migration-recovery.md`
- 2026-09-15 · Desk Phone Wizard: barcode-first labels, maker clouds, MAC claims, customer token-scanning; vouched-serial gate → `2026-09-14-desk-phone-wizard-automatic-device-identification.md`
- HP/Poly partner + Poly Zero Touch + Poly Lens: RESEARCHED, nothing applied → `2026-09-14-hp-poly-partner-poly-zero-touch-poly-lens-resear.md`
- 2026-09-15 · Fanvil REPLIED: FDPS account ISSUED (login is Izzy's to do, region "Europe"), FDMCS activation link expires ~Sep 18, reseller review + FDPS API review started, buy via 888VoIP → `2026-09-14-fanvil-partner-fdps-fdms-onboarding-started-noth.md`
- Grandstream business onboarding (ITSP / reseller / GDMS) started in Chrome → `2026-09-14-grandstream-business-onboarding-itsp-reseller-gd.md`
- the desk-phone RECORD WRITER exists now, and two defects that would have broken it… → `2026-09-14-the-desk-phone-record-writer-exists-now-and-two.md`
- Izzy's HANDS-OFF mandate: factory-reset FIRST (he was told the cost and reaffirmed… → `2026-09-11-izzy-s-hands-off-mandate-factory-reset-first-he.md`
- the desk-phone wizard WORKS FOR EVERY BRAND now, not just Yealink; the hour-long "… → `2026-09-11-the-desk-phone-wizard-works-for-every-brand-now.md`
- B Visible's busy signal was VoIP.ms's newyork2 POP refusing REGISTRATIONS; trunk 3… → `2026-09-10-b-visible-s-busy-signal-was-voip-ms-s-newyork2-p.md`
- B Visible's busy signal was VoIP.ms's newyork2 POP refusing REGISTRATIONS; trunk 3… → `2026-09-10-b-visible-s-busy-signal-was-voip-ms-s-newyork2-p-2.md`
- the CARRIER MIGRATION BOARD: moving all 52 numbers off VoIP.ms to SignalWire, a fe… → `2026-09-10-the-carrier-migration-board-moving-all-52-number.md`
- the wizard can SAY WHAT IT DID and sweeps EVERY network now, the finish screen sto… → `2026-09-10-the-wizard-can-say-what-it-did-and-sweeps-every.md`
- EVERY ONE OF THE 427 PHONE MODELS HAS AN ADAPTER NOW, and the catalogue is GENERAT… → `2026-09-10-every-one-of-the-427-phone-models-has-an-adapter.md`
- the 100-person MEETINGS load test ran for an hour with US ends : LiveKit relayed C… → `2026-09-10-the-100-person-meetings-load-test-ran-for-an-hou.md`
- Microsoft Store + Teams: what it takes → `2026-09-10-microsoft-store-teams-what-it-takes.md`
- Sign in with Google is on the login page: LOGIN ONLY, NEVER SIGN-UP, and both call… → `2026-09-10-sign-in-with-google-is-on-the-login-page-login-o.md`
- the FCC Form 499 Filer ID is 839208, the RMD form has NO field for it, and the FCC… → `2026-09-10-the-fcc-form-499-filer-id-is-839208-the-rmd-form.md`
- Meta business verification: REJECTED 09-09 (5-day-old LLC, "suit c", unconfirmed e… → `2026-09-10-meta-business-verification-rejected-09-09-5-day.md`
- the Loopcom Coworker HAS REAL HANDS: the desktop links to the agent, the model cal… → `2026-09-09-the-loopcom-coworker-has-real-hands-the-desktop.md`
- McNamara Lion is the FIRST existing tenant with the overdue-account cutoff switche… → `2026-09-09-mcnamara-lion-is-the-first-existing-tenant-with.md`
- the portal INSTALL link (`/desktop/Connect-Setup-latest.exe`) now serves desktop `… → `2026-09-09-the-portal-install-link-desktop-connect-setup-la.md`
- Voicemail email transcript toggle renamed "Include transcription in email" → `2026-09-09-voicemail-email-transcript-toggle-renamed-includ.md`
- the Coworker BUBBLE's chat popover no longer CLOSES ITSELF when the hands ask for… → `2026-09-09-the-coworker-bubble-s-chat-popover-no-longer-clo.md`
- Remote Desktop `rd-btn--primary` is now BLUE FILL + DARK BOLD TEXT (the Meetings "… → `2026-09-09-remote-desktop-rd-btn-primary-is-now-blue-fill-d.md`
- the dev box runs desktop `0.1.17-rc.10` REBUILT from a clean export; the 14:24 in-… → `2026-09-09-the-dev-box-runs-desktop-0-1-17-rc-10-rebuilt-fr.md`
- the dev box (VMI3409497) runs desktop `0.1.17-rc.9` now, REBUILT HERE from a clean… → `2026-09-09-the-dev-box-vmi3409497-runs-desktop-0-1-17-rc-9.md`
- "the MCP ain't picking up tickets" : pickup IS automatic, drill-proven end to end;… → `2026-09-09-the-mcp-ain-t-picking-up-tickets-pickup-is-autom.md`
- Relax Tires pays on the 26th now; moving a billing day LATER needs the OPEN invoic… → `2026-09-09-relax-tires-pays-on-the-26th-now-moving-a-billin.md`
- Secro Selutions was NOT invoiced or charged on 09-06 (nor on 08-06): a Sola recurr… → `2026-09-09-secro-selutions-was-not-invoiced-or-charged-on-0.md`
- the Gesheft pay line played the WRONG VOICE and threw every caller to a person at… → `2026-09-08-the-gesheft-pay-line-played-the-wrong-voice-and.md`
- the bottom-right "Incoming Call / Unknown caller / Dismiss" card (CRM screen pop)… → `2026-09-08-the-bottom-right-incoming-call-unknown-caller-di.md`
- Store → Orders status tabs (Needs review / Sent / Failed to send / Dismissed / All… → `2026-09-08-store-orders-status-tabs-needs-review-sent-faile.md`
- Store → Orders (Supermarket mode) now has Received date-range, status tabs (+Faile… → `2026-09-08-store-orders-supermarket-mode-now-has-received-d.md`
- Sign-in code (2FA by text/email) v3: PER USER, turned on/off ONLY on Account → Sec… → `2026-09-08-sign-in-code-2fa-by-text-email-v3-per-user-turne.md`
- Tracking → Orders now has a Received date-range filter, store filter and real pagi… → `2026-09-08-tracking-orders-now-has-a-received-date-range-fi.md`
- the "<unknown> → h" Active Call that sits for hours after a reboot is Asterisk's `… → `2026-09-08-the-unknown-h-active-call-that-sits-for-hours-af.md`
- A plus center "not all users synced": the 21 extensions ARE in sync and VitalPBX h… → `2026-09-08-a-plus-center-not-all-users-synced-the-21-extens.md`
- Trust Bookkeepings got a stock number on its OWN VoIP.ms subaccount, routed to ext… → `2026-09-07-trust-bookkeepings-got-a-stock-number-on-its-own.md`
- Relax Tires 101 "vibrating, not ringing, no incoming-call screen" : the ring reach… → `2026-09-07-relax-tires-101-vibrating-not-ringing-no-incomin.md`
- the dial pad showed ONLY 2/5/8/0 because the app's process was BORN SIDEWAYS: neve… → `2026-09-06-the-dial-pad-showed-only-2-5-8-0-because-the-app.md`
- Fixup Group "to the roots": the iPhones have NEVER connected an inbound call, beca… → `2026-09-04-fixup-group-to-the-roots-the-iphones-have-never.md`
- the softphone REPORTS EVERY DEVICE EVENT AND EVERY PRESS now: read `/admin/call-ti… → `2026-09-03-the-softphone-reports-every-device-event-and-eve.md`
- a factory-reset Yealink gets its provisioning folder FROM THE OFFICE MACHINE now:… → `2026-09-02-a-factory-reset-yealink-gets-its-provisioning-fo.md`
- the desk-phone wizard lets the person PICK which phones to set up; an unticked pho… → `2026-09-02-the-desk-phone-wizard-lets-the-person-pick-which.md`
- the wizard finds PANASONIC phones now, and the PBX can NEVER provision one → `2026-09-03-the-wizard-finds-panasonic-phones-now-and-the-pb.md`
- Create A Box 102 "answers, no audio either side": the app's 200 OK never reaches t… → `2026-09-02-create-a-box-102-answers-no-audio-either-side-th.md`
- Gesheft ticket Y7FK8P "the phone isn't ringing and voicemails don't come up" : the… → `2026-09-02-gesheft-ticket-y7fk8p-the-phone-isn-t-ringing-an.md`
- inii mini's two-day busy signal: the whole chain, both customers FIXED, and the SA… → `2026-09-04-inii-mini-s-two-day-busy-signal-the-whole-chain.md`
- "VoIP.ms was down, reset all registrations" → two trunks CANNOT register because V… → `2026-09-02-voip-ms-was-down-reset-all-registrations-two-tru.md`
- GESHEFT'S VOICEMAIL EMAIL IS ON CONNECT NOW; NO TENANT IS ON THE PBX'S OWN VOICEMA… → `2026-09-02-gesheft-s-voicemail-email-is-on-connect-now-no-t.md`
- the Coworker HAS HANDS: three allowlisted tasks, approved on a card, run by the de… → `2026-09-02-the-coworker-has-hands-three-allowlisted-tasks-a.md`
- REMOTE DESKTOP IS BUILT END TO END: own computers unattended, Connect ID + passwor… → `2026-09-02-remote-desktop-is-built-end-to-end-own-computers.md`
- every sidebar page has its OWN permission key now, and the "Owner only" lift is GONE → `2026-09-02-every-sidebar-page-has-its-own-permission-key-no.md`
- REMOTE DESKTOP as a CUSTOMER feature is MOCKUPS ONLY, six decisions open → `2026-09-02-remote-desktop-as-a-customer-feature-is-mockups.md`
- the Coworker BUBBLE was DEAD: its drag region ate every click, its chat was the OW… → `2026-09-02-the-coworker-bubble-was-dead-its-drag-region-ate.md`
- the Google OAuth app is FOUND, rebranded Loopcom, PUBLISHED, and the brand is unde… → `2026-09-02-the-google-oauth-app-is-found-rebranded-loopcom.md`
- remote support is INSIDE the real Windows app now, OFF by default, and there is a… → `2026-09-01-remote-support-is-inside-the-real-windows-app-no.md`
- "the delivery driver called and the phone never rang" on B Visible was MENU OPTION… → `2026-09-01-the-delivery-driver-called-and-the-phone-never-r.md`
- Trimpro's call flow is MAPPED and their SECOND NUMBER GOES NOWHERE → `2026-09-01-trimpro-s-call-flow-is-mapped-and-their-second-n.md`
- Yossis Wood Works pays MANUALLY, on the 4th, the worker invoices+emails manual-pay… → `2026-09-02-yossis-wood-works-pays-manually-on-the-4th-the-w.md`
- B Visible now bills on the 2nd and Gesheft on the 3rd, and moving a billing day EA… → `2026-08-31-b-visible-now-bills-on-the-2nd-and-gesheft-on-th.md`
- YS Plumbing is a BILLING-ONLY tenant: no PBX, no extension row, back-billed to May 20 → `2026-08-31-ys-plumbing-is-a-billing-only-tenant-no-pbx-no-e.md`
- the customer pay page is REBUILT AND DEPLOYED: one column, collapsible breakdown,… → `2026-09-01-the-customer-pay-page-is-rebuilt-and-deployed-on.md`
- the support loop CLOSES now: the customer is told in plain English, tests it, and… → `2026-08-31-the-support-loop-closes-now-the-customer-is-told.md`
- a customer's support request now opens a Claude agent on Izzy's machine BY ITSELF,… → `2026-08-31-a-customer-s-support-request-now-opens-a-claude.md`
- every sidebar page has its own “In sidebar” switch on /admin/permissions now, SEPA… → `2026-08-31-every-sidebar-page-has-its-own-in-sidebar-switch.md`
- a hangup clears Active Calls + Team Directory INSTANTLY now, web and mobile → `2026-08-31-a-hangup-clears-active-calls-team-directory-inst.md`
- the supermarket search finds the WHOLE catalog now, and negative stock stopped ste… → `2026-08-30-the-supermarket-search-finds-the-whole-catalog-n.md`
- FixUp's "Windows app gets no messages" is the desktop notifier only firing on NEW… → `2026-08-30-fixup-s-windows-app-gets-no-messages-is-the-desk.md`
- every extension gets FIVE contacts, desk AND WebRTC → `2026-08-30-every-extension-gets-five-contacts-desk-and-webr.md`
- SIGNALWIRE ONBOARDING IS BUILT END TO END and INERT until two env flips (09-16: 10DLC activation email could never queue — fixed `966c9110`) → `2026-08-30-signalwire-onboarding-is-built-end-to-end-and-in.md`
- a SignalWire inbound call rang NOBODY: the one-shot ring push raced the tenant, TW… → `2026-08-29-a-signalwire-inbound-call-rang-nobody-the-one-sh.md`
- 7-day audit of voicemail + SMS forwarding: both lanes CLEAN, but an audio-copy RAC… → `2026-08-27-7-day-audit-of-voicemail-sms-forwarding-both-lan.md`
- Relax Tires round 2: "vibrating but no incoming call until I opened the app" is AN… → `2026-09-01-relax-tires-round-2-vibrating-but-no-incoming-ca.md`
- Relax Tires "it only rang my cell, not the app": the PBX rang the app on EVERY cal… → `2026-08-27-relax-tires-it-only-rang-my-cell-not-the-app-the.md`
- the ORDER-AGENT TRAINING LOOP: corrections teach INSTANTLY without submitting, hou… → `2026-08-27-the-order-agent-training-loop-corrections-teach.md`
- "they left a voicemail and we never got it" was a caller hanging up inside a 24-SE… → `2026-08-27-they-left-a-voicemail-and-we-never-got-it-was-a.md`
- the support desk blamed a router while the real packet loss was on a DIFFERENT ext… → `2026-08-26-the-support-desk-blamed-a-router-while-the-real.md`
- CRM SUPERMARKET MODE is BUILT END TO END (phases 0–7, the Gesheft plan) and is INE… → `2026-08-26-crm-supermarket-mode-is-built-end-to-end-phases.md`
- the supermarket DELIVERY TRACKING system: server side complete and LIVE-BUT-INERT… → `2026-08-25-the-supermarket-delivery-tracking-system-server.md`
- the IVR migration's red "Connect can't reproduce these" list is MOSTLY A FALSE ALA… → `2026-08-24-the-ivr-migration-s-red-connect-can-t-reproduce.md`
- Fixup Group's iPhone was never in the ring list: the wake hold is per-shared-AOR b… → `2026-08-24-fixup-group-s-iphone-was-never-in-the-ring-list.md`
- CLAUDE.md ITSELF CONTAINS A NUL BYTE AND HAS BEEN COMMITTING AS CRLF SINCE `d39cad… → `2026-08-24-claude-md-itself-contains-a-nul-byte-and-has-bee.md`
- the loopcom.net WEBSITE has a robot check on its forms, and Cloudflare is CONFIGUR… → `2026-08-24-the-loopcom-net-website-has-a-robot-check-on-its.md`
- you can email a customer their sign-up link now, and read exactly what they did → `2026-08-24-you-can-email-a-customer-their-sign-up-link-now.md`
- the WhatsApp numbers are "Pending" because the review NEVER STARTED, and the Meta… → `2026-08-24-the-whatsapp-numbers-are-pending-because-the-rev.md`
- the email footer names the CUSTOMER'S company now, not "your organization" → `2026-08-24-the-email-footer-names-the-customer-s-company-no.md`
- Izzy is emailed on EVERY settled payment now → `2026-08-23-izzy-is-emailed-on-every-settled-payment-now.md`
- the door bells can have their own caller ID, and it is ONE live-read field → `2026-08-23-the-door-bells-can-have-their-own-caller-id-and.md`
- two customers could not receive a voicemail for MONTHS and nobody knew → `2026-08-23-two-customers-could-not-receive-a-voicemail-for.md`
- LoopCom is FEDERALLY REGISTERED (FRN + 499-A + RMD all filed) and the COMPLIANCE C… → `2026-08-23-loopcom-is-federally-registered-frn-499-a-rmd-al.md`
- the invoice and receipt are LOOPCOM END TO END now — wordmark, `Loopcom LLC`, `bil… → `2026-08-23-the-invoice-and-receipt-are-loopcom-end-to-end-n.md`
- the browser tab shows the Loopcom mark now → `2026-08-23-the-browser-tab-shows-the-loopcom-mark-now.md`
- every dropdown platform-wide is ConnectSelect now → `2026-08-23-every-dropdown-platform-wide-is-connectselect-no.md`
- the device setup wizard (ANY VoIP device, not just desk phones) is BUILT END TO EN… → `2026-08-21-the-device-setup-wizard-any-voip-device-not-just.md`
- CAPACITY TUNING APPLIED — RTP range widened, coturn quota raised, Postgres connect… → `2026-08-23-capacity-tuning-applied-rtp-range-widened-coturn.md`
- HIPAA readiness: Loopcom is NOT compliant, and MEETINGS is the cleanest part of th… → `2026-08-21-hipaa-readiness-loopcom-is-not-compliant-and-mee.md`
- the PBX Console draws the panel's WHOLE form now (289 fields, nothing hardcoded),… → `2026-08-21-the-pbx-console-draws-the-panel-s-whole-form-now.md`
- the Windows app is Loopcom, and the icon that "kept disappearing" was NEVER IN THE… → `2026-08-21-the-windows-app-is-loopcom-and-the-icon-that-kep.md`
- the American Jewish calendar is BUILT END TO END: it drives the IVR menu AND the h… → `2026-08-21-the-american-jewish-calendar-is-built-end-to-end.md`
- the Cloudflare bot check is ON the login page and now ARMED in OBSERVE mode; the s… → `2026-08-21-the-cloudflare-bot-check-is-on-the-login-page-an.md`
- Luxure Management ext 101: ONE failed answer in three weeks, and it is a DIFFERENT… → `2026-08-23-luxure-management-ext-101-one-failed-answer-in-t.md`
- Hanna's dropped answer is FIXED FOR REAL: the stop-ring was asking who answered on… → `2026-08-23-hanna-s-dropped-answer-is-fixed-for-real-the-sto.md`
- the Windows app has NO protection for an answer that is never acknowledged, and Ge… → `2026-08-24-the-windows-app-has-no-protection-for-an-answer.md`
- answering a call on the CURRENT Android build tears the call down: the warm answer… → `2026-08-23-answering-a-call-on-the-current-android-build-te.md`
- the mobile keypad HID `*`, `#` and `+`, so they read as dead keys → `2026-08-23-the-mobile-keypad-hid-and-so-they-read-as-dead-k.md`
- the Android boot flash is FIXED and PUBLISHED: fleet APK 1.0.0+20260823-152650, 63… → `2026-08-23-the-android-boot-flash-is-fixed-and-published-fl.md`
- saved contact names now actually show on incoming calls and missed-call alerts → `2026-08-23-saved-contact-names-now-actually-show-on-incomin.md`
- the Android launcher icon is BLUE 2B from the icon-refinement kit, and the status-… → `2026-08-22-the-android-launcher-icon-is-blue-2b-from-the-ic.md`
- the Android app is Loopcom now (icon spacing, splash, 31 strings) and it is on NO… → `2026-08-21-the-android-app-is-loopcom-now-icon-spacing-spla.md`
- every api and portal deploy was rolling ITSELF back while the platform was perfect… → `2026-08-21-every-api-and-portal-deploy-was-rolling-itself-b.md`
- the app's own "cleanup" was HANGING UP THE DESK PHONE's live calls, and call waiti… → `2026-08-20-the-app-s-own-cleanup-was-hanging-up-the-desk-ph.md`
- Hanna's first calls: "hangs up on answer" was her cellular uplink, "picture came a… → `2026-08-21-hanna-s-first-calls-hangs-up-on-answer-was-her-c.md`
- Hanna "couldn't call Israel": NOTHING blocked her, and `011` is the ONLY internati… → `2026-09-01-hanna-couldn-t-call-israel-nothing-blocked-her-a.md`
- "Hanna" is a FREE tenant: LIVE with ext 101 + (845) 557-7194 + SMS, and NO billing… → `2026-08-20-hanna-is-a-free-tenant-live-with-ext-101-845-557.md`
- Teams / Google Meet VIDEO interop is CLOSED to third parties → `2026-08-21-teams-google-meet-video-interop-is-closed-to-thi.md`
- the PLATFORM-AUTH PROGRAM (Google / Meta / Microsoft-Outlook / TikTok): RESEARCHED… → `2026-08-21-the-platform-auth-program-google-meta-microsoft.md`
- GOOGLE PLAY STORE: Blue-2B store icon LIVE on the public page since 09-15; vc102 (BootReceiver skips keepalive launch on Android 15+, `cd9231be`) went live, and **vc103 (the tablet fix) is LIVE as of 09-15**; ⏳ no Android-15 reboot test, next code **104**; ⛔ Console now behind a new ToS wall → `2026-08-29-google-play-store-the-organization-account-exist.md`
- Loopcom Direct is BUILT: cross-company chat by phone number + the video call that… → `2026-08-21-loopcom-direct-is-built-cross-company-chat-by-ph.md`
- "Loopcom Direct" plan + mockups — SUPERSEDED by the BUILD section above; kept for… → `2026-08-20-loopcom-direct-plan-mockups-superseded-by-the-bu.md`
- the support desk redesign is BUILT: the Inbox is gone at the SCHEMA, the agent has… → `2026-08-24-the-support-desk-redesign-is-built-the-inbox-is.md`
- the support desk AUDIT: the IDE's chat cannot see the IDE, and the Inbox reads 679… → `2026-08-24-the-support-desk-audit-the-ide-s-chat-cannot-see.md`
- the Technical Support Console is BUILT END TO END: escalation CHATS, cross-company… → `2026-08-21-the-technical-support-console-is-built-end-to-en.md`
- TURN health watch: Izzy is TEXTED when the call relay dies, and its first version… → `2026-08-21-turn-health-watch-izzy-is-texted-when-the-call-r.md`
- Loopcom Meetings: link-join VIDEO MEETINGS on self-hosted LiveKit, LIVE end to end → `2026-08-20-loopcom-meetings-link-join-video-meetings-on-sel.md`
- the SMS↔email bridge is CODE-COMPLETE: texts email out from sms@loopcom.net and RE… → `2026-08-20-the-sms-email-bridge-is-code-complete-texts-emai.md`
- CONFERENCE ROOMS are LIVE end to end: backend + the Option-A page in Workspace, DE… → `2026-08-20-conference-rooms-are-live-end-to-end-backend-the.md`
- the AI agent treated every TENANT_ADMIN as Connect staff; fortification pass FIXED… → `2026-08-19-the-ai-agent-treated-every-tenant-admin-as-conne.md`
- "I've passed this to the Connect team" reached NOBODY for two weeks, and a hold-mu… → `2026-08-19-i-ve-passed-this-to-the-connect-team-reached-nob.md`
- the assistant has a READ-ONLY WORKSPACE on both servers now, and its findings must… → `2026-08-18-the-assistant-has-a-read-only-workspace-on-both.md`
- the PBX CONSOLE replaces the VitalPBX panel from inside Connect: reads + one exten… → `2026-08-19-the-pbx-console-replaces-the-vitalpbx-panel-from.md`
- 2026-09-15 · VitalPBX subscription CANCELED (lic not yet lapsed, refreshed Sep 12); phoneprov serving 200 + backend render path verified alive post-cancellation; exit assessment + mirror inside → `2026-08-18-dropping-the-vitalpbx-one-subscription-possible.md`
- SignalWire is being EVALUATED to replace VoIP.ms: a test bench exists at `/apps/si… → `2026-08-18-signalwire-is-being-evaluated-to-replace-voip-ms.md`
- the voice changer: a recording comes back in a different voice, and the audio NEVE… → `2026-08-18-the-voice-changer-a-recording-comes-back-in-a-di.md`
- a tenant can require a SIGN-IN CODE by text/email (2FA per company, "remember this… → `2026-08-19-a-tenant-can-require-a-sign-in-code-by-text-emai.md`
- the platform's public identity lives in ONE module now (`publicOrigins.ts`), the S… → `2026-08-19-the-platform-s-public-identity-lives-in-one-modu.md`
- the platform's rate limiter had NEVER run; SSH takes keys only; both hostnames are… → `2026-08-19-the-platform-s-rate-limiter-had-never-run-ssh-ta.md`
- the last seven tenant-scoping findings are closed, and TWO of them were never live → `2026-08-18-the-last-seven-tenant-scoping-findings-are-close.md`
- a sold-out area code said NOTHING, and that silence put one person's address on an… → `2026-08-18-a-sold-out-area-code-said-nothing-and-that-silen.md`
- email guardrails + self-healing are LIVE : the pipeline repairs itself, and the al… → `2026-08-18-email-guardrails-self-healing-are-live-the-pipel.md`
- voicemail email was DEAD for ~20 hours after the PBX cutover, FIXED and proven 202… → `2026-08-18-voicemail-email-was-dead-for-20-hours-after-the.md`
- a source-reading guard test that fails ONLY on Windows is a CRLF artifact, not a r… → `2026-08-18-a-source-reading-guard-test-that-fails-only-on-w.md`
- session tokens still never expire, ON PURPOSE for now: adding `expiresIn` today wo… → `2026-08-18-session-tokens-still-never-expire-on-purpose-for.md`
- the Yiddish assistant answers in fluent Yiddish and says NOTHING, because the Yidd… → `2026-08-18-the-yiddish-assistant-answers-in-fluent-yiddish.md`
- the PBX name is what we call people now, on screen and in every email → `2026-08-17-the-pbx-name-is-what-we-call-people-now-on-scree.md`
- tenant isolation audit: the ROUTES are fine, the SECRETS are empty → `2026-08-17-tenant-isolation-audit-the-routes-are-fine-the-s.md`
- the sidebar rebuilt itself on every toggle, and ANY DOM change in the portal costs… → `2026-08-17-the-sidebar-rebuilt-itself-on-every-toggle-and-a.md`
- every sign-up now registers its own address for 911 → `2026-08-17-every-sign-up-now-registers-its-own-address-for.md`
- the whole tenant directory was downloadable by a stranger, and two doors that "che… → `2026-08-18-the-whole-tenant-directory-was-downloadable-by-a.md`
- the assistant panel opens differently, and a customer can now reach a PERSON witho… → `2026-08-17-the-assistant-panel-opens-differently-and-a-cust.md`
- the overdue-account cutoff is WIRED END TO END and ARMED ; 911 nearly got switched… → `2026-08-18-the-overdue-account-cutoff-is-wired-end-to-end-a.md`
- the last four tenant-isolation criticals are closed: a role read from the body, an… → `2026-08-18-the-last-four-tenant-isolation-criticals-are-clo.md`
- `/internal/*` was an unlocked door on the public internet, and it is shut now → `2026-08-18-internal-was-an-unlocked-door-on-the-public-inte.md`
- the NODE_ENV sweep is FINISHED: the payment-safety guard that had never run, and t… → `2026-08-18-the-node-env-sweep-is-finished-the-payment-safet.md`
- a shared secret could mint a platform-wide SUPER_ADMIN token from the public inter… → `2026-08-18-a-shared-secret-could-mint-a-platform-wide-super.md`
- NEW TENANTS DEFAULT TO SIP-OVER-443, AND AN EMAIL CAN CARRY A FILE → `2026-08-17-new-tenants-default-to-sip-over-443-and-an-email.md`
- every B Visible seat has a WebRTC softphone now, and adding one SILENTLY SPENDS a… → `2026-08-24-every-b-visible-seat-has-a-webrtc-softphone-now.md`
- B Visible's Philippines employee: tunnel built, tenant moved to 443, extension NOT… → `2026-08-17-b-visible-s-philippines-employee-tunnel-built-te.md`
- Create A Box ext 102 answered and got voicemail AGAIN, because his phone is 8 days… → `2026-08-17-create-a-box-ext-102-answered-and-got-voicemail.md`
- a blank mini dialer, because we flooded a customer off our own server → `2026-08-17-a-blank-mini-dialer-because-we-flooded-a-custome.md`
- remote support grew a KILL SWITCH, capability tiers and a transcript; attacking it… → `2026-08-31-remote-support-grew-a-kill-switch-capability-tie.md`
- remote support: we can now watch and drive a customer's Windows machine → `2026-08-16-remote-support-we-can-now-watch-and-drive-a-cust.md`
- a customer saved a forward and their whole phone system went dead → `2026-08-16-a-customer-saved-a-forward-and-their-whole-phone.md`
- inii mini wants to sell by TEXT MESSAGE; Shopify scoped and quoted, nothing built → `2026-08-16-inii-mini-wants-to-sell-by-text-message-shopify.md`
- Ezra's trainer sheet, worked end to end → `2026-08-16-ezra-s-trainer-sheet-worked-end-to-end.md`
- a custom role REPLACES the user's permissions; and one phone's second company is n… → `2026-08-13-a-custom-role-replaces-the-user-s-permissions-an.md`
- every shortcode SMS was silently discarded, platform-wide → `2026-08-16-every-shortcode-sms-was-silently-discarded-platf.md`
- a voice note cut off after seconds, and our own denoiser made the sender sound "li… → `2026-08-16-a-voice-note-cut-off-after-seconds-and-our-own-d.md`
- Connect is on TWO hostnames now, and that makes every hardcoded absolute API URL a… → `2026-08-16-connect-is-on-two-hostnames-now-and-that-makes-e.md`
- the login brute-force limiter had NEVER run; the portal ships no security headers;… → `2026-08-16-the-login-brute-force-limiter-had-never-run-the.md`
- Cloudflare Phase C staging is COMPLETE and `app.` IS STILL DNS-ONLY → `2026-08-17-cloudflare-phase-c-staging-is-complete-and-app-i.md`
- the SIP hostname split is DONE: new accounts get Loopcom, every existing customer… → `2026-08-17-the-sip-hostname-split-is-done-new-accounts-get.md`
- the customer's price is ALL-INCLUSIVE now; taxes live INSIDE the total → `2026-08-16-the-customer-s-price-is-all-inclusive-now-taxes.md`
- the WhatsApp integration cannot send, and its projection path would CRASH on day one → `2026-08-16-the-whatsapp-integration-cannot-send-and-its-pro.md`
- the assistant now READS a system document + THIS company's document before answering → `2026-08-16-the-assistant-now-reads-a-system-document-this-c.md`
- reply `FIX <code>` to an escalation text and the fix HAPPENS → `2026-08-16-reply-fix-code-to-an-escalation-text-and-the-fix.md`
- the assistant had NO access to any MD file, and its knowledge base was dead code → `2026-08-16-the-assistant-had-no-access-to-any-md-file-and-i.md`
- the PBX ALREADY ships a queue wallboard, and Gesheft already has logins for it → `2026-08-16-the-pbx-already-ships-a-queue-wallboard-and-gesh.md`
- the brand is Loopcom (lowercase c) and it is LIVE on login, the topbar, the invite… → `2026-08-16-the-brand-is-loopcom-lowercase-c-and-it-is-live.md`
- the LoopCom logo is in the repo and LIVE on the sign-in page → `2026-08-16-the-loopcom-logo-is-in-the-repo-and-live-on-the.md`
- a WAITING call ending killed the LIVE call's UI, DTMF stayed on the wrong speaker,… → `2026-08-27-a-waiting-call-ending-killed-the-live-call-s-ui.md`
- the Call History player was a SECOND player, and it never got the fix → `2026-08-13-the-call-history-player-was-a-second-player-and.md`
- adding a card goes through the standard Sola payment page now → `2026-08-20-adding-a-card-goes-through-the-standard-sola-pay.md`
- payment links: copy, text from Connect's number, one link for ALL open invoices → `2026-08-12-payment-links-copy-text-from-connect-s-number-on.md`
- the assistant can now ADD BILLABLE THINGS → `2026-08-07-the-assistant-can-now-add-billable-things.md`
- an extension that could not be deleted → `2026-08-13-an-extension-that-could-not-be-deleted.md`
- the assistant can ANSWER "when does my number transfer?" now, and the question use… → `2026-08-21-the-assistant-can-answer-when-does-my-number-tra.md`
- number ports land themselves now → `2026-08-12-number-ports-land-themselves-now.md`
- ALERT EMAILS ARE MUTED AT THE SEND DOOR; ONLY ASSISTANT ESCALATIONS REACH THE OWNER → `2026-08-12-alert-emails-are-muted-at-the-send-door-only-ass.md`
- `docs/` is IN GIT now — the force-add ritual is dead; only `docs/pbx-brain/` stays… → `2026-08-12-docs-is-in-git-now-the-force-add-ritual-is-dead.md`
- escalations go somewhere now; recordings stopped lying; voicemails play their own… → `2026-08-12-escalations-go-somewhere-now-recordings-stopped.md`
- the Team Directory could not scroll unless the window was maximised → `2026-08-12-the-team-directory-could-not-scroll-unless-the-w.md`
- voicemail-to-email is sent BY THE PBX, not by Connect → `2026-08-09-voicemail-to-email-is-sent-by-the-pbx-not-by-con.md`
- billing ignored the app's own theme, and 22 tenants deleted on the PBX were still… → `2026-08-12-billing-ignored-the-app-s-own-theme-and-22-tenan.md`
- the phone rang while the PBX had nowhere to send the call → `2026-08-10-the-phone-rang-while-the-pbx-had-nowhere-to-send.md`
- the voicemail preloader drowned the PBX helper; fix DEPLOYED + traffic-proven → `2026-08-12-the-voicemail-preloader-drowned-the-pbx-helper-f.md`
- "I have to reload a few times for it to register" → `2026-08-20-i-have-to-reload-a-few-times-for-it-to-register.md`
- the dialer locked ITSELF out and sat on "Connecting" → `2026-08-10-the-dialer-locked-itself-out-and-sat-on-connecti.md`
- "can we run our own mailboxes without Google?" → `2026-08-24-can-we-run-our-own-mailboxes-without-google.md`
- THE ONE MAILBOX SENDS EVERYTHING, CAPPED AT 500/DAY → `2026-08-06-the-one-mailbox-sends-everything-capped-at-500-d.md`
- the AI trainer taught the agent NOTHING for 9 days → `2026-08-09-the-ai-trainer-taught-the-agent-nothing-for-9-da.md`
- the IVR Studio, walked end to end for the first time → `2026-08-07-the-ivr-studio-walked-end-to-end-for-the-first-t.md`
- "everything is loading very, very slow" → `2026-08-06-everything-is-loading-very-very-slow.md`
- a reassigned desk phone never hears about it → `2026-08-06-a-reassigned-desk-phone-never-hears-about-it.md`
- "he answered and got voicemail" → `2026-08-06-he-answered-and-got-voicemail.md`
- billing: 4 live bugs fixed, screens rebuilt → `2026-08-07-billing-4-live-bugs-fixed-screens-rebuilt.md`
- 2026-09-16 · turning SMS on for a customer — SECRO "SMS not working" = number never assigned in Connect; 845-751-8493 now their shared inbox, inbound proven (fetched=3), ⏳ no outbound yet, billing off; ⛔ PBX VitalPBX SMS add-on IS in use (callback on ≥11 DIDs) → `2026-08-07-turning-sms-on-for-a-customer.md`
- "I changed it in VitalPBX and the phone didn't change" → `2026-08-06-i-changed-it-in-vitalpbx-and-the-phone-didn-t-ch.md`
- IVR Studio: forwards, direct dial, audible prompts → `2026-08-06-ivr-studio-forwards-direct-dial-audible-prompts.md`
- the agent got TOOLS; audio adaptation is measured but not built → `2026-08-06-the-agent-got-tools-audio-adaptation-is-measured.md`
- the worker's dead push channel + a website that lived in a stash → `2026-08-06-the-worker-s-dead-push-channel-a-website-that-li.md`
- the portal `.payload` trap + IVR Studio publish feedback → `2026-08-06-the-portal-payload-trap-ivr-studio-publish-feedb.md`
- ElevenLabs "the key isn't accepted" → `2026-08-06-elevenlabs-the-key-isn-t-accepted.md`
- the IVR actually works now → `2026-08-06-the-ivr-actually-works-now.md`
- the IVR coverage suite REWRITES live config → `2026-08-06-the-ivr-coverage-suite-rewrites-live-config.md`
- Amazon Polly as a second IVR voice → `2026-08-06-amazon-polly-as-a-second-ivr-voice.md`
- VitalPBX panel locked out of its own configs → `2026-08-06-vitalpbx-panel-locked-out-of-its-own-configs.md`
- Connect doorway rebuild: DID switch-to-connect was broken platform-wide → `2026-08-05-connect-doorway-rebuild-did-switch-to-connect-wa.md`
- Create A Box (T7) desk-phone outage + ext 102 app failure → `2026-08-05-create-a-box-t7-desk-phone-outage-ext-102-app-fa.md`
- onboarding uploads were destroyed by every api deploy → `2026-08-06-onboarding-uploads-were-destroyed-by-every-api-d.md`
- onboarding E2E payment proof, journey tracking, auto-ban fix → `2026-08-04-onboarding-e2e-payment-proof-journey-tracking-au.md`
- wake-and-wait FLEET ROLLOUT → `2026-08-05-wake-and-wait-fleet-rollout.md`
- IVR Studio: numbers/scheduling/announcements, wizard checkout, ElevenLabs, teams,… → `2026-08-04-ivr-studio-numbers-scheduling-announcements-wiza.md`
- Eli iOS freezes → 443 route, paste-on-iOS-26, build 52 → `2026-08-05-eli-ios-freezes-443-route-paste-on-ios-26-build.md`
- onboarding round 2 deploy + worktree cleanup → `2026-08-05-onboarding-round-2-deploy-worktree-cleanup.md`
- stranded paid sign-up watchdog → `2026-08-04-stranded-paid-sign-up-watchdog.md`
- month-2 billing = the $35 sign-up quote → `2026-08-04-month-2-billing-the-35-sign-up-quote.md`
- CDR silent loss + live-call sync → `2026-08-04-cdr-silent-loss-live-call-sync.md`
- ElevenLabs "didn't play" + pipeline hardening → `2026-08-04-elevenlabs-didn-t-play-pipeline-hardening.md`
- voicemail playback wedge / phantom Telecom call → `2026-08-04-voicemail-playback-wedge-phantom-telecom-call.md`
- one tenant per paid sign-up → `2026-08-04-one-tenant-per-paid-sign-up.md`
- filtered internet + reading registration data → `2026-08-03-filtered-internet-reading-registration-data.md`
- Voicemail greeting upload + Call-to-Record → `2026-08-04-voicemail-greeting-upload-call-to-record.md`
- cross-tenant leak + iOS modal keyboard trap → `2026-08-02-cross-tenant-leak-ios-modal-keyboard-trap.md`
- Android keyboard covers the screen → `2026-08-04-android-keyboard-covers-the-screen.md`
- contacts 1,000-cap + ghost call screen → `2026-08-02-contacts-1-000-cap-ghost-call-screen.md`
- iOS CallKit zombie call + TestFlight release → `2026-08-02-ios-callkit-zombie-call-testflight-release.md`
- Android SDK 54 build + PBX push-and-wait → `2026-08-01-android-sdk-54-build-pbx-push-and-wait.md`
- registration drops & push delivery → `2026-07-31-registration-drops-push-delivery.md`
- iOS parity engagement → `2026-07-30-ios-parity-engagement.md`
- Mobile audio / incoming calls → `2026-07-30-mobile-audio-incoming-calls.md`
- Audio/Reliability/Notifications engagement → `2026-07-29-audio-reliability-notifications-engagement.md`
- the APK link was missing from sign-up invitations → `2026-08-09-the-apk-link-was-missing-from-sign-up-invitation.md`
- B Visible engagement — where the handoff lives → `2026-07-17-b-visible-engagement-where-the-handoff-lives.md`
- Shammes AI agent / PBX M-capabilities engagement → `2026-07-26-shammes-ai-agent-pbx-m-capabilities-engagement.md`
- Onboarding automation engagement → `2026-07-26-onboarding-automation-engagement.md`
- Mobile Android call-reliability engagement → `2026-07-27-mobile-android-call-reliability-engagement.md`

- 2026-09-14 · Universal search: permitted pages, settings and records → `2026-09-14-universal-search.md`
- 2026-09-16 · Laybel: live VOICE enum crash confirmed; local CHAT mapping + YL microphone/English speech/Yiddish chat, 74+31 tests; push approval/deploy/audible proof pending → `2026-09-15-face-to-face-ai-support-mockup.md`
