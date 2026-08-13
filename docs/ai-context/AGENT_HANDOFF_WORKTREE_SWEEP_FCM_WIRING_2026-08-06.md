# AGENT HANDOFF — worktree sweep, the worker's dead push channel, and a website that lived in a stash (2026-08-06)

Branch: `feat/ivr-migration-takeover`. Commits `f9907e5d`, `8c15d5fa`,
`8b2c29f6`, `5272a8fc`, plus `ad3fb49d` on `rescue/marketing-website`.
All pushed. api + portal + worker **deployed and verified**.

The ask was housekeeping: clear every worktree, commit what was uncommitted,
deploy what was undeployed. Two of the three things found were real production
defects, and one was a near-miss data loss.

---

## 1. ⛔ The worker's fast call-wake channel was never plugged in — 6 days dead

**Commit `f9907e5d`. DEPLOYED (worker job `dc38834a`) and live-verified.**

On 2026-07-31 the worker gained a direct-FCM sender: call-critical pushes go
straight to Google instead of the Expo relay that Samsung deprioritizes. **It
never sent a single one.**

`apps/api` had both the credential mount and `FCM_SERVICE_ACCOUNT_PATH`. The
worker had **neither**, so `isFcmDirectConfigured()` returned false on every
push and 100% of `INCOMING_CALL` / `INCOMING_CALL_WAKE` / `INVITE_CANCELED` /
`INVITE_CLAIMED` fell back to the slow relay — **including for the devices
holding a native FCM token specifically to avoid it.**

Evidence before the fix:
```
docker exec app-worker-1 sh -c 'echo $FCM_SERVICE_ACCOUNT_PATH'   ->  (empty)
docker inspect app-worker-1 --format '{{range .Mounts}}...'       ->  chat-attachments only
```

Evidence after:
```
docker exec app-worker-1 sh -c 'echo $FCM_SERVICE_ACCOUNT_PATH'
  -> /host-inventory/opt/connectcomms/env/firebase-service-account.json
docker logs app-worker-1 | grep MOBILE_PUSH_AUDIT
  -> {"event":"MOBILE_PUSH_AUDIT","stage":"FCM_DIRECT_ARMED","source":"worker",...}
```

**Why it hid for six days:** `isFcmDirectConfigured()` fails closed and logs
nothing per push — by design. The fallback is silent and correct-looking.

**The three-part fix, because code alone could not catch this:**
1. `docker-compose.app.yml` — the env var plus a least-privilege
   `- /opt/connectcomms/env:/host-inventory/opt/connectcomms/env:ro` mount
   (only the one file is needed; api mounts all of `/opt/connectcomms` because
   its storage preflight walks the tree, the worker does not).
2. `apps/worker/src/main.ts` — a **boot assertion** logging `FCM_DIRECT_ARMED`
   or `FCM_DIRECT_UNCONFIGURED` (the latter via `console.error`). Say it once,
   loudly, instead of never.
3. `apps/worker/src/fcmDirectWiring.test.ts` — reads `docker-compose.app.yml`
   and asserts env present, path inside a declared mount, mount is `:ro`, and
   api + worker resolve the SAME file. **It failed against the pre-fix
   compose** — a real guard, not a tautology.

⛔ **Verification traps hit here:**
- `docker exec` runs as **root** regardless of the container's runtime user, so
  successfully `cat`-ing a `-rw------- root` credential that way proves
  nothing. Check `docker inspect -f '{{.Config.User}}'` too. (Worker is `[]` =
  root, same as api, so it genuinely can read it.)
- The worker takes **~90 s** to reach app code — `prisma generate` runs first
  and is the only thing in the log until then. An absent boot line right after
  deploy is not yet a failure.
- Any future "we shipped direct FCM" claim must be proven from
  `FCM_DIRECT_DELIVERED` lines with `"source":"worker"`, never from code.

---

## 2. Answering a call had 3 attempts on paper and 1 in reality

**Commit `8c15d5fa`. Committed and pushed; ⛔ ships only with a mobile build,
which was NOT done — that needs Izzy's word.**

`answerIncoming()` declares `MAX_ATTEMPTS = 3`, but the per-attempt timer was
the **entire remaining deadline**. Attempt #1 consumed all of it; #2 and #3
were unreachable. The retry budget was fiction.

