# PLAN — Connect as a self-improving system (2026-08-06)

**Owner's ask:** put a real agent *inside* Connect — the same kind of agent Izzy
talks to in Claude Code — that reads the repo's own MD files, diagnoses live
problems, proposes and applies fixes behind an approval gate, and gets better
per customer the longer it runs. Starting with audio: after six months the
system should know how each person's audio works best and adapt to it. Izzy
stays in the loop on everything.

This plan is written against what is **actually in the repo today** (verified
2026-08-06), not against assumptions.

---

## 0. The honest inventory — what already exists

This turned out to be much further along than a first read suggests. Verified:

### Measurement (the "always learning" data layer) — LIVE

| Piece | Where | State |
|---|---|---|
| Per-call quality report at hangup — RTT, jitter, receive loss, **send-side (uplink) loss** | `apps/mobile/src/context/SipContext.tsx`, `apps/portal/hooks/useSipPhone.ts` → `VoiceDiagEvent` type `CALL_QUALITY_REPORT` | Live, mobile **and** web |
| Mid-call quality ping (live snapshot, not just at hangup) | `client.onCallQualityPing` in `SipContext.tsx` | Live |
| Hourly roll-up into tuning-shaped buckets | `apps/worker/src/callQualityAggregator.ts`, scheduled in `apps/worker/src/main.ts` (hourly, 3h re-window, idempotent upserts) | Live |
| The bucket table itself | `CallQualityHourly` — keyed `hourStart · tenantId · userId · direction · audioCodec · networkType · usedRelay`; carries `calls`, `poorCalls`, avg/max RTT, avg jitter, avg/max loss, avg/max **tx** loss | Live |
| Quality-degradation alerting | aggregator writes `CALL_QUALITY_DEGRADED` audit incident at ≥3 calls / ≥2.0% sustained loss | Live |
| Full per-call timeline | `CallFlightSession` — event array, `warningFlags`, `answerDelayMs`, `sipConnectMs`, `pushToUiMs`, plus a cached `aiSummary` | Live |
| Call-path forensics | `PbxCallTrace` / `PbxCallEvent` / `PbxCallParticipant` / `PbxCallRouteStep`, `ConnectCdr`, `PbxEndpointRegistrationEvent` | Live |
| Connection-failure forensics | `packages/shared/src/webrtcBlackbox.ts` (SDP/ICE/DTLS — setup only, no quality) | Live |

**The bucket table's unique key is already the exact shape of a per-person audio
profile.** That is the single most important fact in this document. The
measurement problem Izzy was worried about is solved; the history is
accumulating now.

### Memory / per-customer knowledge — TABLES EXIST

