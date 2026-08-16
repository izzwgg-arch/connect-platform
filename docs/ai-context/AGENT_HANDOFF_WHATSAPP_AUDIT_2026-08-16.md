# AGENT HANDOFF — WhatsApp integration audit (2026-08-16)

**Read-only audit. No code change, no migration, no deploy, no flag flipped.**
Everything below was read from the repo, the running containers, and the live
production database on 2026-08-16.

Scope of the question asked: *"We have built a WhatsApp API integrated with the
system. Check where it's audited and check where it's up to."*

---

## 0. The one-line answer

The **front door is built and reasonably careful** — signature-verified
webhooks, encrypted per-tenant credentials, admin routes, two registered
workers. **Behind it there is no room.** It receives nothing (enqueue flag off),
stores nothing (never configured by any tenant), **sends nothing (no provider
transport code exists anywhere in the repo)**, and the one code path that would
light it up writes an enum value that **does not exist in the production
database**, so it would throw on the first real message.

---

## 1. Timeline — how old is this

| Commit | Date | What |
|---|---|---|
| `ee78362c` | 2026-05-24 19:31 | chore(whatsapp): chat data model foundation |
| `2459fbb4` | 2026-05-24 20:13 | feat(whatsapp): verified webhook ingest skeleton (PR1) |
| `10487d51` | 2026-05-24 23:04 | feat(whatsapp): PR2 inbound projection to Connect Chat behind flag |
| `66d33454` | 2026-07-19 | feat(agent): SMS/WhatsApp channel (agent-side, separate) |

Older WhatsApp-adjacent work (the legacy ops dashboard, provider settings,
customer hub) is from **2026-03**, in `apps/frontend-legacy/`.

**All the current WhatsApp code landed in one evening, 2026-05-24, and has not
been touched in ~3 months.**

---

## 2. WHERE IT IS AUDITED

### 2.1 Documentation (four places, all written the same night)

| File | Lines | Content |
|---|---|---|
| `docs/ai-context/ARCHITECTURE.md` | 73–116 | **The primary record.** "Option A" design (WA is first-class inside Connect Chat, no parallel inbox), PR1/PR2 descriptions, every env flag with its default, compliance guardrails (24h window, templates, official providers only, backend-only sends) |
| `docs/ai-context/DATA_MODEL.md` | 508–522, 542–548 | ConnectChatMessage provider-reconciliation fields; "WhatsApp (Option A — data-model foundation implemented)"; the idempotency fallback rule |
| `docs/ai-context/API_ROUTES.md` | 27–46, 339–362 | Route inventory + roadmap (templates endpoints are docs-only). ⛔ **Its line numbers are stale** — it cites `/whatsapp/test-send` at 5752 and `/whatsapp/threads/:id/send` at 5919; they are actually at **7936** and **8103** |
| `docs/ai-support-agent/BUILD_STATUS.md` | 32 | `SMS/WhatsApp channel (Twilio) \| ✅ live \| transport guarded until Twilio creds` — ⛔ **this line is wrong**, see §4.1 |

⛔ **There is NO `AGENT_HANDOFF_WHATSAPP_*.md` (until this file) and CLAUDE.md
had NO WhatsApp section at all.** The feature was invisible to the file every
session is instructed to read first. That is precisely how it sat three months
in a half-state without anyone noticing.

### 2.2 Runtime audit trail (the `AuditLog` table)

Actions emitted by the code:

- `WHATSAPP_CREDENTIAL_CREATED` / `_UPDATED` (server.ts:7845, 7903)
- `WHATSAPP_CREDENTIAL_ENABLED` / `_DISABLED` (server.ts:7918, 7932)
- `WHATSAPP_TEST_SEND_SIMULATED` / `_DISPATCHED` (server.ts:7948, 7952)
- `WHATSAPP_REPLY_SENT` (server.ts:8145)

**Live prod query 2026-08-16: `auditLog.groupBy` on `action startsWith
"WHATSAPP"` returns an EMPTY ARRAY.** Not one WhatsApp audit row has ever been
written, on any tenant, since the tables were created.

⛔ The **compliance** audit table the docs promise — `WhatsAppPolicyAuditEvent`
— **does not exist in the production database** (see §5).

### 2.3 Verification harnesses (exist, run only by hand)

| Script | What it proves |
|---|---|
| `apps/api/scripts/wa_ingest_verify.ts` | Meta HMAC-SHA256 + Twilio HMAC-SHA1 signature verification, and the `normalizeMeta` / `normalizeTwilioStatus` shapes |
| `apps/worker/scripts/wa_project_verify.ts` | `normalizeWhatsAppE164`, `buildDedupeKey`, `buildFallbackExternalMessageId`. ⛔ **Line 47 forces `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED = "false"`** — so it can never exercise the actual DB write, which is the part that is broken (§5) |
| `scripts/smoke-whatsapp.sh` | Signs up a throwaway tenant and asserts `/whatsapp/status`, `/whatsapp/threads`, `/whatsapp/messages/recent` return the right SHAPE. Proves routing, not behaviour |

