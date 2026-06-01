# Connect Architecture — Unified Chat (SMS + DM) foundation (2026-05-24)

Scope: Connect Chat system (threads, messages, attachments, push) across API and mobile. Telephony call flows are out of scope.

Key decisions
- Unified Connect Chat is the source of truth (Option A).
- `ConnectChatThread.type` remains authoritative for channels: `SMS | DM | GROUP | TENANT_GROUP` today; future `WHATSAPP` will be added as a first-class value (no parallel inbox).
- One message shape (`ConnectChatMessage`) projects every channel. Attachments, reactions, replies, delivery status, and signed media URLs are shared across channels.

Data model (packages/db/prisma/schema.prisma)
- `ConnectChatThread`
  - SMS fields: `tenantSmsE164`, `externalSmsE164`, `smsInboxOwnerUserId`.
  - Stable `dedupeKey`: `sms:{tenant}:{tenantE164}:{externalE164}:{inboxScope}` for SMS; DM/group-specific keys for internal threads.
  - **Shared tenant SMS inbox:** `TenantSmsNumber` with `tenantId` set and both `assignedUserId` and `assignedExtensionId` null → `inboxScope=""` / `smsInboxOwnerUserId=""`. Inbound (worker poll + webhook) and outbound-first thread creation use the same participant fan-out.
  - **Personal SMS inbox:** number assigned to a user **or** extension with an owner → `inboxScope=<ownerUserId>`. Only that user (+ extension participant row when applicable) is added.
  - **Misconfigured extension:** extension assigned but `ownerUserId` is null → treated as shared tenant inbox (same as no extension). Kept for backward compatibility; assign an owner or clear the extension to make intent explicit.
  - Indexed by `(tenantId,lastMessageAt)` and `(tenantSmsE164,externalSmsE164)`.
- `ConnectChatParticipant`
  - `participantKey` = `u:<userId>` or `e:<extensionId>`; `lastReadAt`, `typingUntil`, `muted`.
- `ConnectChatMessage`
  - `direction` = `INBOUND | OUTBOUND | INTERNAL`, `type` = `TEXT | IMAGE | VIDEO | AUDIO | VOICE_NOTE | FILE | LOCATION | SYSTEM`.
  - Attachments, reactions, replies, soft-delete (`deletedForEveryoneAt`, `deletedForUserIds`), delivery status/error.
- `ConnectChatMessageAttachment`
  - `mediaKind` classifier, optional `durationMs/width/height` for better UI sizing; signed download URLs built from storage key.

API (apps/api/src/connectChatRoutes.ts)
- Threads
  - `GET /chat/threads`: cheap self-heal for the tenant default group (create-if-missing + upsert current user only). Returns unified list (DM/group/SMS) with last-message preview and unread count.
  - Unread aggregation avoids N+1: one grouped SQL count over visible threads for the requesting user.
- Messages
  - `GET /chat/threads/:threadId/messages` default unchanged (oldest-first, up to 200). New query params:
    - `?before=<ISO>`: page older messages (server fetches DESC and normalizes to ASC in response).
    - `?after=<ISO>` / `?since=<ISO>`: return only messages strictly after timestamp (ASC).
    - `?limit=<1..200>`: cap 200.
  - Filters soft-deleted-for-user rows; includes attachments, reactions, reply snapshot, and typed sender name.
- Send
  - Internal (DM/GROUP): `direction: INTERNAL`, immediate `deliveryStatus: "sent"`.
  - SMS: queues through worker with `deliveryStatus: "queued"`. If an attachment requires link fallback (non-MMS DID), missing `PUBLIC_API_BASE_URL` returns `400 MEDIA_LINK_BASE_UNAVAILABLE` so clients can surface guidance.
- Attachments
  - `POST /chat/threads/:id/attachments/upload` stores bytes via shared storage (`local` or `S3/R2`), classifies `mediaKind`, may populate `durationMs/width/height`.
  - Downloads signed: `GET /chat/a/:attachmentId` and `GET /chat/attachments/download/*` (HMAC-verified).
- Push
  - DM: payload type `dm_message` (senderName + preview); SMS inbound: `sms_message` (phone + preview). Mobile suppresses foreground banners when viewing the same thread.

