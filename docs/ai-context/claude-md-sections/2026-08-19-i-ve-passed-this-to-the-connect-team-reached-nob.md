# ⛔⛔ AGENT HANDOFF — "I've passed this to the Connect team" reached NOBODY for two weeks, and a hold-music question ate eight others (2026-08-19) — READ FIRST before touching the escalation path, before using the agent's `role === "owner"` for anything, before adding a clarifying question the agent can ask, or for "the customer says they asked the assistant and nobody got back to them"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_EZRA_100_QUESTIONS_2026-08-19.md`**
(`ce9f2318` on `feat/ivr-migration-takeover`. **agent container REBUILT and
verified.** No migration, no PBX write, no api/portal change, no env change, no
tenant row touched.) Memory: [[escalation-owner-mode-is-not-connect-staff]],
[[a-clarifying-question-must-be-escapable]].
Izzy, 2026-08-19: *"ezra on the training account yesterday, with the agent
logged, 100 questions … make sure the agent can execute all of them."*

- ⛔⛔ **THE HEADLINE, measured not inferred: in Ezra's 2026-08-18 session the
  assistant promised 48 times to pass a request to the Connect team and created
  ZERO escalations.** Platform-wide since 2026-08-06: **93 promises in
  admin-mode conversations, 0 rows.** Two independent faults, each alone enough:
  **(1) THE GATE — the word "owner" means two different things.**
  `EscalationService` suppressed on `ctx.role === "owner"`, whose comment is
  about the PLATFORM owner — but `mapUserRole` has promoted **TENANT_ADMIN →
  "owner"** since 2026-08-06 (a correct fix, so a customer's own admin gets
  admin mode). So the single likeliest person to ask for a change became the one
  person who could never reach anybody. ⛔ **`mapUserRole` answers "does this
  person get ADMIN MODE?"; `isPlatformStaff` (new, SUPER_ADMIN only) answers "is
  this person US?" — never use the first to decide the second.** It **fails
  TOWARD escalating**: an unknown or missing role is not staff, so the request
  reaches a person.
  **(2) THE PHRASING — the model says "the CONNECT team"** (43 of the 48) and
  the regex accepted only `our/the [human|support] team`, so **43 would have
  been missed even with the gate fixed**. The qualifier before "team" is open
  now. ⛔ **And widening it forced the other half: an OFFER IS NOT A PROMISE** —
  *"I **can** pass that to the Connect team, which key should callers press?"* and
  *"**once I have** those details…"* must NOT text Izzy a half-formed request.
  `isEscalationReply` judges **sentence by sentence** and rejects modals,
  conditions, "before passing", "must be" and "please provide"; a reply that
  promises in one sentence and qualifies in the next is still a promise.
  ✅ **Proven on the real 135-message corpus: 48/48 caught, 0 false positives in
  the other 87 replies.**
- ⛔⛔ **THE GATE HAD NO TEST COVERAGE AT ALL — that is exactly how it shipped.**
  `escalations.test.ts` covers the SMS builder and **never drove
  `considerTurn`**, so the suite stayed green through two weeks of silently
  dropped escalations. New `escalation/escalationGate.test.ts` drives the real
  service against a fake db and carries **three SOURCE guards on the wiring**,
  because both defects were in the CALLER. **All guards replayed against `HEAD`
  and proven non-vacuous**, including a direct proof that HEAD's regex misses
  "the Connect team".