⛔ **None of the three is referenced from any `package.json` script, any `.yml`,
or any CI config.** Verified by grep. They run only if a human remembers them.

---

## 3. WHAT ACTUALLY EXISTS (the real inventory)

### 3.1 Database — production has THREE tables

`WhatsAppProviderConfig`, `WhatsAppThread`, `WhatsAppMessage`.
From migrations `20260303151500_whatsapp_provider_config` and
`20260308011000_whatsapp_ops_threads_messages`.

Plus the additive columns on `ConnectChatMessage` from
`20260610190000_connect_chat_message_provider_reconciliation`:
`externalProvider`, `externalMessageId`, `externalConversationId`,
`providerStatus`, `providerMetadata`, `deliveredAt` + two indexes.
✅ **These columns ARE live** — confirmed present in prod.

### 3.2 API routes (`apps/api/src/server.ts`)

Settings / credentials:
- `GET /settings/providers/whatsapp` (7775) — masked list
- `PUT /settings/providers/whatsapp/twilio` (7795)
- `PUT /settings/providers/whatsapp/meta` (7849)
- `POST /settings/providers/whatsapp/enable` (7907) — exclusive; disables the others
- `POST /settings/providers/whatsapp/disable` (7922)
- `GET /settings/whatsapp-routing` (7956)

Inbox:
- `POST /whatsapp/test-send` (7936)
- `GET /whatsapp/status` (7969)
- `GET /whatsapp/messages/recent` (7997)
- `GET /whatsapp/threads` (8029)
- `GET /whatsapp/threads/:id` (8071)
- `POST /whatsapp/threads/:id/send` (8103)

Webhooks (public — correctly listed in `jwtPublicRouteBypass.ts:146-147`):
- `GET /webhooks/whatsapp/meta` (37682) — hub.challenge verify, matches
  `verifyToken` against decrypted creds across enabled Meta configs
- `POST /webhooks/whatsapp/meta` (37704) — `config: { rawBody: true }`,
  `X-Hub-Signature-256` HMAC-SHA256, **required by default**
- `POST /webhooks/whatsapp/twilio/status` (37562) — `X-Twilio-Signature`
  HMAC-SHA1 over the full URL + sorted params, **required by default**

Credentials are encrypted at rest (`decryptJson` / `ensureCredentialCrypto`,
same `CREDENTIALS_MASTER_KEY` machinery as the rest of the platform) and masked
in every response (`maskWhatsAppConfigForResponse`, server.ts:1454).

⛔ Tenant resolution on **both** webhooks is by **linear scan over every
`WhatsAppProviderConfig` row, decrypting each one**, matching `accountSid` /
`phoneNumberId`. Fine at 0 rows; it is O(tenants × decrypt) per inbound
webhook and will need an index column before any real volume.

### 3.3 Queues + workers

- `WHATSAPP_INBOUND_QUEUE` / `WHATSAPP_STATUS_QUEUE` (`packages/shared/src/queues.ts`)
- Registered in `apps/worker/src/main.ts:83-87`
- `whatsappInboundJob.ts` — logs a sanitized summary, then calls
  `projectInboundToConnectChat` **only if** the projection flag is on
- `whatsappStatusJob.ts` — ⛔ **logs a summary and acks. That is the entire
  handler.** Delivery statuses are never applied to anything

### 3.4 Portal

- `apps/portal/app/(platform)/apps/whatsapp/page.tsx` — **17 lines.** A
  `PageHeader`, a `DetailCard` with one sentence, and a button linking to
  `/chat`. There is no inbox UI.
- Nav entry `apps.whatsapp` → `/apps/whatsapp`, gated on
  `can_view_apps_whatsapp_inbox`, which is in the `can_view_sms` bucket
  (`portalPermissions.ts:256`)
- ⛔ The **real** WhatsApp UI (thread list, message history, reply box,
  provider settings) exists only under
  `apps/frontend-legacy/portal-v2-legacy/app/dashboard/whatsapp/` — that app is
  in **no compose file and no workspace entry**. Dead code. Do not mistake it
  for a shipped screen.

### 3.5 Agent side (separate, 2026-07-19)

`apps/agent/src/channels/messaging.ts` — `MessagingChannel = "sms" | "whatsapp"`,
`normalizeWhatsAppFrom()` strips the `whatsapp:` prefix. Header comment says
"reply via Twilio". Not connected to any of the above; shares only the concept.

