# ⛔ AGENT HANDOFF — the WhatsApp integration cannot send, and its projection path would CRASH on day one (2026-08-16) — READ FIRST before any WhatsApp work, before quoting BUILD_STATUS's "✅ live", or before flipping any `WHATSAPP_*` flag

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_WHATSAPP_AUDIT_2026-08-16.md`**
(**Read-only audit — no code change, no migration, no deploy, no flag flipped.**)

- ⛔ **THE RULE: a signature-verified webhook is not a working integration.**
  The PR1 security work is careful and real — Meta HMAC-SHA256 + Twilio
  HMAC-SHA1, both **required by default**, raw-body scoped to the Meta POST,
  encrypted per-tenant credentials, masked responses. That makes the feature
  *look* far more finished than it is on a code skim. **Check the transport and
  the flags before believing a messaging feature is live** — same family as the
  two IVR publish paths and the dead `KnowledgeBase`.
- ⛔ **NOTHING EVER SENDS A WHATSAPP MESSAGE.** `grep -rn
  "graph.facebook.com\|api.twilio.com" apps/ packages/` returns **zero
  matches** repo-wide. `POST /whatsapp/threads/:id/send` (`server.ts:8103`)
  writes a `WhatsAppMessage` row and returns — no network call. `WHATSAPP_SIMULATE`
  defaults **true** → row stamped `SENT`, `simulated: true`. Set it to `false`
  and the row is stamped **`QUEUED`** — and **nothing dequeues or dispatches a
  QUEUED row**, which is worse: it claims pending forever.
  ⛔ **`docs/ai-support-agent/BUILD_STATUS.md:32` says "SMS/WhatsApp channel ✅
  live | transport guarded until Twilio creds". That is WRONG — the transport
  was never written.** Adding credentials changes nothing. Do not quote it.
- ⛔⛔ **SCHEMA DRIFT THAT WOULD CRASH IT ON DAY ONE.** `schema.prisma` declares
  **9** WhatsApp models and `ConnectChatThreadType.WHATSAPP`; **production has
  3 tables** (`WhatsAppProviderConfig`/`Thread`/`Message`) and its enum is still
  `SMS, DM, GROUP, TENANT_GROUP`. **No migration exists for the other six models
  OR the enum value** — so `prisma migrate deploy` will never create them.
  Proven, not inferred: `connectChatThread.count({where:{type:"WHATSAPP"}})`
  answered `22P02 invalid input value for enum "ConnectChatThreadType":
  "WHATSAPP"`. And `whatsappProject.ts:70` creates threads with **`type:
  "WHATSAPP" as any`** under a comment calling it "temporary until the generated
  Prisma client catches up" — it never did, because the migration was skipped.
  ⛔ **Set `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=true` today and the first
  real inbound message throws on the thread insert and retry-loops.**
  ⛔ `wa_project_verify.ts` **cannot catch this — line 47 forces the flag to
  `"false"`**, so the harness never reaches the write it nominally verifies.
- **Every flag is off in prod** (none set in `app-api-1`, `app-worker-1`, or
  `.env.platform`, so defaults rule): `WHATSAPP_WEBHOOK_ENQUEUE_ENABLED=false`
  (webhooks never feed the queues), `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=false`,
  `WHATSAPP_SIMULATE=true`. The two signature flags default `required` — ✅ keep
  that. `whatsappStatusJob.ts` **logs a summary and acks; that is the entire
  handler** — delivery statuses are applied to nothing.
- ✅ **Zero data, ever: 0 provider configs, 0 threads, 0 messages, 0
  `WHATSAPP_*` AuditLog rows** platform-wide. No tenant has ever configured it,
  so there is no customer risk and no back-fill burden — the drift can be fixed
  cleanly. Audit actions that exist in code but have never fired:
  `WHATSAPP_CREDENTIAL_CREATED/UPDATED/ENABLED/DISABLED`,
  `WHATSAPP_TEST_SEND_SIMULATED/DISPATCHED`, `WHATSAPP_REPLY_SENT`.
  The compliance table `WhatsAppPolicyAuditEvent` is **not in the prod DB**.
- ⛔ **`apps/frontend-legacy/portal-v2-legacy/app/dashboard/whatsapp/` has a
  complete-looking inbox UI and is in NO compose file and NO workspace entry.**
  Dead code — never read it as a shipped screen. The live page,
  `apps/portal/app/(platform)/apps/whatsapp/page.tsx`, is **17 lines**: a
  heading and a button to `/chat`.
- ⛔ **`docs/ai-context/API_ROUTES.md`'s WhatsApp line numbers are ~2,200 lines
  stale** (cites 5752/5919; actual 7936/8103). Grep the route string.
  ⛔ Webhook tenant resolution is a **linear scan decrypting EVERY
  `WhatsAppProviderConfig` row** per request — fine at 0 rows, needs an indexed
  column before real traffic.
- **All of it landed in one evening, 2026-05-24** (`ee78362c` → `2459fbb4` →
  `10487d51`) and has not been touched since. What's left is real work, not a
  toggle: the migration, the outbound transport, status application, the portal
  inbox, media download, and the whole compliance layer (24h window + approved
  templates — ⛔ free-form sending outside that window gets the number
  quality-rated down and eventually blocked by Meta).