SMS shared inbox (2026-05-31)
- **Participant fan-out (shared inbox only):** users with portal permission `can_send_sms` and/or `can_view_tenant_chats` (role snapshot + custom roles loaded once per upsert). Implemented in `apps/api/src/smsInboxParticipants.ts` and mirrored in `apps/worker/src/smsInboxParticipants.ts`.
- **Send permission:** SMS send routes accept legacy JWT roles (`USER`, `ADMIN`, `MESSAGING`, …) **or** portal `can_send_sms` (union for backward compatibility).
- **Read vs reply:** `can_view_tenant_chats` allows reading tenant-wide threads without a participant row. Replying to a **shared** SMS thread auto-adds the sender as participant when they have send permission; view-only users receive `403 SMS_VIEW_ONLY`. Personal SMS threads still require an existing participant row.
- **Portal UI:** VoIP.ms assignment “shared tenant inbox” (no extension); chat thread list/header badges `Shared SMS` / `Personal SMS`.
- **Pure helpers:** `packages/shared/src/smsInbox.ts` (`resolveSmsInboxScope`, `buildSmsDedupeKey`, eligibility checks).

CRM SMS unification (2026-05-31)
- CRM contact workspace SMS uses the same `ConnectChatThread` / `ConnectChatMessage` runtime path as regular SMS. `/crm/contacts/:id/sms` is a CRM-guarded wrapper that resolves the contact phone, creates/reuses the normal SMS thread, and queues the normal Connect Chat SMS message; it does not call Twilio/VoIP.ms directly.
- The CRM SMS panel reads messages from the matching Connect Chat SMS thread. CRM timeline SMS events remain optional mirrors for activity history, not a second message store.
- Chat thread list decoration is viewer-specific: `CRM SMS` badge and contact/company title are returned only when CRM is enabled and the viewer has CRM/contact access to exactly one matching contact. Ambiguous or unauthorized matches fall back to phone-only SMS labels.

Portal chat shell reliability (2026-05-31)
- `/chat` is a bounded split-pane shell: left thread list, conversation header, message list, and composer are separate layout regions. On desktop the page itself should not become the chat scroll container; `.cc-thread-list` and `.cc-message-list` own scrolling.
- Background refreshes preserve the selected thread and merge messages by ID instead of blanking or replacing the visible message tree unnecessarily.
- Scroll behavior is user-position aware: initial thread open, manual refresh, and user send scroll to the newest message; inbound/background messages only auto-scroll when the viewer is already near the bottom.
- Media rendering remains on the shared signed attachment URLs. Portal presentation caps thumbnails/video size and renders audio/voice notes as compact chat media without changing attachment security or tenant scoping.

Mobile (apps/mobile)
- `ChatTab.tsx`
  - Conversation list uses server-provided `unread` values.
  - Message list remains chronological; adds keyboard polish (`keyboardShouldPersistTaps`, `keyboardDismissMode`).
  - Composer: voice-note with slide-to-cancel; retries re-upload local files; inline danger banner when `MEDIA_LINK_BASE_UNAVAILABLE` is returned on SMS media.
- Client API (`api/client.ts`)
  - `getMessages(token, threadId, { before|after|since|limit })` maps to new server query params (default behavior unchanged).
- Types (`types/index.ts`)
  - Adds `"WHATSAPP"` to `ChatThreadType` as a non-breaking future-proofing step (no runtime behavior change in this phase).

WhatsApp — roadmap and guardrails (docs-only, Option A)
- First-class inside Connect Chat
  - `ConnectChatThread.type = "WHATSAPP"` — no parallel inbox and no long‑term API aggregation layer.
  - One message shape (`ConnectChatMessage`) across SMS/DM/WA (attachments, reactions, replies, delivery/read surfaces, signed media URLs).
- Data-model foundation added (no runtime yet)
  - Unified message extensions: `externalProvider`, `externalMessageId`, `externalConversationId`, `providerStatus`, `providerMetadata`, `deliveredAt` + indexes for reconciliation.
  - Identities: `WhatsAppAccount` (tenant or user-owned later) with lifecycle/verification/webhook fields and provider linkage (via `WhatsAppProviderConfig`).
  - Billing/usage: `WhatsAppUsageEvent` (minor units), `WhatsAppPricingRate`.
  - Templates: `WhatsAppTemplate` (account-required uniqueness).
  - Compliance/audit: `WhatsAppContactPreference`, `WhatsAppPolicyAuditEvent`.