| Piece | Where | State |
|---|---|---|
| Per-user rolling dossier (markdown, optimistic concurrency via `rev`) | `AgentUserDossier`, written by `apps/agent/src/conversation/dossier.ts` | Live |
| Tenant key/value memory | `AgentMemory` | Live (currently used by archive progress + voice studio) |
| Knowledge base articles | `AgentKbArticle`, `apps/agent/src/knowledge/kb.ts`, `/agent/kb/retrieve` | Live |
| Human-reviewed lessons + revoke | `AgentTrainerLesson`, `/agent/admin/trainer/lessons`, `/agent/admin/trainer/lessons/revoke` | Live (Ezra's trainer mode) |
| Diagnostics + incidents | `AgentDiagReport`, `AgentIncident` | Live |
| Action framework + audit trail | `AgentAction`, `AgentPolicy`, `AgentAuditLog` | Live |

### Model access — LIVE

- `@anthropic-ai/sdk` is a declared dependency of `apps/agent`.
- `apps/agent/src/llm/router.ts` already routes across Anthropic and OpenAI, and
  already names `claude-opus-4-8` and `claude-sonnet-5`.
- The key lives in `AgentSecret` under the same `CREDENTIALS_MASTER_KEY` as the
  rest of the agent's credentials — **not** in env.

**Conclusion: "get a cloud agent and an API key inside Connect" is already
done.** What's missing is not the connection and not the data. It's three
specific things, below.

---

## 0b. BUILT SINCE THIS PLAN WAS WRITTEN (same day, uncommitted)

Working tree only — not committed, not deployed, **never run against a real
provider API**. Tests use faked provider clients, so they prove the logic is
right, not that Anthropic/OpenAI accept these exact request shapes.

| Change | Where |
|---|---|
| Internal reasoning moved to **Opus 5** (thinking on by default) | `llm/router.ts` |
| Customer chat moved to **OpenAI gpt-5**, Sonnet 5 as failover | `llm/router.ts` |
| Token ceilings raised: default 1024→16000, chat 800→4000, ping 16/200→4000, diag narrative 500→12000 | `llm/router.ts`, `conversation/engine.ts`, `server.ts`, `diag/engine.ts` |
| **Tool loop** for both providers — model calls tools, sees results, decides again (cap 8 rounds) | `llm/router.ts` → `completeWithTools` |
| **Tool registry** with tenant binding + role gating | `tools/toolRegistry.ts` (new) |
| Tools wired into **diagnostics** (internal role) and **customer chat** (role-gated) | `diag/engine.ts`, `conversation/engine.ts`, `server.ts` |
| Empty-completion now audited instead of silently becoming canned text | `conversation/engine.ts` |
| 25 new tests incl. red-team cross-tenant + role-escalation | `tools/toolRegistry.test.ts`, `llm/toolLoop.test.ts`, `conversation/engineTools.test.ts` |

⛔ **The security model changed.** Before this, the agent was safe because it was
powerless — code fetched tenant-scoped data and pasted it into the prompt. Now
the model can *ask*. Enforcement therefore lives in `tools/toolRegistry.ts`:
no tool schema declares a tenant, `executeTool` strips any tenant-ish key the
model invents, and the drop is audit-logged. **Any new tool must follow that
rule.** Role comes from the DB user record (`SUPER_ADMIN` ⇒ owner ⇒ internal
tools); if that ever becomes client-supplied it is a privilege-escalation path.

Still missing from the list below: Gap A (decision layer), Gap B (profile
table), Gap C (the agent still cannot read the repo or these MD files — that is
the Claude Agent SDK work in Phase 3; the tool loop reads *data*, not files),
Gap D (workspace), Gap E (coverage verification).

## 1. What is actually missing

### Gap A — the decision layer (the biggest one)

`callQualityAggregator.ts` documents its own intended consumer:

> *"the adaptive-audio layer (chooses e.g. `forceTurnRelay` per device by
> comparing relay vs direct buckets for the same user/network)"*

**That consumer does not exist.** The only `forceTurnRelay` in the codebase is a
static entry in `apps/mobile/src/config/featureFlags.ts` — a switch a human
flips, not a setting the system learns. So today: quality is measured, rolled
up, and alerted on — and then nothing reads the buckets to *change anything*.

The loop is open. Closing it is the core of this project.

### Gap B — no per-customer settings profile the call path reads

There is no table where "for this person, on this network, use these settings"
lives, and nothing in the call-setup path reads such a thing. Profiles exist for
other domains (`IvrRouteProfile`, `MohProfile`, `CrmTenantSettings`) but not for
call media.

### Gap C — the agent cannot read the codebase or the handoff docs

`apps/agent` is a **curated-tool agent**: it has `tools/readTools.ts`, plus
`pbx/`, `diag/`, `watchman/`, `triage/`, `policy/`, `guards/`. It answers
customers well. But it has no ability to read files, grep the repo, or run
commands — so every capability had to be hand-built, which is exactly the
"training every tiny step" Izzy wants to stop doing.

The repo's `CLAUDE.md` and the ~15 `docs/ai-context/AGENT_HANDOFF_*.md` files are
an enormous, already-written body of operational knowledge that **nothing in
production can currently read.**

### Gap D — no workspace for Izzy to talk to it

No page where Izzy has the conversation he has in Claude Code.

### Gap E — coverage is unverified

