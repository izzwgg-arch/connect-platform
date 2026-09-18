# A6 — Connect Agent Architecture Audit (read-only)

Scope: `apps/agent/**` (the Loopcom AI assistant / "Coworker" service), plus its callers
in `apps/portal` and its neighbor `apps/community-api`, for the purpose of designing how
a second product ("LoopCom Works", a separate field-service app on its own server) could
reuse this same assistant. No code was changed. All citations are `file:line`.

---

## 1. SERVICE SHAPE

- **Package**: `@connect/agent` (`apps/agent/package.json:1-25`). Framework: **Fastify 5**
  (`apps/agent/package.json:13`, instantiated `apps/agent/src/server.ts:110`
  `Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 })` — 20MB cap for mic audio).
  Runtime is `tsx` directly against TypeScript source, no build step
  (`apps/agent/package.json:6-8`, mirrored in `apps/agent/Dockerfile:2`).
- **Port**: `3920`, from `AGENT_PORT` env, default in `apps/agent/src/config.ts:64`
  (`port: Number(process.env.AGENT_PORT ?? 3920)`); `apps/agent/Dockerfile:29-31`
  (`ENV AGENT_PORT=3920`, `EXPOSE 3920`, healthcheck `curl 127.0.0.1:3920/health`);
  `docker-compose.agent.yml:22,26` (`AGENT_PORT: 3920`, published only to
  `127.0.0.1:3920:3920` — **not directly internet-reachable**, only via nginx and the
  docker network).
- **Env vars it reads** (names only, from `apps/agent/src/config.ts:57-90`):
  `AGENT_ENABLED`, `AGENT_KILL_SWITCH`, `AGENT_PORT`, `AGENT_HOST`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `AGENT_SMTP_HOST/PORT/USER/PASS/FROM`, `AGENT_OWNER_EMAIL`,
  `AGENT_TEAM_EMAILS`, `AGENT_AUDIT_DIR`, `EVERETT_API_KEY`, `EVERETT_ENDPOINT_ID`,
  `YIDDISHLABS_API_KEY`, `YIDDISHLABS_WEBHOOK_SECRET`, `ELEVENLABS_API_KEY`,
  `AGENT_YIDDISH_BRIDGE`. Elsewhere in `src/`: `JWT_SECRET` (auth, shared with api —
  `apps/agent/src/auth.ts:31`), `AGENT_INTERNAL_SECRET` (service-to-service trust —
  `apps/agent/src/conversation/routes.ts:34`), `AGENT_UPLOAD_DIR`
  (`docker-compose.agent.yml:23`).
  **Boots disabled by design**: `AGENT_ENABLED` must be explicitly `1`
  (`apps/agent/src/config.ts:5,63,92-94`); `AGENT_KILL_SWITCH=1` halts all tool/action
  execution instantly (`config.ts:92-94`). The agent must also boot cleanly with **no
  API keys present** (degraded/read-only-chat-off mode) — `config.ts:6`.
- **DB access**: the **shared Connect Postgres DB via the shared Prisma client**
  `@connect/db` — **not** a separate agent database. `apps/agent/src/db.ts:1-25`: lazy,
  dynamic `import("@connect/db")`, `mod.db` singleton, `$queryRaw\`SELECT 1\`` probe; on
  any failure the agent runs in "degraded (no-DB) mode" rather than crash. The Dockerfile
  comment is explicit: *"Prisma client must match the schema in this image (agent
  reads/writes Agent\* tables)"* (`apps/agent/Dockerfile:18-19`) — i.e. it reads/writes
  `Agent*`-prefixed tables in the **same** database `apps/api` uses (`User`, `Tenant`,
  `Extension`, `CallQualityHourly`, etc. are all read directly too, e.g.
  `apps/agent/src/tools/toolRegistry.ts:178-183`, `apps/agent/src/channels/identity.ts:26`).
- **Redis**: no Redis client/dependency in `apps/agent/package.json`; none found in
  `src/`. Rate limiting is in-process (`apps/agent/src/guards/limits.ts`), not
  Redis-backed.
