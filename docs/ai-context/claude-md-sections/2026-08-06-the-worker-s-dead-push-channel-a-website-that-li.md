# ⛔ AGENT HANDOFF — the worker's dead push channel + a website that lived in a stash (2026-08-06) — READ FIRST before dropping ANY stash, removing a worktree on Windows, or believing a push/wake feature is live

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_WORKTREE_SWEEP_FCM_WIRING_2026-08-06.md`**
(commits `f9907e5d`, `8c15d5fa`, `8b2c29f6`, `5272a8fc` on
`feat/ivr-migration-takeover`; `ad3fb49d` on `rescue/marketing-website`.
api + portal + worker **DEPLOYED and verified**.)

- ⛔ **`git stash show --stat` shows NOTHING for a stash carrying untracked
  files** — it is a 3-parent commit and the untracked tree is **parent 3**. An
  entire marketing website (23 files: home, pricing, contact, 3 product pages,
  all 5 legal pages) existed ONLY in `stash@{0}` — not on disk, not on any
  branch, not in any commit — and read as empty. **Always
  `git show --stat <stash>^3` before dropping.** Rescued to
  `rescue/marketing-website`, unreviewed and deliberately unmerged.
- ⛔ **The worker's direct-FCM sender was DEAD CODE for 6 days.** Shipped
  2026-07-31, never sent one push: the container had no credential mount and no
  `FCM_SERVICE_ACCOUNT_PATH`, so `isFcmDirectConfigured()` failed closed and
  100% of call rings/wakes/cancels rode the slow Expo relay — *including*
  devices holding a native FCM token. Fixed + deployed; the worker now logs
  `FCM_DIRECT_ARMED` at boot. **Config, not code, was the bug** — so the guard
  is `apps/worker/src/fcmDirectWiring.test.ts`, which reads compose and failed
  against the pre-fix file. Never claim a push channel is live from code alone.
- ⛔ **`docker exec` runs as root no matter the container's runtime user** —
  reading a `-rw------- root` credential that way proves nothing. Check
  `docker inspect -f '{{.Config.User}}'` too. And the worker needs **~90 s**
  (`prisma generate`) before app logs appear; an absent boot line right after a
  deploy is not yet a failure.
- **Answering a call had `MAX_ATTEMPTS = 3` on paper and 1 in reality** — the
  per-attempt timer was the whole remaining deadline. That is the Create A Box
  ext 102 voicemail drop: answered in ~160 ms, no ACK, sat 16.1 s past the 15 s
  ring timer. Per-attempt cap is now 4 s (chosen against the PBX ring window,
  not SIP), and `answer_unacked` is its own **recoverable** verdict —
  `session_not_found_timeout` was a lie that misled two investigations.
  ⛔ Committed only; **ships with a mobile build, which needs Izzy's word.**
- ⛔ **Committing while another agent is live in the same tree**: never
  `checkout`/`stash`/switch branches. Build it with a temp index
  (`GIT_INDEX_FILE` + `read-tree` + `commit-tree` + `git branch`) — recipe in
  handoff §4. Stage explicit paths, never `git add -A`.
- ⛔ **Windows: `git worktree remove` fails "Filename too long"** on
  node_modules. Use `robocopy <empty> <target> /MIR` then delete; emptied dirs
  stay handle-locked for minutes and delete cleanly on retry — don't kill
  processes over it. All 6 worktrees + 8 merged branches cleared (~8 GB).
- ⛔ **Kept on purpose: `claude/silly-zhukovsky-9bd516`** (mobile perf). It adds
  `react-native-svg`, a NATIVE dep, and its lockfile predates the Expo SDK
  51→54 upgrade — pinning RN 0.74/React 18 resolutions that no longer exist.
  Merging that lockfile is the exact break `0e5207d7` fixed. Needs a re-resolve
  **and** a native build. Six May/June stashes also kept, pending Izzy's call.
