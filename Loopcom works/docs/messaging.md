# Messaging System (Team Chat + Direct Messages)

This document describes the internal chat system used by web and mobile.

## Scope

- Team Chat is pinned first in conversation lists.
- Direct Messages are one-to-one between tenant users.
- Messages support text, file/media attachments, voice notes, and location.
- Job-context stamping is supported (`jobId`, `jobNumber`, `jobName`).
- Tenant isolation is enforced at API and data query layers.

## Data Model

Core tables:

- `chat_conversations`
- `chat_conversation_members`
- `chat_messages`
- `chat_message_attachments`

Enums:

- `ChatConversationType` (`TEAM`, `DM`, `JOB_THREAD`)
- `ChatMessageType` (`TEXT`, `MEDIA`, `VOICE`, `LOCATION`, `SYSTEM`)
- `ChatDeliveryStatus` (`SENT`, `DELIVERED`, `READ`)
- `ChatAttachmentKind` (`IMAGE`, `VIDEO`, `FILE`, `VOICE`, `LOCATION`)

Migration:

- `prisma/migrations/0009_chat_messaging_core/migration.sql`

## API Endpoints

- `GET /api/messages/conversations`
- `GET /api/messages/conversations/:id`
- `GET /api/messages/conversations/:id/messages`
- `POST /api/messages/conversations/:id/messages`
- `POST /api/messages/conversations/:id/read`
- `POST /api/messages/team/ensure`
- `POST /api/messages/dm`
- `POST /api/messages/job/ensure` (find/create the JOB_THREAD for a job)
- `GET /api/messages/users`
- `POST /api/uploads/messages`
- `GET /api/messages/stream` (SSE)
- `GET /api/jobs/:id/unread` (unread message + note counts for a job)

## Job Threads

- `ChatConversation.jobId` links a `JOB_THREAD` conversation to its job (unique per tenant+job).
- `ensureJobThread(tenantId, jobId, actorUserId)` in `lib/chat/service.ts` finds or creates the thread and
  syncs membership to: the job's current assignees, the actor, and active ADMIN/OFFICE users (capped).
- Unread counts use `ChatConversationMember.lastReadAt` (real read receipts). Note unread counts on the
  job detail page are an MVP approximation using a `job-notes-last-viewed-<jobId>` timestamp in
  `localStorage` (web) / should use `AsyncStorage` (mobile) — no server-side read-state table yet.

## Realtime

- Web uses `EventSource` against `/api/messages/stream`.
- Stream emits:
  - `hello`
  - `new_message`
  - `ping`
  - `error`

## Mobile Notes

- Conversation list uses Team + DM endpoints.
- Thread supports media picker, voice (press/hold), location share, and job stamp.
- Offline sending queues outgoing chat payloads via the existing outbox.

## Security

- Every message and attachment is tenant-scoped.
- Membership is checked before listing or sending messages.
- DM creation validates target user belongs to same tenant.

## Test Checklist

1. Team Chat appears first and stays pinned.
2. Start DM from user dropdown.
3. Send text and confirm checkmark in sender bubble.
4. Send image/video/file and open from both web and mobile.
5. Hold mic to record voice, release to send.
6. Share location and open in maps.
7. Send from Job detail and verify job stamp + deep link.
8. Confirm push notification payload points to conversation deep link.
9. Verify no data leaks across tenants.
10. Disable network on mobile, send message, reconnect, and verify queue flush.