- ⛔⛔ **A CLARIFYING QUESTION MUST BE ESCAPABLE — the hold-music trap swallowed
  EIGHT consecutive unrelated questions, across a conversation boundary.** While
  *"Which hold music would you like?"* is the last assistant message,
  `resumeMohClarification` treats anything scope-shaped as the answer — and the
  scope test matches the bare words **`extension`** and **`company`**, while
  `MOH_DEACTIVATE_RE` matches a bare **`remove`**. So "Can you remove the
  forwarding and restore my original setup?" read as "turn the hold music off",
  and **the reply is that same question, so the state re-armed itself every
  turn.** Fixed three ways: `MOH_NEW_REQUEST_RE` (a message that opens like a
  fresh request and never mentions hold music IS one), `MOH_OTHER_SUBJECT_RE`
  (the anaphoric status detector no longer grabs "what … **currently** …" about
  teams/IVR/voicemail/forwarding — ⛔ `extension` and `schedule` are deliberately
  NOT on that list, they are hold-music's own vocabulary), and a hard cap of
  **3 consecutive unanswered asks**. ⛔ **Any new clarify state in this
  orchestrator needs the same three properties.**
- ✅ **New read tool `my_requests`** — there was a way to CANCEL requests and no
  way to LIST them, so "any pending request?" was answered from the conversation
  dossier (it recited two-week-old requests). ⛔ `FAILED` reads as **"still being
  sent to the team"**, not "failed" — the dispatcher retries those.
- ⛔⛔ **WHAT THE AGENT CAN DO — and the correction that matters most: MOST OF
  WHAT EZRA ASKED FOR IS BUILT AND STRANDED, NOT MISSING.** An earlier pass of
  this section said business hours and holidays had "no door at all". **Wrong**,
  and it is this repo's most repeated mistake: searching for a ROUTE with the
  feature's name in it, finding none, and declaring it unbuilt. ⛔ **Read
  `apps/agent/src/pbx/ops/` and `modifyCatalog.ts` before calling any PBX
  change impossible.** **pbx.M5** (greeting recording), **pbx.M6** (timeout /
  invalid-key destination) and **pbx.M7** (**business hours, holidays, per-mode
  menus**) each have a full executor with `snapshot()`/`verify()`/`revert()`,
  are registered in `MODIFY_CATALOG`, and call an API door that is implemented
  and publishes to the PBX — `set_schedule` really upserts `IvrScheduleConfig`
  and validates every menu belongs to the tenant. **And the chat cannot reach any
  of them**: `orchestrator.ts` can only produce `pbx.M1/M2/M3/M4/M10/M11`, and
  `pbxCfgLlmExtract.ts` never emits their ops. **~35 of Ezra's 135 questions die
  in the understanding layer on top of executors that work.** ✅ **Executes today:**
  DND on/off/status (Q114/Q115 really ran), extension status, hold music,
  voicemail, call history, contacts LIST, where-a-number-routes + restore, queue
  status/members/MOH/announcements, IVR set/clear a key + welcome greeting,
  screenshots, the password-gated `prepare_*` tools. ⛔ **GENUINELY not built:**
  **creating the FIRST IVR menu** (the door has no create — the real hole, and why
  an empty account hears "no IVR menus yet"), submenus, generating a greeting from
  TEXT, ring-group create/membership (`POST /voice/teams` exists, nothing points
  at it), adding a contact, and reading the CONTENTS of the page the user is on.
- ⛔ **The session reads worse than it is, and re-testing needs a different
  tenant:** Ezra's account has **no IVR menu, no schedule, no holidays, no teams
  and one extension** — about 40 of the 135 questions are about objects that do
  not exist, so "Your phone system doesn't have any IVR menus yet" is *correct*.
  **Re-run the set on a tenant that has a menu before judging the IVR answers.**
- ⛔ **The LLM anchors on recent context** — Q78–Q81 (unanswered calls, Sales
  voicemail) were each answered about **holiday recordings**, the subject four
  messages earlier; the same question in a fresh conversation was answered
  correctly. Not a state machine bug, and NOT fixed here.
- ⛔⛔ **WHAT CHANGES FOR IZZY THE MOMENT THIS IS LIVE: tenant admins' requests
  start reaching your phone again** — that is the fix working. **9 ACTIVE
  TENANT_ADMIN accounts**; dedupe is one escalation per conversation per 30 min
  (so Ezra's 7 conversations ≈ 7–9 texts, not 48) and the 40-SMS/24 h ceiling
  still applies. **A trainer session now costs real texts — say so before the
  next 100 questions.**
- ✅✅ **THE DIAGNOSE → PROPOSE → APPROVE → WRITE LOOP: three of the four legs
  already existed, and the missing one shipped today (`95beef53`).** Izzy,
  2026-08-19: *"the assistant should be able to diagnose and come back to me with
  a full fix, and I should be able to give him approval to fix it and actually
  write to the server."* **(1) Diagnose** — ⛔ **the read-only investigation
  workspace was ALREADY DEPLOYED and nothing called it** (the section below said
  NOT DEPLOYED; it rode a later api deploy). Proven on production 2026-08-19: no
  secret → **403**; Connect Postgres → **200** (52 tenants); PBX MySQL → **200**
  (27 tenants); an `UPDATE` → **refused**. The agent-side tool now exists —
  **ONE** tool, `investigate`, because diagnosis is generic; `minRole:
  "internal"` (⛔ never customer — the door is deliberately NOT tenant-scoped),
  tenant bound from the verified context, and a guard refusal comes back as DATA
  so the model can adjust. **(2) Propose** — `EscalationService.research()`
  already drafts ISSUE/FINDINGS/PROPOSED FIX/APPROVAL and runs `role: "internal"`
  on the same tool list, so its reports can now be **measured rather than
  reasoned**; a source guard pins that it keeps receiving `chatTools`.
  **(3) Approve** — already built, password dialog + `FIX <code>` by text.
  **(4) Write** — real for M1/M2/M3/M4/M10/M11, **stranded for M5/M6/M7**, absent
  for creating a menu. ⛔ **So closing the loop is a WIRING job in the
  understanding layer, not a capability build.** The fork is Izzy's: **(A)** widen
  the extractor per capability (incremental, every executor already reverts) or
  **(B)** a general "run this plan" door — *"the real cost and the real risk"*,
  needing every admin route classified first. **A is the recommendation.**
- ⏳ **NOT PROVEN: no escalation has been created by a real tenant admin since
  the fix, and no text has arrived.** Proven by 26 new tests, the corpus replay,
  and the symbols grepped inside the running container — not by a phone ringing.
  **Acceptance test, 30 seconds: one message from a tenant-admin account that
  ends in "I've passed this to the Connect team", then check `AgentEscalation`
  for the row.** ⏳ Nobody has re-run the hold-music flow in a real chat either.