---

## 4. WHY IT DOES NOT WORK

### 4.1 ⛔ NOTHING EVER SENDS A WHATSAPP MESSAGE

`grep -rn "graph.facebook.com\|api.twilio.com" apps/ packages/` over the whole
repo returns **zero matches**.

`POST /whatsapp/threads/:id/send` (server.ts:8103) in full:
resolve thread → resolve enabled provider → **write a `WhatsAppMessage` row** →
update the thread → audit → return. There is no network call.

```
const simulate = (process.env.WHATSAPP_SIMULATE || "true").toLowerCase() !== "false";
const status = simulate ? "SENT" : "QUEUED";
```

- Default (`WHATSAPP_SIMULATE` unset → `"true"`): the row is stamped **`SENT`**
  with `metadata: { simulated: true }` and the response says `simulated: true`.
  Nothing left the building.
- Set it to `false` and the row is stamped **`QUEUED`** — and **nothing anywhere
  in the repo dequeues or dispatches a QUEUED WhatsApp message.** It is worse
  than simulate mode, because now it silently claims to be pending forever.

⛔ **`docs/ai-support-agent/BUILD_STATUS.md:32` says "transport guarded until
Twilio creds". That is not what the code does — the transport was never
written.** Supplying credentials changes nothing. Anyone reading BUILD_STATUS
will believe this is one API key away from working. It is not.

### 4.2 Every flag is off in production

Checked 2026-08-16 in `app-api-1`, `app-worker-1`, and
`/opt/connectcomms/env/.env.platform`: **no `WHATSAPP_*` variable is set
anywhere.** So every default applies:

| Flag | Default | Effect | Read at |
|---|---|---|---|
| `WHATSAPP_WEBHOOK_ENQUEUE_ENABLED` | `false` | Webhooks **never feed the queues** | server.ts:37667, 37792 |
| `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED` | `false` | Projection to Connect Chat off | whatsappInboundJob.ts:20, whatsappProject.ts:54 |
| `WHATSAPP_SIMULATE` | `true` | Sends are fake | server.ts:7945, 8116 |
| `WHATSAPP_META_VERIFY_SIGNATURE` | `required` | ✅ safe default |server.ts (meta POST) |
| `WHATSAPP_TWILIO_VERIFY_SIGNATURE` | `required` | ✅ safe default | server.ts (twilio status) |

The two signature defaults are the right call and should stay. The other three
being off is why nothing has ever happened.

### 4.3 Zero data, ever

Live production, 2026-08-16:

```
WhatsAppProviderConfig : 0 rows
WhatsAppThread         : 0 rows
WhatsAppMessage        : 0 rows
AuditLog WHATSAPP_*    : 0 rows
```

**No tenant has ever configured WhatsApp.** There is nothing to migrate, nothing
to back-fill, and no customer expectation to protect. That is genuinely good
news — it means the drift in §5 can be fixed cleanly.

---

## 5. ⛔⛔ THE FINDING THAT MATTERS — SCHEMA DRIFT THAT WOULD CRASH IT ON DAY ONE

`packages/db/prisma/schema.prisma` declares **nine** WhatsApp models:

| Model | Line | In prod DB? |
|---|---|---|
| `WhatsAppProviderConfig` | 1796 | ✅ yes |
| `WhatsAppThread` | 1820 | ✅ yes |
| `WhatsAppMessage` | 1842 | ✅ yes |
| `WhatsAppAccount` | 1866 | ❌ **NO** |
| `WhatsAppTemplate` | 1905 | ❌ **NO** |
| `WhatsAppUsageEvent` | 1930 | ❌ **NO** |
| `WhatsAppPricingRate` | 1969 | ❌ **NO** |
| `WhatsAppContactPreference` | 1983 | ❌ **NO** |
| `WhatsAppPolicyAuditEvent` | 2002 | ❌ **NO** |

and `enum ConnectChatThreadType` at line 4192 lists `SMS, DM, GROUP,
TENANT_GROUP, WHATSAPP`.

**Production's enum is `SMS, DM, GROUP, TENANT_GROUP`. There is no `WHATSAPP`.**

⛔ **There is no migration for ANY of the six missing models, and none for the
enum value.** `grep -rln "WhatsApp\|WHATSAPP" packages/db/prisma/migrations/`
returns five files, none of which create them. `prisma migrate deploy` will
therefore never create them. The schema commit (`ee78362c`) added models and
skipped the migration entirely.

### How this was proven (not inferred)

The first exploratory query of this audit was
`db.connectChatThread.count({ where: { type: "WHATSAPP" } })`. Postgres answered:

```
ConnectorError ... code: "22P02",
message: "invalid input value for enum \"ConnectChatThreadType\": \"WHATSAPP\""
```

