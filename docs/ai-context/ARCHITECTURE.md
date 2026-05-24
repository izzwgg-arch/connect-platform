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

Mobile (apps/mobile)
- `ChatTab.tsx`
  - Conversation list uses server-provided `unread` values.
  - Message list remains chronological; adds keyboard polish (`keyboardShouldPersistTaps`, `keyboardDismissMode`).
  - Composer: voice-note with slide-to-cancel; retries re-upload local files; inline danger banner when `MEDIA_LINK_BASE_UNAVAILABLE` is returned on SMS media.
- Client API (`api/client.ts`)
  - `getMessages(token, threadId, { before|after|since|limit })` maps to new server query params (default behavior unchanged).
- Types (`types/index.ts`)
  - Adds `"WHATSAPP"` to `ChatThreadType` as a non-breaking future-proofing step (no runtime behavior change in this phase).

WhatsApp (future — not implemented in this phase)
- Target: first-class channel under `ConnectChatThread.type = "WHATSAPP"`; messages project into `ConnectChatMessage` with the same attachment/signing, reactions, replies, delivery status surface.
- Push: new `wa_message` payload aligned with `dm_message`/`sms_message`.
- No separate inbox; no aggregator route.

Operational notes
- The default-group self-heal runs on thread list only to avoid boot-time surprises; it is now a cheap, idempotent call.
- Message deltas enable lighter polling without websockets and reduce battery/CPU on mobile.
- SMS media link fallback returns a specific error when `PUBLIC_API_BASE_URL` is missing; clients must block the send with guidance rather than retrying blindly.