A code comment in `SipContext.tsx` references a period with *zero*
`platform=ANDROID` quality rows. iOS uploads only one native seed event per call
(per the flight-recorder handoff). **Before building on this data, measure what
percentage of calls actually produce a report, per platform.** Plan step 1.

---

## 2. Architecture — two loops, and why the split is non-negotiable

```
   FAST LOOP  (every call, milliseconds — NO AI)
   ┌──────────────────────────────────────────────┐
   │ call setup reads CallMediaProfile for this    │
   │ user+network → applies codec / relay / FEC    │
   └──────────────────────────────────────────────┘
                     ▲                    │
        writes the   │                    │ every call reports
        profile      │                    ▼ RTT/jitter/loss (EXISTS)
   ┌──────────────────────────────────────────────┐
   │ SLOW LOOP (hourly + nightly — the agent)     │
   │  aggregator → CallQualityHourly (EXISTS)     │
   │  tuner reads buckets, proposes a change      │
   │  Izzy approves → profile updated             │
   └──────────────────────────────────────────────┘
```

**The model is never in the call path.** If a live call has to wait on an API
response before it can connect, a slow or failed model call becomes a dropped
customer call. The agent's job is to decide *what the setting should be*,
offline, with time to think and with a human check. The call itself only reads a
value that was already written down.

This split is also what makes aggressive learning safe: a wrong lesson changes a
stored row you can inspect and revert — it cannot break telephony in real time.

---

## 3. The phases

Each phase is independently useful and independently shippable. Nothing later is
required for anything earlier to pay off.

### Phase 1 — Verify the data (small, do first)

- Measure `CALL_QUALITY_REPORT` coverage: rows per day, split by platform
  (Android / iOS / portal), as a share of `ConnectCdr` calls in the same window.
- Confirm `CallQualityHourly` is populating and inspect real buckets for a few
  known-problem users (Simon T5_101, Sender Weiss T7_102, Eli/Displaydex).
- Fix whatever reporting path is dark. **iOS is the likely gap.**

*Output: a one-page honest statement of what history we actually have.*
*Nothing else in this plan is trustworthy until this is done.*

### Phase 2 — Close the audio loop (the first real adaptation)

1. **`CallMediaProfile` table** — per `tenantId · userId · networkType`, holding
   the small set of settings the call path can honestly act on: prefer relay vs
   direct, FEC level, jitter-buffer hint, preferred codec. Plus `source`
   (`learned` / `manual`), `proposedBy`, `approvedBy`, `approvedAt`, and the
   evidence that justified it.
2. **Call path reads it** at setup — mobile and portal. Absent profile = today's
   exact behavior. This must be a pure no-op for every user without a profile.
3. **The tuner** — a worker cycle that compares buckets for the same
   user+network (relay vs direct, codec vs codec) and, where the difference is
   statistically real and the sample is big enough, writes a **proposed**
   profile row.
4. **Approval surface** — an admin page listing proposals: *"Sender Weiss,
   cellular, outbound: relay averages 1.2% loss vs 4.7% direct across 34 calls.
   Recommend forcing relay."* Approve / reject / snooze.
5. **Auto-revert guard** — if a profile's own buckets get *worse* after it takes
   effect, the tuner reverts it and says so. A learned change that made things
   worse must undo itself without waiting for a complaint.

*This is the whole vision, working, for one aspect.* Everything after it is the
same shape applied elsewhere.

### Phase 3 — The in-server agent (Claude Agent SDK)

Stand up a Claude Agent SDK process — Claude Code as a library — with the repo
checked out so it reads `CLAUDE.md` and every handoff doc natively.

- **Hosting: its own small box, not loopcom.** Loopcom carries live calls; an
  agent running builds and greps will fight it for CPU. The agent reaches
  loopcom read-only over the network.
- **Reads:** repo + MD files; read-only database user; container/deploy status;
  logs; the PBX read-only.
- **Writes: only through doors that already exist** — the deploy queue, the PBX
  route helper, the internal API routes, the wake-dial publisher. Never a raw
  shell on production. These paths are already tested and already fail safely.
