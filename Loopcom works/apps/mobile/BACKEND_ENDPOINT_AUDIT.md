# TrimPro Field Mobile Endpoint Audit

This is the current API coverage for `apps/mobile`.

## Existing and wired now

- `POST /api/auth/login` - exists, used by mobile login.
- `GET /api/mobile/jobs` - exists, used by Jobs list.
- `GET /api/mobile/jobs/:id` - exists, used by Job detail.
- `POST /api/mobile/jobs/:id/status` - exists, used by field status updates.
- `POST /api/mobile/jobs/:id/note` - exists, used by internal notes.
- `POST /api/mobile/location` - exists, used by optional location ping.
- `GET /api/tasks?filter=assigned` - exists, used by Tasks screen.
- `PUT /api/tasks/:id` - exists, used for "mark complete" in scaffold.
- `GET /api/issues?filter=assigned` - exists, used by Issues screen.
- `PUT /api/issues/:id` - exists, used for issue escalation in scaffold.
- `GET /api/schedules?view=week&userId=:id` - exists, used by Schedule.
- `GET /api/messages/conversations?assigned=me` - exists, used by Messages list.
- `GET /api/mobile/team-chat` - added, returns tenant team-chat conversation + messages.
- `POST /api/mobile/team-chat` - added, sends internal team-chat message (+media metadata) and triggers notifications/push.
- `GET /api/mobile/team-chat?summary=1&markRead=0` - added, returns unread summary for Team Chat badge.
- `POST /api/leads` - exists, used by field Request creation.
- `GET /api/calls` - exists, used by Calls recents.
- `POST /api/uploads` - exists, used for media binary upload.
- `POST /api/attachments` - exists, used to attach uploaded media to jobs.
- `GET /api/attachments?entityType=job&entityId=:id` - exists, used in job gallery.
- `GET /api/attachments?entityType=task|issue&entityId=:id` - now supported and wired for task/issue details.
- `GET /api/mobile/assignments` - added in this change (combined jobs/tasks/issues feed).
- `POST /api/mobile/push-token` - added in this change (register Expo push token against user permissions JSON).
- Expo push fanout from notification service - added (`lib/services/mobile-push.ts`) and wired in `lib/notifications.ts`.

## Exists, but not yet wired in mobile UI

- `GET /api/messages/conversations/:id` - fetch full thread.
- `POST /api/messages/send` - send message text/media metadata.
- `POST /api/calls` - write call activity records.
- `POST /api/issues` - create issue from job context.
- `GET /api/tasks/:id`, `GET /api/issues/:id` - detail screens.
- `GET /api/notifications`, `GET /api/notifications/stream` - can support assignment/message notification feed.

## Gaps / recommended next endpoints

- Push delivery worker queue:
  - Expo push fanout is implemented inline. For high volume, move to queued background worker.
- Mobile-specific assignment delta feed:
  - current polling works; add cursor-based `/api/mobile/assignments?since=...` for lower payload.
- Upload resume/chunking endpoint:
  - current upload + outbox retry works, but large video resumable upload could be improved.
- Mobile message thread endpoint with pagination:
  - current conversation detail can become heavy for long threads.