That is the Create A Box ext 102 failure of 2026-08-05 (pbxCallId
`1785949038.169956`): the app found the INVITE on its **first** poll and sent
its 200 OK within ~160 ms of the tap. The socket was dead — silently, every
health flag still reading healthy — no ACK ever came, and the app sat for
**16.1 s**. The PBX's 15 s ring timer expired first and sent the caller to
voicemail, on a call that had already been answered.

New cap: `MOBILE_SIP_ANSWER_ATTEMPT_TIMEOUT_MS = 4_000`. Chosen against the
**PBX ring window, not against SIP**: a tenant ring timer is commonly 15 s, so
failing at ~4 s leaves ~10 s to re-offer the call on a fresh leg while the
caller is still hearing ringing. SIP's own 200 OK retransmission ladder
(T1 = 500 ms, doubling) has made ~3 attempts by then, so a live-but-slow
transport is not cut off early.

**Second half of the fix — the diagnosis was lying.** The failure was reported
as `session_not_found_timeout` when the session was found on the first poll
(`pollIterations = 1`) and answered (`answerAttempts = 1`, `sipAnswer.sent =
true`, JsSIP status 6 = `STATUS_WAITING_FOR_ACK`). **That label sent two
investigations down the wrong path.** `answer_unacked` is now its own verdict,
and it is explicitly **recoverable**: the PBX never saw a pickup, so it is
still ringing. See `getLastInboundAnswerFailure()` in `apps/mobile/src/sip/types.ts`.

Guard: `apps/mobile/src/sip/answerAttemptBudget.test.ts` (8 tests) —
`pnpm --filter @connect/mobile test:answer-budget`.

---

## 3. ⛔ An entire marketing website existed only inside a stash

**Rescued to `rescue/marketing-website` (`ad3fb49d`, pushed).**

`stash@{0}` ("pre-merge wip", 2026-08-05) carried 131 untracked files. The
`website/` tree was **not on disk, not on any branch, not in any commit**. A
routine `git stash drop` would have destroyed it permanently: home, pricing,
contact, about, ai-agents, the connect / connect-plus / field product pages,
and all five legal pages (terms, privacy, AUP, E911, SMS policy).

Rescued: 23 website files (tree verified byte-identical to the stash blob) plus
two handoff docs relocated into `docs/ai-context/`. Deliberately dropped:
`apps/desktop/release/` (a built 0.1.5 installer and the unpacked Electron
tree — ~340k of the 348k insertions) and three `_recents*.png` screenshots.

⛔ **It is unreviewed and intentionally unmerged** — a static marketing site is
not part of the api/portal/worker deploy. Someone must look at it before it
goes anywhere.

### The trap that nearly caused the loss

⛔ **`git stash show --stat` reports NOTHING for a stash whose content is
untracked.** Such a stash is a 3-parent commit: parent 1 = HEAD, parent 2 =
index, **parent 3 = the untracked files**. `git stash show` only looks at the
tracked diff, so a 131-file stash reads as empty.

**Always run `git show --stat <stash>^3` before dropping any stash.**

---

## 4. Committing while another agent is live in the same working tree

A parallel session edited this tree throughout (it committed `7f7ec541`
mid-sweep, then `c55ae840`, and held uncommitted CLAUDE.md edits the whole
time). Nothing of theirs was disturbed.

**Never `git checkout` / `git stash` / switch branches to land a rescue.**
Build the commit with a **temp index** — no working-tree touch at all:
```bash
export GIT_INDEX_FILE=.git/rescue-idx.tmp
git read-tree HEAD
git read-tree --prefix=website/ <subtree-sha>
git update-index --add --cacheinfo 100644,<blob-sha>,<path>
git commit-tree $(git write-tree) -p HEAD -F msg   # -> sha
git branch rescue/<name> <sha>
rm -f .git/rescue-idx.tmp
```
Also: stage explicit paths, never `git add -A`.

---

## 5. Worktree / branch state after the sweep

- **All 6 worktrees removed**; `.claude/worktrees/` no longer exists. Every one
  was clean and every branch fully merged — nothing lost. ~8 GB freed.
- **8 merged `claude/*` branches deleted**, including
  `claude/gallant-borg-c83b01`, which was **patch-id identical** to
  already-shipped `aafcc2f7` (`git patch-id --stable` on both to confirm a
  duplicate before force-deleting).