- **Permission gate:** the Agent SDK's own hook mechanism decides per action:
  auto-run (read anything, diagnose, draft) vs stop-and-ask (anything that
  changes a customer's service).

*Output: Izzy asks "why didn't Simon's phone ring at 3pm" and gets a grounded
answer in seconds instead of an hour of a session's time.*

### Phase 4 — The workspace

A page in the portal where Izzy (and later staff) hold the conversation:
the agent's proposals, its diagnoses, its pending approvals, and a chat box.
This is the "IDE inside Connect" — but the valuable part was never the editor,
it's the conversation plus the approval queue.

### Phase 5 — Memory that compounds

Use what already exists rather than inventing a second system:

- **`AgentUserDossier`** — the per-person file. Already has optimistic
  concurrency, already written by `dossier.ts`. This becomes "everything we know
  about how this person's phone behaves."
- **`AgentTrainerLesson`** — the reviewable lesson store, already has a revoke
  path. Every lesson the agent writes for itself lands here for Izzy to keep,
  correct, or revoke.
- **`AgentKbArticle`** — generalized lessons that apply across customers.

Rule: **the agent writes lessons automatically; Izzy approves automatically-written
lessons.** An agent that writes its own knowledge unchecked will eventually
record something true-once as always-true and apply it confidently everywhere.
Half the handoff docs in this repo exist because a confident wrong conclusion
cost a session. The review queue is the cheap insurance.

### Phase 6 — Same shape, other aspects

Once Phase 2's pattern exists, repeat it where the data is already sitting there:

| Aspect | Data that already exists | What gets learned |
|---|---|---|
| Wake & ring reliability | `CallWakeEvent`, `PbxEndpointRegistrationEvent`, `CallFlightSession` | Per-device wake hold time; which devices need a longer ring timer; which are on filtered networks |
| Answer reliability | `CallFlightSession.warningFlags`, `answerDelayMs`, `pushToUiMs` | Which builds/devices lose answer taps; when to pre-warm SIP |
| Routing | `PbxCallRouteStep`, `ConnectCdr`, IVR events | Which menu keys callers actually press; where they hang up; dead options |
| Support | `AgentDiagReport`, `AgentIncident`, dossiers | Symptom → real cause, per customer; next report starts from the answer |

---

## 4. Guardrails (non-negotiable)

1. **No model call in the call path.** Ever. Phase 2's fast loop reads a row.
2. **The PBX stays read-only except through the helper.** The existing rule holds.
3. **Deploys only via the deploy queue.** The agent gets no special path.
4. **Every learned change is attributable and revertible** — who/what proposed
   it, on what evidence, who approved, and a one-click revert.
5. **Known audio landmines are hard constraints, not suggestions.** The agent
   reads them from the MD files and may not propose against them:
   - never force opus on inbound calls (proven to kill audio twice)
   - `packet_loss=5`, never 10 (10 muffles)
   - the TURN relay is in France, the PBX in St. Louis — +150ms on every relayed
     call, and no tuning fixes that. A US relay is a purchase decision, not a
     setting.
6. **Auto-approval is earned, not granted.** Everything starts behind approval.
   Individual low-risk knobs graduate to automatic once their track record
   justifies it.

---

## 5. Decisions needed from Izzy

1. **Where does the agent box live?** A small separate VPS (recommended), or a
   resource-capped container on loopcom (cheaper, riskier)?
2. **How much does Phase 2 get to touch on its own?** Recommendation: nothing at
   first — every profile change is approved by hand until the track record is
   there.
3. **Who else gets the workspace?** Izzy only at first, or Ezra too?
4. **Order:** the recommendation is Phase 1 → 2 → 3, because Phase 2 delivers the
   actual vision (a system that adapts per customer) and doesn't depend on the
   agent at all. Phase 3 is what makes *Izzy's* work faster. If the priority is
   Izzy's time rather than customer audio, swap 2 and 3.

---

## 6. What this is not

- Not a rewrite. Every phase adds to what's there.
- Not a second agent. `apps/agent` keeps doing customer chat; the Agent SDK
  process is an operations agent, and they share the same memory tables.
- Not automatic in the "nobody watches it" sense. It is automatic in the
  "it proposes and improves continuously, and Izzy says yes" sense — which is
  what was actually asked for.

---

## 7. Permission-grant-by-chat — SPEC for the two remaining halves

The agent half is built and pushed (`apps/agent/src/tools/permissionGrant.ts`,
11 tests). It writes a DRAFT `AgentAction` and grants nothing. **Not deployed**
— without the two halves below an owner is told "confirm with your password"
and has nowhere to do it.

### How permissions actually work (traced 2026-08-06 — do not re-derive)

- A permission is a `PortalPermissionKey` string living in
  `CustomRole.permissions` (a JSON array), scoped `@@unique([tenantId, name])`.
- A user receives them via a `UserCustomRole` assignment.
- Resolver: `hasEffectivePortalPermission` (via `userHasActionPermission`
  in `apps/api/src/permissionGates.ts`).
- ⛔ **The authority rule already exists** — `getGrantablePermissions(actorRole,
  actorUserId, actorTenantId)` in `apps/api/src/customRoleRoutes.ts`:
  SUPER_ADMIN gets everything; TENANT_ADMIN gets *their own effective
  permissions minus `PROTECTED_PLATFORM_ADMIN_PERMISSIONS`*. **Reuse it. Do not
  write a second authority rule.**
- Role gate: `isTenantAdminOrAbove(actor.role)`. Actor: `getUser(req)`.
- Password check: `bcrypt.compare(password, user.passwordHash)` — the pattern
  already at `apps/api/src/server.ts:5541` (the login path). Reuse it.

### Half 1 — the API apply endpoint

Write it as its own module (`agentGrantRoutes.ts`) registered like
`registerCustomRoleRoutes`, NOT inline in the 20k-line server.ts.

`POST /admin/agent-grants/:actionId/apply` with `{ password }`, in this order —
each step is a hard stop:

1. `getUser(req)`; `isTenantAdminOrAbove(actor.role)` else 403.
2. Load the `AgentAction`. Require `capabilityId === "action.grant_permission"`,
   `status === "DRAFT"`, `approvalConsumedAt === null`, and
   `action.tenantId === actor.tenantId` (SUPER_ADMIN may cross only via the
   existing `resolveTargetTenantId` helper).
3. Recompute `permissionParamsHash(tenantId, targetUserId, permission)` from
   the STORED params and require it to equal `action.paramsHash`. This is what
   stops an approval for one grant applying a different one.
4. **Independently re-check authority**: the permission must be in
   `getGrantablePermissions(...)` for THIS actor. The agent's say-so is never
   sufficient — a prompt-injected agent must not be able to grant anything.
5. Re-check the deny-list (`NEVER_GRANTABLE_BY_CHAT`) server-side too.
6. Verify the password against **the actor's own** `passwordHash`. Rate-limit
   by actor id (reuse `checkBillingRateLimit`) and audit failures — this is a
   password oracle otherwise.
7. Apply: upsert a per-tenant `CustomRole` named `Assistant grants — <email>`,
   add the permission to its `permissions` array (idempotent), and ensure the
   `UserCustomRole` assignment exists. Keeps every chat-granted permission in
   one visible, revocable place instead of scattering them.
8. Mark `status = "EXECUTED"`, `approvedBy = actor.sub`, `executedAt = now()`,
   `approvalConsumedAt = now()` — single use, in the same transaction as (7).

### Half 2 — the portal dialog

Sees a prepared action (id + summary returned by the agent), shows the summary
verbatim and a password field, POSTs to the endpoint, reports the result back
into the chat. ⛔ The password goes to the API only — never to `/agent-api/*`.

### Stress cases that must be proven before this is called done

Replay a consumed approval · a second apply racing the first (both must not
grant twice) · tampered `params` vs stored `paramsHash` · an actor granting a
permission they don't hold · a TENANT_ADMIN reaching for a protected
platform-admin key · a cross-tenant `actionId` · wrong password (and repeated
wrong passwords → rate-limited) · a DRAFT whose target user was deleted or
moved tenant between prepare and apply.