PR1 (ingest skeleton; safe by default)
- Signature verification required by default:
  - `WHATSAPP_META_VERIFY_SIGNATURE=required` (route-scoped raw body enabled for Meta POST only)
  - `WHATSAPP_TWILIO_VERIFY_SIGNATURE=required`
- Enqueue is disabled by default: `WHATSAPP_WEBHOOK_ENQUEUE_ENABLED=false`.
- Legacy `WhatsAppThread`/`WhatsAppMessage` writes remain unchanged.
- Workers consume WhatsApp queues, but PR1 handlers only log sanitized summaries and ack (no projection/media/push).

PR2 (inbound projection; still safe by default)
- Projection flag off by default: `WHATSAPP_PROJECT_TO_CONNECT_CHAT_ENABLED=false`.
- Inbound messages project to `ConnectChatThread`/`ConnectChatMessage`:
  - Thread dedupe: `wa:{tenantId}:{accountKey}:{contactE164}` (Meta accountKey=phoneNumberId; Twilio=to E164 fallback accountRef).
  - Message idempotency:
    - Use `(tenantId, externalProvider, externalMessageId)` when present.
    - If externalMessageId is missing, store deterministic `fallback:<sha256(provider|tenant|accountRef|from|to|timestamp|bodyHash))>` into `externalMessageId`.
  - Participants: tenant-wide membership added (same minimal visibility behavior as SMS inbound path).
  - Media: placeholder only (no download yet).
- Provider/config and data migration
  - Keep `WhatsAppProviderConfig` as the credential/config store (encrypted at rest).
  - Existing `WhatsAppThread`/`WhatsAppMessage` become migration/backfill/source tables only — not the runtime source of truth once WA is unified under `ConnectChat*`.
- Compliance guardrails
  - Official providers only (Meta Business API, Twilio WhatsApp).
  - Customer opt‑in tracking and opt‑out/block handling at the platform layer (tenant‑scoped).
  - Enforce the 24‑hour customer‑service window; require approved templates outside the window.
  - Quality/risk monitoring with provider health and error‑rate signals.
  - No unsupported Status/Stories API automation.
  - Backend‑only sends through a policy guard; mobile/web must never call Meta/Twilio directly.
- Templates (docs-only roadmap)
  - Admin endpoints to sync/list approved templates per tenant; template ownership is tenant‑scoped.
  - Validate variables/placeholders at send time; store approval status and rejection reasons.
  - When outside the 24‑hour window, template send is required (free‑form blocked by policy).
- Profile / business identity (docs-only roadmap)
  - Tenant‑wide WhatsApp identity (admin‑managed number/profile). Optional user‑owned identities later.
  - Permission model: tenant admins manage the tenant‑wide number; owning user/admins manage user‑owned numbers. Profile photo/business info updates respect these roles.
- Billing/usage (docs-only roadmap)
  - Immutable `WhatsAppUsageEvent` ledger for every billable session/template category, with provider cost tracking and markup rules.
  - Pricing table by country/category/effective date (audited), invoice integration, usage dashboard, spend alerts/limits.
  - Webhook/status reconciliation and exact audit trail from provider message id → message row → ledger → invoice.
- Media (docs-only roadmap)
  - Support: text, images, video, voice notes/audio, PDFs, office docs, location, contacts.
  - Inbound media is downloaded immediately to Connect storage (local/S3/R2) and served only via signed URLs. Provider media links are never exposed directly in UI.
- Hybrid app coexistence (docs-only)
  - Modes: Connect‑only; WhatsApp Business app‑only; Hybrid when the provider supports coexistence.
  - Connect must accept external‑originated messages/statuses via webhooks and merge them into the same unified thread.
- Delivery/read/typing
  - Map provider delivery/read events to `ConnectChatMessage.deliveryStatus`/`deliveredAt`/`readAt` where applicable. Typing outbound is optional/deferred and must not block first ship.
- Push
  - Plan a `wa_message` push payload aligned with `dm_message` / `sms_message`.

Operational notes
- The default-group self-heal runs on thread list only to avoid boot-time surprises; it is now a cheap, idempotent call.
- Message deltas enable lighter polling without websockets and reduce battery/CPU on mobile.
- SMS media link fallback returns a specific error when `PUBLIC_API_BASE_URL` is missing; clients must block the send with guidance rather than retrying blindly.