- **Merged in:** `3fc51bb0` (IVR migration shows the server's explanation, not
  a slug) and `73f990a0` + `ae037202` (toll-free & vanity numbers in the
  wizard). One real conflict, in `apps/portal/app/onboarding/[token]/page.tsx`
  — resolved as the **union**: keep HEAD's fuller porting details
  (serviceCity/State/Zip, isMobile) *and* add the branch's `numberKind`.

### ⛔ Windows worktree removal

`git worktree remove` fails **"Filename too long"** on `node_modules` trees.
Working recipe:
```powershell
robocopy <empty-dir> <target> /MIR   # empties it, MAX_PATH-safe
Remove-Item -LiteralPath <target> -Recurse -Force
```
The emptied directories may stay **handle-locked** for several minutes
(another agent's process). They delete cleanly on a later retry — do not kill
processes over it.

### ⛔ Kept deliberately: `claude/silly-zhukovsky-9bd516`

Mobile perf work from 2026-07-30 (voicemail waveform SVG, cold-start JS burst).
**Do not merge casually.** It adds `react-native-svg` — a **native** dependency
— and its `pnpm-lock.yaml` predates the Expo SDK 51→54 upgrade, pinning
`react-native@0.74.5` / `react@18.2.0` resolutions that no longer exist in this
tree. Merging that lockfile is precisely the failure that made every clean EAS
checkout unbuildable (fixed once already in `0e5207d7`). It needs a fresh
`pnpm install` re-resolve **and** a native build before it can ship.

**Six stashes from May/June are kept** (deploy scripts, CRM campaign UI, iOS
VoIP push). Old, on dead branches, but not verifiably redundant — left for
Izzy's decision rather than dropped.

---

## 6. Deploy notes

- Deployed: **api `7f7ec541`**, **portal `7f7ec541`**, **worker** (verified by
  the `FCM_DIRECT_ARMED` boot line — the worker image carries no
  `image.revision` label, so the label is empty and that is normal).
- `apps/agent` was **not** touched: a parallel session owned it, and the deploy
  queue has no agent service anyway (agent is always a manual compose rebuild).
- The queue exposes `POST /ops/deploy/enqueue` with
  `{service, branch, commitHash, requestedBy}` and a `Bearer` token from
  `DEPLOY_QUEUE_TOKEN` in `/opt/connectcomms/env/.env.platform`. Job detail at
  `/ops/deploy/jobs/:id`; `/ops/deploy/status` reports counts only, **not** the
  queued list — to learn what actually shipped, read the container revisions.
- `scripts/deploy-worker.sh` rebuilds and recreates from the repo's compose
  file, so a compose change (env/mount) lands on the recreate. Terminal status
  is the string `success`.
- Wait for `runningCount:0` **and** `queuedCount:0` before enqueuing; never
  `--skip-queue-check`.

## 7. Test state at handoff

Green: apps/api **2111 pass / 0 fail** (5 skipped), packages/shared **326/326**,
worker wiring **4/4**, mobile answer-budget **8/8**. Portal and mobile
typecheck clean.

⛔ Pre-existing and unrelated: `apps/worker` typecheck emits `TS2307` for
`@connect/shared/*` subpath imports (a `moduleResolution` setting issue,
present in `901dcb80` before any of this work) and `packages/db` test files
report implicit-any. The Docker build resolves these fine. Do not chase them
as a regression from this session.

---

## 8. Addendum (2026-08-12) — the docs themselves had the same disease

The theme of this handoff was "work that looks safe but exists nowhere":
uncommitted fixes, a website living only in a stash. It turned out the
documentation was a third case. `.gitignore` had `docs/` wholesale (for the
1.2 GB `docs/pbx-brain/` PBX snapshot that bloated EAS uploads), so **41 of 91
files under `docs/ai-context/` were never in git at all** — including five
handoffs CLAUDE.md names as "READ FIRST", and including THIS FILE's neighbors.
Every tracked doc had been individually force-added.

Fixed in `2bf61c03`: only `docs/pbx-brain/` is ignored now (EAS stays
protected by `.easignore`, which still excludes all of `docs/`), all 199 real
docs are tracked, `docs/pbx/*.sh`+`*.conf` are pinned LF in `.gitattributes`
for the PBX-scp path, and a two-pass safety sweep (secrets, line endings) of
the committed tree came back clean — details in the CLAUDE.md section
"`docs/` is IN GIT now".
