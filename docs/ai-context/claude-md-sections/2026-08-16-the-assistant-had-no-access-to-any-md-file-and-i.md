# ⛔ AGENT HANDOFF — the assistant had NO access to any MD file, and its knowledge base was dead code (2026-08-16, FIXED same day by the section above) — READ FIRST before saying the assistant "knows" something we wrote down, or before answering "does the agent have the docs?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


**Read-only audit — no code change, no deploy.** Memory:
[[agent-knowledge-docs-per-tenant]].

- ⛔ **THE RULE: "the MD files exist" and "the agent has the MD files" are two
  different questions, and they answer opposite ways.** The docs side is
  healthy — **99 files in `docs/ai-context`, all tracked in git, every
  `docs/ai-context/…` path referenced in this file resolves to a real file,
  memory index 128/128 with no orphans.** That corpus is for **Claude sessions**.
  **The product assistant sees none of it.**
- **What the assistant actually gets each turn** (`apps/agent/src/conversation/engine.ts`
  ~line 450): the hardcoded `SYSTEM_PROMPT` (:21) + identity block + the
  viewing-page NAME + active trainer lessons + the last 40 messages + 13 tool
  specs. **No `.md` is read from disk anywhere in `apps/agent`** — the only MD
  paths in that tree are code comments citing spec docs.
- ⛔ **The knowledge base is dead three ways over.** `KnowledgeBase`
  (`knowledge/kb.ts`, table `AgentKbArticle`) is instantiated only inside the
  owner-only route `/agent/kb/retrieve` (`server.ts:494`); that route has **zero
  callers in the repo** (no portal UI); `draftFromResolution` is called by
  nothing; and the conversation engine never consults it. Live prod
  2026-08-16: **0 articles, 0 approved, 0 `AgentMemory` rows** — against **98
  conversations / 1,930 messages, last one 2026-08-15**. Same shape as the
  trainer bug: built, wired to nothing, empty for its whole life. ✅ Trainer
  lessons now read **1**, so that fix did land.
- ⚠️ **Prompt/capability drift, spotted in passing:** `SYSTEM_PROMPT` still
  tells the model "EVERYTHING ELSE (other changes, diagnostics): you cannot do
  it yet" while the engine now hands it 13 tools including
  `prepare_add_extension`, `prepare_enable_sms`, `prepare_add_phone_number` and
  `voicemails`. The prompt text is NOT amended when tools are present. Not
  fixed here.
- **Giving it document knowledge is unbuilt work**, not a toggle: ingest +
  retrieval + injection into `msgs`. ⛔ Anything customer-facing must be
  tenant-scoped and approval-gated — these handoffs are full of other tenants'
  names, credentials paths and internal failures.
- **Doc-rule gap, same audit:** the 2026-08-13 work landed **memory entries but
  no CLAUDE.md section** for linked-SIP visibility (`4ca72f44`), the IVR
  forward-save fix (`3f323182`) and the chat voice-note fixes
  (`e2b4699b` / `f0911881`). The recording-player work did get one.
