# ⛔⛔ AGENT HANDOFF — reply `FIX <code>` to an escalation text and the fix HAPPENS (2026-08-16) — READ FIRST before touching escalations, the confirmation gates, or anything that could let a message cause a change

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FIX_BY_TEXT_2026-08-16.md`**
(`242d1a40` on `feat/ivr-migration-takeover`). Supersedes the 2026-08-12 note
that reply-approval "was deliberately NOT built".

- ⛔ **THE RULE: a text may only ever say YES to something already written
  down.** The SMS path NEVER composes an action out of prose. It can only spend
  a **DRAFT `AgentAction`** that the ordinary `prepare_*` tools created during
  the chat — params already hashed, capability re-authorising itself at
  execution time. `findPreparedFix` links one only when it is from the SAME
  conversation, same tenant, still DRAFT, recent, and **the only candidate**;
  two drafts means the owner decides on screen.
- ⛔ **The password is not skipped — it is REPLACED.** `applyConfirmedAction`
  now takes a `credential` union (`password` | `one_time_code`), so both
  channels run the SAME role gate, tenant scoping, params hash, capability
  authorisation, atomic claim and audit. **Never add a second apply path** —
  that is how the two would drift.
- ⛔ **Four checks before anything runs** (`applyFixByCode`): sender is in
  `AGENT_ESCALATION_SMS_TO`; the code matches **by hash** (it is never stored —
  the SMS is the only place it exists in the clear); unexpired + unclaimed; and
  the claim is atomic (`updateMany … fixCodeUsedAt: null`), so a second text
  updates 0 rows.
- ⛔ **"ok" is NOT an approval.** The parser demands the word AND a 6-digit
  code; `ok`, `yes`, `do it`, `approved`, a bare number and "can you fix this"
  are all refused. Those are what people type by reflex into a thread that also
  carries ordinary conversation.
- ⛔ **A refusal or a failure leaves the code SPENT** — a re-usable code turns a
  rate limit into an SMS retry loop, and re-running half-done external work is
  worse than not finishing it. ⛔ **An unknown sender is told NOTHING and the
  code is not burned** (else a stranger both probes and destroys).
- ⛔ **The code TTL and the draft's approvable age are ONE number**
  (`apps/api/src/agentFixPolicy.ts`, 24 h). The on-screen draft TTL is 30 min;
  a code outliving its draft would answer "expired" exactly when the owner
  replied in the morning. `maxAgeMs` is passed ONLY by this path.
- ⛔ **The escalation text MUST name the company AND the person** (Izzy,
  2026-08-16, after a real text said "User: Unknown user"). Fixed `91f47e34`:
  the user id is looked for in the turn context **and then on the CONVERSATION
  row**, and `resolveEscalationUserName()` can never return "Unknown user" — a
  genuinely signed-out chat now reads **"not signed in (chat widget)"**, which
  is a fact he can act on rather than a bug in us. An unidentified escalation
  is audited (`escalation.user_unidentified`) so it is countable.
  ✅ **97 of 98 live conversations DO carry a user id** — the one that does not
  is the internal-secret test path, which is exactly the conversation that
  produced that text. Real portal chats were never affected.
- ⛔ **"Reply OK here to approve" was REMOVED from the escalation SMS.** It
  became false the moment approval moved to the one-time FIX code — the parser
  deliberately ignores "ok", so the text was teaching a gesture that silently
  does nothing.
- **Replies arrive** as `ConnectChatMessage` rows on the admin thread for
  (845) 557-7768 via the worker's VoIP.ms poll (~2.5 min); a 60 s api sweep
  reads only that number's threads from allow-listed senders.
- **One SUPER_ADMIN exists** (izzywgg@gmail.com), so the approver resolves with
  no config. With more than one and no `AGENT_FIX_APPROVER_EMAIL`, it REFUSES
  rather than pick — the audit trail would otherwise name the wrong person.
- ✅ **PROVEN ARMED in the live process, not inferred:**
  `docker logs app-api-1 | grep AGENT_FIX_BY_TEXT_ARMED` lists the four
  executable capabilities (`grant_permission`, `add_extension`, `enable_sms`,
  `add_phone_number`). ⛔ **Check this after any api deploy** — if the deps
  wiring were missed, every texted approval would answer *"not wired up on this
  server"*, a reply the owner still RECEIVES, so the feature would look alive
  while fixing nothing.
- ✅ **Gates proven against production** (probe pointed a real escalation at a
  non-existent action, so no change was possible): a stranger with the right
  code got `unknown_code`, **no reply, and did NOT burn the code**; a wrong code
  got `unknown_code`; the owner's correct code reached execution and was
  refused; the replay answered `already_used`; `fixApprovedFrom` recorded the
  phone. Probe row deleted.
- ⏳ **NOT PROVEN: no code has ever been texted back by a human**, and no real
  fix has been carried out this way. 13 gate tests + 10 parser tests, migration
  applied, api + agent deployed. Acceptance test in §4 of the handoff.