- **Reached from the portal**: through an **nginx path proxy**, not a direct URL. The
  portal's own doc comment states it plainly:
  `apps/portal/components/FloatingAssistant.tsx:5-7` — *"Talks to the agent service
  through the nginx /agent-api/ proxy with the same Bearer token as the rest of the
  portal (identity/tenant come from the JWT server-side)."* Every browser call is
  `fetch(\`/agent-api/chat/${path}\`, …)` (`FloatingAssistant.tsx:94`, and the
  fire-and-forget `uiEvent` beacon at `FloatingAssistant.tsx:109-116`).
  **The nginx config itself is NOT checked into this repo** — confirmed by grepping
  `docs/ai-context/AGENT_HANDOFF_SUPPORT_CONSOLE_MOCKUPS_2026-08-20.md:70` ("The
  `/agent-api/*` → `/agent/*` nginx rewrite is NOT in the repo — only code comments") and
  `docs/ai-support-agent/HANDOFF_2026-07-22.md:45`, which names the live location:
  `/etc/nginx/sites-enabled/connectcomms` on the app host, rule
  `location /agent-api/ → http://127.0.0.1:3920/agent/` (whole prefix forwarded, i.e.
  `/agent-api/chat/message` → `/agent/chat/message` on the agent). Body limit there is
  1MB (`docs/ai-context/AGENT_HANDOFF_COWORKER_SCREEN_CONTROL_2026-09-15.md:81`);
  `proxy_read_timeout`/`proxy_send_timeout` were raised 120s→900s for long Coworker turns
  (`docs/ai-context/AGENT_HANDOFF_COWORKER_HANDS_2026-09-09.md:109`). Repo-checked nginx
  configs that DO exist (`website/deploy/nginx-loopcom.conf`,
  `infra/community/nginx.conf.example`) are for the **marketing site** and the
  **community app** respectively, not this app/agent pair.
  Inside the docker network, `apps/api` reaches the agent at
  `AGENT_BASE_URL || "http://agent:3920"` (`apps/api/src/server.ts:26656`, service name
  `agent` from `docker-compose.agent.yml:8`), and the agent reaches `apps/api`'s internal
  doors the same way, using `AGENT_API_BASE`-style URLs built per-client
  (`apps/agent/src/pbx/internalApiPost.ts`, various `apps/agent/src/pbx/*Client.ts`).
- **No separate `agent` block exists in `docker-compose.app.yml`** — the agent's compose
  service is defined ENTIRELY in the override file `docker-compose.agent.yml:1-33`, applied
  as `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml up -d --build agent`
  (comment at `docker-compose.agent.yml:3-4`). It shares two named volumes
  (`agent-audit`, `agent-uploads`) and joins both the default network and `infra_default`.

## 2. CALLER AUTHENTICATION

**Token**: the same **Connect API JWT** the rest of the portal uses (HS256, shared
`JWT_SECRET` with `apps/api`), sent as a standard `Authorization: Bearer <jwt>` header.
Verification is hand-rolled with `node:crypto` (no JWT library) in
`apps/agent/src/auth.ts:31-60` (`verifyPortalJwt`):
- Splits `header.payload.signature`, requires `alg === "HS256"` ("never accept alg
  confusion", `auth.ts:44`), recomputes the HMAC and compares with `timingSafeEqual`
  (`auth.ts:45-47`).
- Checks `exp` if present (`auth.ts:48`) — **note**: portal session tokens are documented
  elsewhere as not always carrying expiry (see memory `session-tokens-still-never-expire`),
  so this check is best-effort, not a guarantee every token expires.
- Requires `payload.tenantId` and `payload.sub` (`auth.ts:49`).
- Claims read: `sub` → `clientUserId`, `tenantId`, `role` (raw platform role, mapped),
  `email`, and the **raw** role is also kept as `platformRole` (`auth.ts:50-59`) —
  deliberately kept alongside the mapped `role` because they answer different questions
  (see below).

**Role model** — two orthogonal questions, documented at length in
`apps/agent/src/authRoles.ts:1-93`:
1. **Agent "mode"** (`Role = "owner" | "customer"`, `apps/agent/src/conversation/store.ts:6`):
   `mapUserRole()` (`authRoles.ts:32-34`) maps platform `SUPER_ADMIN` or `TENANT_ADMIN` →
   `"owner"` (admin mode), everything else → `"customer"`. A **custom role literally named
   "owner"** on that tenant also confers admin mode, but that needs a DB read the JWT alone
   can't answer — `elevateForCustomOwnerRole()` (`authRoles.ts:43-65`) is an async top-up
   callers must run explicitly; failure/absence leaves the role untouched (fails closed).
2. **Platform staff** (`isPlatformStaff`, `authRoles.ts:88-92`): **only** `SUPER_ADMIN` is
   Connect's own staff. `PLATFORM_STAFF_ROLES = {"SUPER_ADMIN"}`. This is intentionally
   NOT the same as "owner" mode — conflating them cost the platform every tenant-admin's
   escalations for two weeks (documented history in the same file, `authRoles.ts:67-87`).
   Fails **open toward escalating** (unknown role → not staff → request still reaches a
   human), the opposite failure direction from the admin-mode check.

**Tool-visibility role** is a third, narrower enum, `ToolRole = "customer" | "internal" |
"staff"` (`apps/agent/src/tools/toolRegistry.ts:22-38`): `customer` = untrusted tenant
user; `internal` = admin mode for the caller's OWN tenant (SUPER_ADMIN or TENANT_ADMIN);
`staff` = Connect staff (SUPER_ADMIN) only, for cross-tenant tools like raw-SQL
`investigate`. A TENANT_ADMIN is always `internal`, never `staff`.

**Admin HTTP-route authorization** (`/agent/admin/*`, `/agent/diag/*`) is separate again:
`apps/agent/src/adminAuth.ts:36-45` `resolveAdminCaller()` requires `id.role === "owner"`
from `verifyPortalJwt`, returns `{ tenantId, clientUserId, isStaff }` where `isStaff` is
`isPlatformStaff(platformRole)`; `resolveStaffCaller()` (`adminAuth.ts:48-51`) further
narrows to staff-only. Every admin route either requires `isStaff` (global consoles) or
binds to the caller's own tenant unless `isStaff` (per-tenant ops) — never trusts a
body-supplied `tenantId` (`adminAuth.ts:24-25`).

**Service ("machine") identity — the existing precedent for a second caller type.**
`apps/agent/src/conversation/routes.ts:1-41` (`resolveIdentity`) resolves identity in
**strict order**:
1. Valid portal JWT → identity **derived from the token**; anything in the body is
   ignored (`routes.ts:28-33`).
2. **`x-agent-internal-secret` header matching `process.env.AGENT_INTERNAL_SECRET`** →
   identity is taken from `body.identity`, validated by a zod schema
   (`Identity = z.object({ tenantId, clientUserId, role: enum("owner","customer") })`,
   `routes.ts:22-26,34-39`) — i.e. **the caller asserts who the user is**, trusted only
   because it holds the shared secret. Comment at top of file: *"the caller is one of our
   own services which already authenticated the user"* (`routes.ts:9-10`).
3. Neither → `403 forbidden` (`routes.ts:40`, enforced again at each route, e.g.
   `routes.ts:59-60`).
   This same secret is used **in the other direction** too: the agent's tool layer calls
   `apps/api`'s internal PBX doors with `x-agent-internal-secret`
   (`apps/agent/src/pbx/internalApiPost.ts:29-34`; verified server-side by
   `agentMohSecretOk` at e.g. `apps/api/src/server.ts:25862,29748,29794,30229` and
   `apps/api/src/agentProvisioning/accountSetupInfoRoute.ts:132,152`). It is a **single
   bidirectional shared secret**, not a per-caller/per-app credential — today there is
   exactly one trusted "service" identity, not a roster of named external callers.

**"Act on behalf of tenant X"**: **no such mechanism exists inside `apps/agent`.** Grepping
`apps/agent/src` for `x-tenant-context` / `tenantContext` / `effectiveUser` returns nothing.
The portal's super-admin "act as this tenant" switcher (`x-tenant-context` header,
`apps/portal`/`apps/api` `effectiveUser.ts`, per `CLAUDE.md`'s desk-phone-wizard R28 notes)
is an **`apps/api`-only** concept; a super-admin browsing the agent chat still authenticates
with their own JWT and their own `tenantId` — the agent has never been taught to honor an
impersonation header.

**Channel identity** (email/SMS/WhatsApp, no JWT at all):
`apps/agent/src/channels/identity.ts:19-45` (`IdentityResolver.byEmail` / `.byPhone`) does
an **exact match** against `User.email`/`User.phone` in the DB; an unmatched sender
resolves to `null` and the channel declines/escalates rather than guessing a tenant
(`identity.ts:5-7`). This is verification-by-exact-DB-match, structurally different from
both the JWT path and the internal-secret path.

## 3. CONVERSATION API

All routes registered in `apps/agent/src/conversation/routes.ts` via
`registerChatRoutes()` (`routes.ts:43-57`), served under the literal path prefix
`/agent/chat/*` (reached externally as `/agent-api/chat/*` through nginx):

| Method | Path | Body (zod-validated) | Notes |
|---|---|---|---|
| POST | `/agent/chat/message` | `text` (1-8000 chars), `channel?`, `attachments?` (finished upload ids), `turnId?` (Coworker workspace poll id), `conversationId?`, `newTask?`, `language?` ("en"\|"yi"), `context.page?`, `context.path?`, `context.folders?` | `routes.ts:58-169`. Main entry point. |
| POST | `/agent/chat/upload/init` | `filename`, `mimeType?`, `sizeBytes`, `totalChunks` | `routes.ts:174-196` |
| POST | `/agent/chat/upload/chunk` | `uploadId`, `index`, `dataBase64` | `routes.ts:198-212` — chunked because nginx caps `/agent-api/*` bodies at ~1-10MB (comment `routes.ts:171-172`) |
| POST | `/agent/chat/upload/finish` | `uploadId` | `routes.ts:214-223` |
| POST | `/agent/chat/close` | `conversationId` | `routes.ts:226-233` |
| POST | `/agent/chat/history` | (none) | `routes.ts:235-239` — lists the caller's conversations |
| POST | `/agent/chat/messages` | `conversationId` | `routes.ts:241-250` — returns `{messages, humanTakeover}` |

Other route groups registered from `server.ts` (not conversation, but adjacent): admin/
translations/trainer (`server.ts:434-475`), `chat/ui-event` beacon (`server.ts:485`),
channel webhooks `channels/email/inbound`, `channels/messaging/inbound`
(`server.ts:504,515`), Coworker desktop-link routes (`registerCoworkerLinkRoutes`,
`apps/agent/src/coworker/routes.ts`), diag routes, action routes, policy admin routes.
Health check is unauthenticated: `app.get("/health", …)` → `{ok:true, service:
"@connect/agent", ts}` (`server.ts:1308`).

**Streaming**: **none.** A chat turn is **one long synchronous request/response** — the
route handler `await`s `engine.handleMessage(...)` in full
(`routes.ts:139-149`) and returns a single JSON object (`ChatResult`:
`conversationId`, `reply`, `language`, `model?`, `degraded`, `humanTakeover?` —
`apps/agent/src/conversation/engine.ts:292-...`). No SSE, no WebSocket, no chunked
transfer for the model output itself (confirmed independently by
`docs/ai-context/claude-md-sections/2026-09-15-coworker-workspace-built.md:44`: *"There
is still no streaming. A chat message is ONE long request"*). The only "live" channel is
the separate Coworker **activity poll** (`turnId` + a long-poll `/agent/coworker/activity`
style endpoint via `ActivityHub`, `apps/agent/src/coworker/activity.ts`) that reports
step-by-step progress while the single big request is still in flight — a sidecar, not a
stream of the reply itself.

**Persistence**: `apps/agent/src/conversation/store.ts` — `ConversationRow` (`id`,
`tenantId`, `clientUserId`, `role`, `channel`, `language`, `status: OPEN|CLOSED`,
`startedAt`, `closedAt`, `humanTakeoverAt/By`) and `MessageRow` (`id`, `conversationId`,
`role`, `content`, `contentEn?`, `model?`, `createdAt`) — `store.ts:11-30`. Interface-based
(`ConversationStore`, `store.ts:32-...`) so the engine is unit-testable against an
in-memory fake; production impl is `PrismaConversationStore` (imported
`server.ts:15`) against the shared DB's `Agent*` tables.

**Attachments**: `apps/agent/src/attachments/uploadStore.ts` (+ `extractText.ts`) backs
the chunked upload flow above; uploads are tenant-scoped —
`uploads?.get(id, identity.tenantId)` in `routes.ts:118` means an attachment id from
another tenant simply doesn't resolve.

**Page context from the portal**: yes — the widget has always sent `context.page` /
`context.path` (which portal page/route the user is viewing) and, for the desktop
Coworker, `context.folders` (paths the user attached locally). Handled and forwarded to
the engine as **data only, never authority** — comment at `routes.ts:77-82,87-89`: *"the
schema silently dropped it, so the assistant answered 'I can't see what you are doing'…
Data, not instructions: values are length-capped and passed to the engine as context
only."* / *"what the computer may touch is decided by the desktop app, never by this."*
The client-side code sending this is `apps/portal/components/FloatingAssistant.tsx`
(uses `usePathname()`, though the exact body-assembly lines weren't captured in this pass
— search `apiPost`/`agentPost` calls in that file for the literal payload).
A related, structurally important signal: **`User-Agent` sniffing** —
`routes.ts:130-136`: the Windows desktop app brands its UA as `Loopcom/<version>`; the
route tests `/\bLoopcom\/\d/` to decide whether to widen the tool offer with
`computer_*` tools. Documented as "data, not authority": the desktop link itself is keyed
by verified identity and the desktop re-checks every call locally, so a forged header
gains nothing without an actual linked app.

## 4. TOOLS

**Registration/schema format**: hand-written **plain JSON Schema** objects (not zod, not
a code-gen'd schema) implementing a small local interface, in
`apps/agent/src/tools/toolRegistry.ts:53-65` (`ToolSpec`: `name`, `description`,
`parameters: JsonSchema` — `type:"object"`, `properties`, `required?`,
`additionalProperties:false` — `minRole: ToolRole`, `run(args, ctx)`). Each concrete tool
set (`buildTools`, `buildPermissionTools`, `buildProvisioningTools`, `buildContactsTools`,
`buildSelfServiceTools`, `buildPortStatusTools`, `buildCoworkerTaskTools`,
`buildInvestigationTools`, `buildWorkbenchTools`, `buildCreativeTools`, `buildDesktopTools`
— all imported in `server.ts:17-34`) is a factory function returning `ToolSpec[]`, e.g.
`buildTools()` in `apps/agent/src/manifest/manifest.ts`'s sibling
`apps/agent/src/tools/toolRegistry.ts:117-183` (four read-only tools:
`extension_status`, `call_history`, `voicemails`, `call_quality`).

**Identity/tenant binding**: the file's own header states the one rule it exists to
enforce — `toolRegistry.ts:1-17`: *"`tenantId` is NEVER a model-supplied argument. It is
bound at execution time from the server-verified `ToolContext`. No tool's JSON schema may
declare it, and `execute()` strips any tenant-ish key the model invents before the args
ever reach a query."* `ToolContext` (`toolRegistry.ts:39-47`): `tenantId` (server-verified),
`role: ToolRole`, `clientUserId?`, `viewingPath?`, `conversationId?`. Every tool's `run`
closes over `ctx.tenantId`/`ctx.role`, never a model-supplied id (e.g.
`toolRegistry.ts:129,150,163-165,177-182`). `stripForbiddenArgs()`
(`toolRegistry.ts:75-89`) hard-drops any argument key matching
`tenantid|tenant_id|tenant|companyid|company_id|clientuserid|client_user_id|userid|
user_id|role` before a tool ever sees it, and reports what was dropped for auditing.

**Permission gating**: `minRole` on each `ToolSpec` (`customer|internal|staff`);
`toolsForRole()` (`toolRegistry.ts:204-210`) filters the full catalogue per caller —
`staff` sees everything, `internal` sees `customer+internal` (never `staff`-only tools),
`customer` sees only `customer`-tier tools; unauthorized tool names are simply **absent**,
not visible-but-refused (comment: "Customers never learn an internal tool exists").
`executeTool()` (`toolRegistry.ts:222-240`) re-checks visibility server-side even if the
model somehow names a hidden tool (`Unknown or unavailable tool` error returned to the
model, not thrown, so the loop can recover). A separate **manifest gate**
(`apps/agent/src/manifest/manifest.ts:1-54`, `apps/agent/src/manifest/capabilities.json`)
additionally filters which *capabilities* even exist in the runtime registry: only
`status === "certified" | "live"` capabilities load (`manifest.ts:44-46`) — most of the
~40 catalogued capabilities (`read.*`, `action.A1-A12`, `pbx.P1-P14`, `watchman.*`,
`owner.*`) are still `planned`, i.e. **inert by design** until proven.

**Confirmation-gated ("destructive") actions**: a separate state machine, not part of the
tool call itself — `apps/agent/src/actions/service.ts:1-40`: `DRAFT → PENDING_APPROVAL →
APPROVED → EXECUTING → EXECUTED (→ REVERTED)`, with `DENIED`/`EXPIRED`/`FAILED` side
states. A tool doesn't execute a PBX write directly; it drafts an `AgentAction` (e.g.
`coworkerTaskTools.ts` — *"writes a DRAFT AgentAction… The person then sees the
four-question card… the api records their approval, and the DESKTOP app… re-validates
the task against its own copy of the allowlist"* —
`apps/agent/src/tools/coworkerTaskTools.ts:1-19`), the human approves via a signed token
(`apps/agent/src/actions/tokens.ts`, `bindings.ts` — params-hash-bound approval tokens),
and only then does an `ExecuteBackend` (keyed by capability prefix, e.g. `"pbx."` →
`ScopedPbxExecutor`) perform the real write (`service.ts:33-40`). "A model's output must
never be the thing that authorises an action, so the model can only ever ASK, in a shape
the policy engine already judged" (`coworkerTaskTools.ts:14-16`).

**Calling the Connect api**: tools that need `apps/api` data call it as a **trusted
internal service**, not by forwarding the user's own portal JWT. The shared helper
`postInternalApi()` (`apps/agent/src/pbx/internalApiPost.ts:16-38`) attaches
`x-agent-internal-secret: <AGENT_INTERNAL_SECRET>` to every internal POST (to
`/api/...moh/route/ivr/queue/extfeature...` doors), with transport-only retry (never
retries a request that got an HTTP response). The tenant/user identity travels as a
**body field** (`tenantId`, etc.), not as a re-derived JWT claim — trust is "this really
is our own agent process" (shared secret), and correctness is "the tenantId in the body
matches `ctx.tenantId`, which was itself bound from the caller's verified JWT at the
start of the turn." This is the **service-token model**, distinct from user-impersonation.

**"Hands"/Coworker desktop tool pattern** (high level): `apps/agent/src/coworker/
desktopLink.ts:1-30` — the Windows desktop app (Electron) posts `hello` with a manifest
of tools it can run locally (built-in "hands" + connected MCP servers), then long-polls
`next` for work. When the model calls one of those tool names, `DesktopLink.dispatch()`
queues the call **for that specific person's desktop** and awaits the `result` it posts
back, inside the same HTTP turn. Explicitly **in-memory, not durable** ("a tool call that
outlives the agent process has no caller left to receive its result" —
`desktopLink.ts:18-20`), and **keyed by the server-verified identity**
(`tenantId + clientUserId`) — "There is no 'send to desktop X' parameter anywhere"
(`desktopLink.ts:13-15`). The desktop, not the agent, makes the local authorization
decision (policy core / profile / approval dialog) — "this module never executes anything
and never decides anything. It is a mailbox with timeouts" (`desktopLink.ts:10-12`).

## 5. LLM LANE

**Providers/models**: `apps/agent/src/llm/router.ts` — **OpenAI + Anthropic**, both
wired via their official SDKs (`openai`, `@anthropic-ai/sdk`,
`apps/agent/package.json:12-13`; instantiated `router.ts:246-247`). Model routing table
(`router.ts:87-94`): `support_chat`/`task_extraction` primary **OpenAI `gpt-5`**
(`OPENAI_MODEL`, `router.ts:29`) with **Anthropic `claude-sonnet-5`** fallback
(`ANTHROPIC_MODEL`, `router.ts:27`); `diagnostics`/`security_analysis`/`report_writing`/
`policy_editing` primary **Anthropic `claude-opus-5`** (`ANTHROPIC_MODEL_HEAVY`,
`router.ts:28`) with OpenAI fallback. A customer-facing "chat model picker" also allows
Anthropic `claude-fable-5` (`router.ts:124`). Comment: "Sonnet 5 stays the failover so a
provider outage never mutes the chat" (`router.ts:87`).

**System prompt / persona** — assembled in `apps/agent/src/conversation/engine.ts`, two
variants picked by `staffMode` (`engine.ts:874`, `basePrompt = staffMode ?
STAFF_SYSTEM_PROMPT : SYSTEM_PROMPT`):
- **Customer-facing** (`engine.ts:75-...`), quoting the identity line verbatim:
  > "You are the Connect Communications support agent ("Shammes"). You help phone-system
  > clients in English or Yiddish — always reply in the language the client used."
- **Staff-facing** (`engine.ts:164`), quoting the identity line verbatim:
  > "You are Loopcom's own engineering assistant, working with the platform owner inside
  > the support Workbench."
  followed immediately by an explicit "who you're talking to" clause (`engine.ts:166`):
  "WHO YOU ARE TALKING TO: Connect staff — the owner of this platform. Not a customer.
  There is no privacy boundary between you and this person… NEVER refuse them on privacy
  or confidentiality grounds…"
- A **translation-bridge suffix** is appended when Yiddish Labs bridging is active
  (`engine.ts:199-201`, `SYSTEM_PROMPT_BRIDGE`, also `bridgeSuffix()` helper at
  `engine.ts:189-193`): forces the model to answer only in English so Yiddish Labs (not
  the LLM) renders the customer-visible Yiddish.

**Knowledge docs injection**: `apps/agent/src/knowledge/kb.ts` — a learning-loop knowledge
base of `KbArticle` rows (`title`,`problem`,`cause`,`fix`,`approved`,
`sourceConversationId?`, tenant-scoped via `tenantId: string | null` — null = platform-wide),
retrieved by **keyword/token-overlap scoring** (`tokenize()`/`scoreOverlap()`,
`kb.ts:24-33`), no embeddings/vector DB. "Only APPROVED articles are ever surfaced to
customers — drafts stay internal until the team signs off" (`kb.ts:7-8`). A second,
simpler mechanism — `apps/agent/src/knowledge/standingKnowledge.ts`
(`loadStandingKnowledgeBlock`) — injects a fixed platform-wide knowledge block (imported
by both the engine and the escalation researcher, `escalations.ts:26`).

**Streaming of tokens**: not emitted incrementally to the HTTP caller at all (see §3) —
the model call itself may stream provider-side internally for the tool-loop implementation
(`apps/agent/src/llm/toolLoop.test.ts` suggests a tool-loop abstraction exists in
`router.ts`/adjacent), but the Fastify route only ever returns one finished JSON body.

## 6. AUDIT/LOGGING

`apps/agent/src/audit/audit.ts:15-63`. `AuditEvent`: `ts?`, `actor` (`"agent"|"model"|
"owner"|"customer"|"system"|"watchman"`), `event` (free-text event name), `tenantId?`,
`conversationId?`, `actionId?`, `capabilityId?`, `payload?: unknown`. `AuditLog.record()`
(`audit.ts:41-58`) stamps a timestamp, computes a **SHA-256 hash of the row** (tamper
evidence — `createHash("sha256")`, `audit.ts:50`), and writes to **every configured
sink**, succeeding if **at least one** sink accepts the write (never blocks the caller on
a logging failure, but logs the sink error loudly to stderr — `audit.ts:51-58`).
**Where**: `FileAuditSink` (`audit.ts:29-36`) appends JSONL to
`AGENT_AUDIT_DIR/audit-<date>.jsonl` (default `/var/log/connect-agent`,
`config.ts:73`, docker volume `agent-audit`, `docker-compose.agent.yml:23,28-29`). The
class doc comment (`audit.ts:1-8`) says a **second, DB-backed sink** is added once the
`agent_*` Prisma migration lands, with the flat file remaining "the tamper-evidence
copy" — i.e. **both file and DB sinks are intended, file-only may be the current live
state** (this pass did not confirm which sinks `server.ts` actually wires up at
construction time — worth the lead engineer double-checking `server.ts`'s
`new AuditLog([...])` call site before relying on a DB audit trail existing today).
**Secret-scrubbing**: no dedicated redaction pass was found inside `audit.ts` itself; the
protection is architectural instead — e.g. the explicit routing rule that a password
"must NEVER traverse `/agent-api/*`" (`docs/ai-context/AGENT_HANDOFF_SUPPORT_CONSOLE_
MOCKUPS_2026-08-20.md:77`, citing `agentGrantRoutes.ts:10-12` in `apps/api`), and the
`secrets/store.ts` module (`apps/agent/src/secrets/store.ts`) that appears to hold
provider keys separately from chat payloads. A secret-scrubbing pass over audit
*payloads themselves* was not located in this read-only pass — flag as unverified rather
than assume it exists.

## 7. ESCALATION / HUMAN HANDOFF (≤5 lines)

`apps/agent/src/escalation/escalations.ts:1-40+`. After every turn, the service scans
the assistant's own reply for one of its own fixed escalation phrasings (regex over the
literal strings the system prompt is instructed to use, `ESCALATION_RE`), and — only
when matched — researches the problem with the same tool-calling LLM (tenant-bound,
read-only tools) and writes a `QUEUED` `AgentEscalation` row with a drafted fix, an SMS
body, and a full report; `apps/api`'s dispatcher does the actual SMS/email send
(deliberately split so delivery-policy fixes don't require rebuilding the agent
container). Fails toward escalating: if the research LLM is unavailable, the row is
still written, flagged `researchDegraded`, with the raw request as the report
(`escalations.ts:1-26`).

## 8. EXISTING MULTI-APP SUPPORT

There is **no first-class "which app is the caller in" concept** in `apps/agent` — no
`clientApp`, `surface`, or `appId` field anywhere in `src/conversation` or a
`src/channels` registry keyed by app. What exists instead, all narrower:
- **`channel`** (`"chat"|"email"|"sms"|"whatsapp"`, etc.) — a **client-supplied, purely
  cosmetic** string. `apps/agent/src/conversation/engine.ts:150-151`: "a client can put
  any string in `channel`; nobody can forge the platform role. The channel only flavours
  the wording." It is never used for authorization.
- **User-Agent sniffing** for exactly one distinction — browser tab vs the Loopcom
  Windows desktop app — `routes.ts:130-136` (`/\bLoopcom\/\d/` regex on the UA header),
  gating only whether `computer_*` desktop tools are *offered*, not who the caller is.
- **`viewingPath`** (e.g. `/desktop/coworker`) is used by specific tools (e.g.
  `coworkerTaskTools.ts`) to refuse running outside the Coworker bubble UI —
  again a UI-surface check, not an app/tenant identity.

No `origin` header-based routing was found either. **`apps/community-api` does NOT
reuse this agent** — an exhaustive grep of `apps/community-api/src` for `agent`,
`agent-api`, `:3920`, `AGENT_INTERNAL_SECRET` returned **zero matches**; Loopcom
Community is a structurally separate product with its own stack (confirmed separately
that `infra/community/` has its own docker-compose and nginx example, unrelated to the
`/agent-api/` proxy). **There is therefore no existing precedent inside this codebase for
a second product authenticating into the agent** — the closest analogues are (a) the
portal's own browser JWT path, and (b) the `x-agent-internal-secret` + asserted-identity
path used for server-to-server calls (§2), which is trusted but generic (one shared
secret, not scoped per caller).

Note for context (not audited in depth — out of this task's file scope): a folder named
`Loopcom works/` exists at the repo root with its own `CLAUDE.md`/`AGENTS.md`/`MEMORY.md`
and extensive deployment docs, confirming LoopCom Works is indeed a structurally separate
codebase/product (consistent with the task's framing of "on its own server"), not
currently wired to `apps/agent` in any way this pass found.

## 9. RECOMMENDED SEAM (design input only — nothing below is built or proposed as code)

**(a) Identity assertion the Works server could mint.** A signed, short-lived assertion
(JWT or HMAC'd payload) carrying: `worksUserId`, a **Loopcom `tenantId`** (required —
every tool and audit row is keyed on it), `clientUserId` **only when the Works user maps
to a real Loopcom `User` row** (SSO case) else `null` (standalone case), and a `role`
already collapsed to the agent's own `"owner"|"customer"` enum (§2) — Works, not the
agent, should decide admin-vs-customer for its own users, the same way `apps/api` already
decides `SUPER_ADMIN`/`TENANT_ADMIN` before the agent ever sees a JWT.

**(b) Verification path.** Do **not** extend `verifyPortalJwt` (`auth.ts:31`) to accept a
second issuer/secret — that function's entire safety property is "one secret, one
issuer, alg pinned." Instead add a **third branch to `resolveIdentity()`**
(`routes.ts:28-41`), parallel to the existing internal-secret branch but with its **own**
secret/issuer (`WORKS_SHARED_SECRET`, distinct from `AGENT_INTERNAL_SECRET`) and its
**own** zod schema tagging the result `source: "works"` — so every downstream consumer
(tools, audit, escalation-suppression) can tell a Works caller apart from a portal
browser or an `apps/api` service call, the way `platformRole` already lets code
distinguish "owner mode" from "Connect staff" (§2).

**(c) Works tool set.** A new `apps/agent/src/tools/worksTools.ts` following the existing
factory pattern (`toolRegistry.ts:117-183`): plain JSON-schema `ToolSpec`s, `minRole`
gated, each `run(args, ctx)` calling the **Works API** (never the Works DB) with the
caller's identity carried the same way `postInternalApi()` carries it today
(`internalApiPost.ts:16-38`) — a shared secret proving "this is really the agent" plus
the verified `ctx` (tenant/user) as a body field, so Works enforces its own authorization
server-side exactly as `apps/api` does today for agent-originated calls.

**(d) Must NOT be reused.** The `staff`-tier tools and `STAFF_SYSTEM_PROMPT`
(`engine.ts:164`, `toolRegistry.ts:88 PLATFORM_STAFF_ROLES`) are Connect-employee-only and
must stay gated on `isPlatformStaff` (real `SUPER_ADMIN`), never on a Works-asserted role;
the Coworker desktop-link ("hands") tools (§4) are keyed to the Loopcom Windows app and
have no meaning for a Works web session; the admin/diag HTTP surface
(`adminAuth.ts:36-51`) should stay closed to Works entirely (§2's admin-route logic
already requires a portal JWT with `role==="owner"`, which a Works assertion should never
satisfy unless Works explicitly needs an admin console of its own later).

**(e) The ~5 files that would change**, in order of certainty: (1)
`apps/agent/src/auth.ts` or a new `apps/agent/src/authWorks.ts` — the new verification
function; (2) `apps/agent/src/conversation/routes.ts:28-41` — add the third
`resolveIdentity()` branch; (3) `apps/agent/src/tools/toolRegistry.ts` and/or a new
`apps/agent/src/tools/worksTools.ts` — register the Works tool set and decide whether
Works tools are always-visible or gated by a new `ToolRole`-like flag; (4)
`apps/agent/src/server.ts` — wire the new tool builder + secret into the Fastify app
construction (mirroring lines like `server.ts:17-34`'s existing tool-builder imports);
(5) nginx (**not in this repo** — see §1) — a new `location` (or the Works server calling
the agent's docker-internal address directly, bypassing nginx entirely, which may be
simpler since Works is server-to-server, not browser-originated).