Then directly:

```sql
select enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
where t.typname='ConnectChatThreadType' order by e.enumsortorder;
-- SMS, DM, GROUP, TENANT_GROUP
```

```sql
select table_name from information_schema.tables
where table_schema='public' and table_name ilike '%whatsapp%';
-- WhatsAppMessage, WhatsAppProviderConfig, WhatsAppThread
```

### Why this is a live landmine, not a cosmetic gap

`apps/worker/src/whatsappProject.ts:66-76` creates the thread like this:

```ts
thread = await db.connectChatThread.create({
  data: {
    tenantId: ev.tenantId,
    // Temporary until generated Prisma client includes WhatsApp chat fields from schema commit ee78362...
    type: "WHATSAPP" as any,
    ...
```

The author hit the type error, **cast it away with `as any`, and left a comment
saying it was temporary until the client caught up.** The client never caught up
because the migration was never written. The same `as any` pattern is repeated
twice more in that file for the `externalProvider` / `externalMessageId` fields
(those two happen to be fine — the columns do exist).

⛔ **Consequence: the moment anyone sets
`WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=true`, the first real inbound message
throws `22P02` on the thread insert** — the job fails, BullMQ retries it, it
fails again. And `wa_project_verify.ts` **cannot catch this**, because line 47
forces the flag to `"false"`, so the harness never reaches the DB write it is
nominally verifying.

⛔ **Do not turn that flag on until the migration exists.** It is a one-line
`ALTER TYPE "ConnectChatThreadType" ADD VALUE 'WHATSAPP';` plus a decision about
the six orphan models (see §6).

---

## 6. WHAT IS ACTUALLY LEFT TO BUILD

Roughly in dependency order. Items 1–2 are prerequisites for anything else.

1. **The migration.** `ALTER TYPE ... ADD VALUE 'WHATSAPP'` at minimum. Then a
   decision on the six orphan models: either write the migration that creates
   them, or **delete them from `schema.prisma`** until they are needed. Leaving
   declared-but-unmigrated models in the schema is how this trap was set. Note
   `ADD VALUE` cannot run inside a transaction block in older Postgres — check
   the version before writing it.
2. **The outbound transport.** A provider adapter that actually POSTs to Meta
   Graph / Twilio, plus a dispatcher for `QUEUED` rows, plus retry/failure
   handling. This is the largest single piece and it does not exist at all.
3. **Status application.** `whatsappStatusJob.ts` currently logs and acks;
   it needs to apply DELIVERED/FAILED to the message rows.
4. **The portal inbox.** The 17-line stub needs to become a real screen — or
   WhatsApp threads need to surface inside `/chat`, which is what the
   ARCHITECTURE.md "Option A" design actually calls for.
5. **Media.** Inbound media is a placeholder string `"[whatsapp media]"`; the
   docs describe downloading to Connect storage + `ConnectChatMessageAttachment`
   with signed URLs. Not started.
6. **Compliance layer** (all docs-only today): 24-hour customer-service window
   enforcement, approved-template send outside it, opt-in/opt-out tracking,
   `WhatsAppPolicyAuditEvent` writes. ⛔ **A production WhatsApp integration that
   free-form-sends outside the 24h window gets the number quality-rated down and
   eventually blocked by Meta.** This is not optional polish.
7. **Webhook tenant lookup** — replace the decrypt-every-row linear scan with an
   indexed column before any real traffic.
8. **Wire the three verify scripts into CI**, and un-force the flag in
   `wa_project_verify.ts` so it can actually exercise the projection.

---

## 7. Traps for the next session

- ⛔ **`BUILD_STATUS.md` says the WhatsApp channel is "✅ live". It is not.**
  Do not quote that line to anyone.
- ⛔ **A signature-verified webhook is not a working integration.** The careful,
  well-written PR1 security work makes this feature *look* much further along
  than it is on a code skim. Check the transport and the flags before believing
  a messaging feature is live — same family as the two IVR publish paths and the
  dead `KnowledgeBase`.
- ⛔ **`apps/frontend-legacy/portal-v2-legacy/**` has a complete-looking WhatsApp
  ops dashboard. It is not deployed and not in the workspace.** Do not read it
  as evidence of a shipped UI.
- ⛔ **`as any` in `whatsappProject.ts` is hiding a real production failure**, not
  a Prisma-client staleness issue. Three casts in that file; the `type:
  "WHATSAPP"` one is the fatal one.
- ⛔ **`API_ROUTES.md`'s WhatsApp line numbers are ~2,200 lines stale.** Grep for
  the route string, don't trust the number.
- ✅ **Zero rows everywhere means there is no customer risk and no back-fill
  burden** — whatever gets decided, it can be done cleanly.
