# Push Notifications (Expo + TrimPro)

## Overview

TrimPro now supports device push notifications and in-app notifications together.

- Push transport: Expo Push Service (`expo-notifications`)
- Device token storage: `user_push_devices`
- In-app notifications: `notifications` table and mobile notifications screen
- Source of truth for event generation: backend notification service (`lib/notifications.ts`)

## Mobile Flow

On login/app startup:

1. Request notification permission
2. Configure Android channel `trimpro-default`
3. Fetch Expo token using EAS `projectId`
4. Register token with backend:
   - `POST /api/mobile/push/register`

On logout:

- `POST /api/mobile/push/unregister`

## Backend Endpoints

- `POST /api/mobile/push/register`
- `POST /api/mobile/push/unregister`
- `GET /api/mobile/push/status`
- `POST /api/mobile/push/test` (admin/office only)
- `GET /api/mobile/notifications`
- `POST /api/mobile/notifications/read`
- `POST /api/admin/notifications/test`
- `GET /api/admin/push-devices?userId=<id>`

## Notification Data and Deep Links

Notification payload includes:

- `linkType`, `linkId`
- `deepLink` (example: `trimpro://jobs/<jobId>`)
- `traceId`

Supported deep links:

- `trimpro://jobs/<jobId>`
- `trimpro://tasks/<taskId>`
- `trimpro://issues/<issueId>`
- `trimpro://messages/<conversationId>`

## Dedupe and Rate Limits

- Dedupe key format:
  - `tenantId:userId:type:entityId:action:timeBucket`
- Unique index on `notifications.dedupeKey`
- Per-recipient rate limiting:
  - if user receives many notifications in 1 minute, payload collapses to a generic update message

## Debugging

Server logs include structured fields:

- `traceId`
- `tenantId`
- `recipientUserId`
- `tokensCount`
- Expo ticket IDs and receipt error counts

Use:

- `POST /api/admin/notifications/test` to generate a test notification and trace ID
- `GET /api/admin/push-devices?userId=...` to inspect registered devices
- Mobile Profile screen to view permission/token status and trigger re-registration

## Expo / EAS Setup

Required:

- Real device (push does not reliably validate on simulator/emulator)
- Correct EAS project ID in `app.json` (`expo.extra.eas.projectId`)
- iOS bundle identifier and Android package configured
- Android notification channel configured in app runtime

## Troubleshooting

If push does not appear:

1. Confirm permission is `granted` in mobile Profile -> Notifications
2. Confirm device exists in `GET /api/admin/push-devices?userId=...`
3. Send test push via mobile Profile (admin) or `POST /api/admin/notifications/test`
4. Check server logs for `area=push` with matching `traceId`
5. If Expo marks token as unregistered, token is auto-disabled and device must re-register
