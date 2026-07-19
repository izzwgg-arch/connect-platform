# Connect AI Agent — Capability Manifest v0.1 (DRAFT — nothing certified yet)

_Status legend: every capability ships as **PLANNED** → **BUILT** → **CERTIFIED** (sim + live-staging tests green, per PLAN.md §13a) → only then **LIVE**. The agent's tool registry is generated from this manifest; uncertified = the agent cannot offer or attempt it. This file is the human-readable twin of the machine manifest and is regenerated on every certification run. Izzy signs off before anything goes LIVE._

## 1. Conversation (all channels)

| Capability | Scope | Status |
|---|---|---|
| Text chat, English + Yiddish (auto-detect) | client + owner | PLANNED |
| Voice notes in/out (Whisper EN, Everett.ai YI, TTS replies) | client + owner | PLANNED |
| Live hands-free voice mode in chat (streaming, barge-in) | client + owner | PLANNED |
| New chat per issue; auto-close (resolution / 12h idle) | all | PLANNED |
| Client history view (per-tenant toggle, owner-controlled) | client | PLANNED |
| Clarifying questions instead of guessing (never guess-execute) | all | PLANNED |
| Escalate to human team with full context (email; SMS later) | all | PLANNED |

## 2. Read & diagnose (no approval needed; always logged; own tenant only for clients)

| Capability | Status |
|---|---|
| Extension registration status + qualify/latency | PLANNED |
| Device reachability, transport/NAT info | PLANNED |
| Active-call presence check for an extension | PLANNED |
| CDR / call-history lookup (from Connect DB) | PLANNED |
| Voicemail box status; forwarding/DND/greeting state | PLANNED |
| IVR / inbound-route / time-condition current config (read) | PLANNED |
| Trunk status (read) | PLANNED |
| Recording lookup + transcript retrieval | PLANNED |
| Full structured diagnosis (ranked root causes + report to team + plain-language client version) | PLANNED |
| loopcom platform health snapshot | PLANNED |

## 3. Actions — PBX changes (client requests → human approval; owner requests → owner's word is the approval; pre-flight + audit + email always)

| # | Action | Limits (customer defaults; per-tenant policy can tighten/open) | Status |
|---|---|---|---|
| A1 | Temporary call forwarding (auto-revert) | own tenant; max 24h default | PLANNED |
| A2 | Forward set/clear (uncond/busy/no-answer) | policy-gated | PLANNED |
| A3 | IVR switch on inbound route (auto-revert) | blocked for customers by default | PLANNED |
| A4 | Time-condition override (auto-revert) | blocked for customers by default | PLANNED |
| A5 | Voicemail PIN reset | ask-owner by default | PLANNED |
| A6 | Temp voicemail greeting on/off (auto-revert) | policy-gated | PLANNED |
| A7 | DND set/clear (auto-revert) | allowed by default, max 8h | PLANNED |
| A8 | Ring-group member add/remove (temporary) | blocked for customers by default | PLANNED |
| A9 | Queue agent pause/unpause | policy-gated | PLANNED |
| A10 | Phone reprovision / SIP re-register kick | policy-gated | PLANNED |
| A11 | Caller blacklist (tenant-level, optional expiry) | policy-gated | PLANNED |
| A12 | IVR prompt audio update (Voice Studio render, snapshot rollback) | owner only | PLANNED |

## 4. AI Receptionist — in-call actions on the caller's own live call (per-tenant config; no per-call approval; fully logged)

| Capability | Status |
|---|---|
| Natural conversation EN/YI, tenant persona + cloned voice | PLANNED |
| Answer tenant FAQs from knowledge pack | PLANNED |
| Take message → transcript emailed/routed | PLANNED |
| Presence check ("is Moshe available?") | PLANNED |
| Live transfer to extension/queue/cell, with announce | PLANNED |
| Book callback | PLANNED |
| DTMF fallback + guaranteed human escape hatch | PLANNED |

## 5. Owner-only (Izzy)

| Capability | Status |
|---|---|
| Full action catalog, owner-instruction-as-approval | PLANNED |
| Natural-language per-tenant policy editing (confirm-diff) | PLANNED |
| History-visibility toggle per tenant | PLANNED |
| Voice Studio: clone voices, generate/preview EN+YI prompts, deploy via A12 | PLANNED |
| Kill switch (halt all agent execution instantly) | PLANNED |
| Certified-capability reports + weekly self-review proposals | PLANNED |

## 6. Watchman — monitoring (read-only, 24/7)

| Capability | Status |
|---|---|
| SIP brute-force / toll-fraud / anomaly detection + alerting ladder (digest / 15-min email / instant email+SMS) | PLANNED |
| Platform + PBX-reachability + trunk + cert + backup + disk health checks | PLANNED |
| Incident analysis reports (Claude) — detection and alert only; no auto-remediation in v1 | PLANNED |

## 7. Transcription & knowledge

| Capability | Status |
|---|---|
| Call-recording transcription (EN Whisper; YI Everett.ai), searchable, tenant-isolated | PLANNED |
| KB built from resolved tickets (team-approved), RAG retrieval | PLANNED |
| Per-tenant memory; feedback loop; weekly self-review | PLANNED |

## 8. Explicitly NOT capable — by design, in any mode

- Anything touching **payments or pension** systems.
- **PBX operations outside the certified catalog** — no raw PBX API, no shell, no config writes beyond A1–A12, no service restarts/reloads, nothing with blast radius beyond one named object.
- Deployments outside the deploy queue; any code/infra change on the servers.
- Executing a client PBX change **without human approval**, or any action for a tenant other than the requester's.
- Auto-remediation of security incidents (v1: detect + alert only).
- Fixing physical phones, client-side LAN/ISP/router issues, or upstream carrier/DID problems — it diagnoses these and hands the team a full report.
- Disclosing one tenant's data to another, or acting on unverified identity.

---

**Certification protocol** (PLAN.md §13a): full lifecycle + failure-injection + policy-matrix + language-matrix + adversarial suites in PBX simulation mode, then live-staging dummy-extension runs off-hours under the LIVE PBX PROTOCOL. A capability that fails or regresses is auto-suspended (agent stops offering it) until green again. Izzy receives the certified manifest + test report and signs off before first client exposure.
