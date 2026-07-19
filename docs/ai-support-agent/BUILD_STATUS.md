# Connect AI Agent — Build Status

_Last updated: 2026-07-19. Branch: `feat/ai-agent`. Author: Claude (Cowork)._

Live snapshot of what's built, deployed, and verified. The agent service runs as
`app-agent-1` on loopcom next to api/portal/worker. It boots **disabled**
(`AGENT_ENABLED` unset → kill switch engaged) and exposes only certified
capabilities (currently 17 of 43).

## Done, deployed, and verified live

| Area | Status | Notes |
|---|---|---|
| Agent service + kill switch + manifest gate | ✅ live | boots disabled; executable = certified/live only |
| Prisma tables (11 Agent* models + Ownership Ledger) | ✅ migrated | additive migrations via deploy path |
| Model router (OpenAI + Anthropic, failover, metering) | ✅ live | degrades cleanly w/o keys |
| Audit log (hashed JSONL + DB dual sink) + Notifier (email) | ✅ live | email queues to audit until SMTP creds set |
| Conversation engine (sessions, new-chat-per-issue, history gating, EN/YI) | ✅ live | verified in real portal browser |
| Portal `/support-chat` page + nginx `/agent-api/` + JWT auth | ✅ live | owner=SUPER_ADMIN; alg/expiry hardened |
| Read tools (extension status, CDR) — **zero PBX contact** | ✅ certified | from Connect DB mirrors |
| Diagnostics engine (ranked root causes + team report) | ✅ certified | ran live on a real extension |
| Chat triage (intent → diagnosis / drafted action) | ✅ live | heuristic EN/YI; LLM seam ready |
| Action + approval lifecycle (state machine, signed tokens, scheduler) | ✅ live | DB-backed auto-revert survives restarts |
| PBX Scoped Executor + Ownership Ledger (additive-only) | ✅ certified (SIM) | zero real PBX objects; liveEnabled=false |
| PBX provisioning P1–P14 (tenant/ext/IVR/routes/…) | ✅ certified (SIM) | 24-case cert suite green in-container |
| Certification harness (gates capability promotion) | ✅ live | runs inside the container, exits 0 |
| Watchman security + health monitor (read-only) | ✅ live | ran live against real CDRs |
| Owner admin APIs + `/agent-approvals` portal page | ✅ live | owner-JWT gated |
| Transcription pipeline scaffold (Whisper/Everett) | ✅ live | guarded until keys + audio path |
| Email channel (identity → engine → reply) | ✅ live | verified with a real user |
| Policy admin API + `/agent-permissions` page | ✅ live | versioned + diff-audited |
| SMS/WhatsApp channel (Twilio) | ✅ live | transport guarded until Twilio creds |
| Voice Studio scaffold (library + render) | ✅ live | render guarded until ElevenLabs key |
| Knowledge base + retrieval + approve | ✅ live | approved-only surfacing; pgvector-ready |

Test count: **90 unit + 24 certification cases, all green.** Every deploy verified
api/portal/agent 200 and **PBX never contacted**. Portal pages live: `/support-chat`,
`/agent-approvals`, `/agent-permissions`.

## Blocked on Izzy (not code — inputs)

1. **OpenAI + Anthropic API keys** → real AI replies (EN/YI) instead of fallback; drop into `/opt/connectcomms/env/.env.platform`, restart agent.
2. **SMTP creds** (agent mailbox) → live email trail for actions/approvals/escalations.
3. **Enable the agent for customers** → set `AGENT_ENABLED=1` when ready to go live in the portal.
4. **⏳ PW-2 live-PBX window** → the first real PBX write (create a throwaway test tenant, verify, delete, confirm an existing tenant byte-identical) — to be scheduled last, once everything else is done. Per owner: all real live-PBX tests run at the very end.
5. Later inputs: Twilio (SMS/WhatsApp), Everett.ai (Yiddish STT), ElevenLabs (Voice Studio), support DID (phone agent).

## Remaining build work (no live PBX needed)

- LLM-based intent extraction + conversation once keys land (seam already in place).
- Voice mode in chat (Phase 5.5), TTS, Voice Studio (Phase 5).
- Email + WhatsApp/SMS channels (Phase 5).
- Live phone agent + Conversational IVR (Phase 6).
- Knowledge base + learning loop (Phase 4 remainder).
- Portal Permissions (policy editor) + Voice Studio + Watchman dashboard pages.

## The safety posture, unchanged

- PBX is read-only in production. The only write path is the Scoped Executor, which
  is additive-only, ownership-ledger-scoped, and every capability has
  `liveEnabled: false`. No real PBX write has occurred or can occur until PW-2 +
  explicit owner enablement.
- Nothing bypasses: deploy queue path, PBX read-only default, payments/pension prohibition.
