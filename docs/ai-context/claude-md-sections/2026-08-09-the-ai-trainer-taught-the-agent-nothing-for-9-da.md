# ⛔ AGENT HANDOFF — the AI trainer taught the agent NOTHING for 9 days (2026-08-09) — READ FIRST for apps/agent triage/intent, trainer lessons, "the agent did X when I only asked ABOUT X", or before believing any agent feature is live

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TRAINER_AUDIT_2026-08-09.md`**
(fix `a3fcca41` — ✅ **DEPLOYED**: `app-agent-1` rebuilt 2026-08-12 04:58 and
container-verified. The agent remains a manual rebuild, never in the deploy queue.)

- ⛔ **After 23 conversations and 824 messages (2026-07-26 → 08-07),
  `AgentTrainerLesson` holds ZERO rows** and the `trainer.*` audit trail is
  empty. Config was never the problem — `AGENT_TRAINER_USER_IDS` is set and the
  running container sees it. **Two bugs stacked:** the trigger phrases demanded
  a that/this/it pronoun nobody types, AND the DND intent bug ate the one real
  correction. Ezra typed `Remember "Status" has priority over DND` and it
  **fired a live DND write instead of saving a lesson.**
- ⛔ **A status QUESTION was performing a WRITE.** DND had no status detection
  at all, so any message containing "dnd" fell through to `enableHint:"yes"` —
  `DND status?`, `check dnd status`, even `DND status, do not disable or enable,
  just check status` all switched DND **on**, for three days, while the trainer
  kept saying "I asked about status not enable". Treat every new read-shaped
  intent as read-only by default; a customer asking "is my DND on?" must never
  have their calls silently blocked.
- ✅ **THE DND FIX IS NOW LIVE — verified in the running container 2026-08-12.**
  `app-agent-1` was rebuilt **08-12 04:58** and carries it:
  `isDndStatusQuery()` is defined at `apps/agent/src/triage/intent.ts:141` and
  wired into the classifier at :210, and `training/lessons.ts` is present. A
  status question no longer performs a DND write. (This entry read "COMMITTED
  AND NOT LIVE" until 08-12 — it was true from 08-09 to 08-11.)
  ⛔ The agent is still NOT in `deploy-direct.sh` (api|portal only), so it
  remains a manual
  `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml up -d --build agent`.
  ⛔ **Verify by grepping the RUNNING agent container, never by reading the
  commit and never from api/portal** — `a3fcca41` is an ancestor of both the
  live api and portal images while living in a container neither one builds.
- **Company hold music still cannot be put back.** Every "Secro" switch and
  every revert-to-regular-schedule fails `native_tenant_moh_sync_failed`
  (07-30, 07-31, 08-03 ×3, 08-05 ×2, 08-06 ×2). Setting a *specific* profile
  works fine, including timed changes with auto-revert. Undiagnosed.
- **Escalations go into a queue nobody watches.** With the memory feature dead,
  Ezra invented `pass along: …` to reach Izzy, then chased it on 08-06 and
  08-07 and never got a reply; an extension request from 08-04 was still
  unanswered on 08-07. Process gap, not code.
- ⛔ **Query traps that produced a wrong answer first:** filtering
  `agentConversation` on `clientUserId` alone returned **10 of the 23**
  conversations (and a six-day-stale "latest activity"); `AgentAction.tenantId`
  is NOT the Connect tenant cuid, so counting actions by it returns **0** —
  use `requestedBy`. Anchor date windows to `max(startedAt)` in the data, not
  to a `date` reading.
