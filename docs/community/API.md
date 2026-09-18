# Loopcom Community — API reference

Generated from source by `src/testing/generateDocs.ts` — 387 routes. Base URL: `COMMUNITY_API_URL` (local http://localhost:3101). Auth: `Authorization: Bearer <access token>` (15-minute JWT from /auth/login or /auth/refresh). Every error body is `{ error, message }` with a human sentence. Mutations accept `Idempotency-Key`. Lists page with `?cursor=&limit=`.

| Auth | Meaning |
|---|---|
| public | no token needed |
| signed-in | any Loopcom ID |
| staff | StaffGrant MODERATOR/ADMIN |

## app.ts (1)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/health` | public | app.ts |

## auth (31)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/auth/passkeys` | signed-in | auth/passkeys.ts |
| DELETE | `/auth/passkeys/:id` | signed-in | auth/passkeys.ts |
| POST | `/auth/passkeys/login/options` | public | auth/passkeys.ts |
| POST | `/auth/passkeys/login/verify` | public | auth/passkeys.ts |
| POST | `/auth/passkeys/register/options` | signed-in | auth/passkeys.ts |
| POST | `/auth/passkeys/register/verify` | signed-in | auth/passkeys.ts |
| POST | `/auth/deactivate` | signed-in | auth/routes.ts |
| POST | `/auth/delete` | signed-in | auth/routes.ts |
| GET | `/auth/export` | signed-in | auth/routes.ts |
| POST | `/auth/link/loopcom` | signed-in | auth/routes.ts |
| DELETE | `/auth/link/loopcom` | signed-in | auth/routes.ts |
| POST | `/auth/login` | public | auth/routes.ts |
| POST | `/auth/logout` | signed-in | auth/routes.ts |
| POST | `/auth/logout-all` | signed-in | auth/routes.ts |
| POST | `/auth/loopcom` | public | auth/routes.ts |
| GET | `/auth/me` | signed-in | auth/routes.ts |
| POST | `/auth/mfa/totp/disable` | signed-in | auth/routes.ts |
| POST | `/auth/mfa/totp/enable` | signed-in | auth/routes.ts |
| POST | `/auth/mfa/totp/setup` | signed-in | auth/routes.ts |
| POST | `/auth/oauth/:provider` | public | auth/routes.ts |
| POST | `/auth/password/change` | public | auth/routes.ts |
| POST | `/auth/password/forgot` | public | auth/routes.ts |
| POST | `/auth/password/reset` | public | auth/routes.ts |
| POST | `/auth/refresh` | public | auth/routes.ts |
| POST | `/auth/register` | public | auth/routes.ts |
| GET | `/auth/sessions` | signed-in | auth/routes.ts |
| DELETE | `/auth/sessions/:id` | signed-in | auth/routes.ts |
| POST | `/auth/verify/confirm` | signed-in | auth/routes.ts |
| POST | `/auth/verify/send` | signed-in | auth/routes.ts |
| GET | `/dev/last-code` | public | auth/routes.ts |
| GET | `/dev/mailbox` | public | auth/routes.ts |

## concierge (3)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/concierge/act` | signed-in | concierge/routes.ts |
| POST | `/concierge/ask` | signed-in | concierge/routes.ts |
| GET | `/concierge/status` | signed-in | concierge/routes.ts |

## core (7)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/analytics/events` | public | core/routes.ts |
| GET | `/flags` | public | core/routes.ts |
| POST | `/me/devices` | signed-in | core/routes.ts |
| DELETE | `/me/devices/:token` | signed-in | core/routes.ts |
| GET | `/me/privacy` | signed-in | core/routes.ts |
| PUT | `/me/privacy` | signed-in | core/routes.ts |
| GET | `/realtime/stream` | signed-in | core/routes.ts |

## crm (18)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/public/people/:username/vcard` | public | crm/qr.ts |
| POST | `/qr/met` | signed-in | crm/qr.ts |
| GET | `/qr/resolve` | signed-in | crm/qr.ts |
| GET | `/crm/contacts` | signed-in | crm/routes.ts |
| GET | `/crm/contacts/:personId` | signed-in | crm/routes.ts |
| GET | `/crm/export.csv` | signed-in | crm/routes.ts |
| GET | `/crm/notes` | signed-in | crm/routes.ts |
| POST | `/crm/notes` | signed-in | crm/routes.ts |
| PATCH | `/crm/notes/:id` | signed-in | crm/routes.ts |
| DELETE | `/crm/notes/:id` | signed-in | crm/routes.ts |
| GET | `/crm/pipeline` | signed-in | crm/routes.ts |
| POST | `/crm/push-to-loopcom` | signed-in | crm/routes.ts |
| GET | `/crm/reminders` | signed-in | crm/routes.ts |
| POST | `/crm/reminders` | signed-in | crm/routes.ts |
| PATCH | `/crm/reminders/:id` | signed-in | crm/routes.ts |
| DELETE | `/crm/reminders/:id` | signed-in | crm/routes.ts |
| GET | `/crm/tags` | signed-in | crm/routes.ts |
| GET | `/crm/timeline` | signed-in | crm/routes.ts |

## events (13)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/events` | signed-in | events/routes.ts |
| GET | `/events` | signed-in | events/routes.ts |
| PATCH | `/events/:id` | signed-in | events/routes.ts |
| DELETE | `/events/:id` | signed-in | events/routes.ts |
| GET | `/events/:id/attendees` | signed-in | events/routes.ts |
| GET | `/events/:id/chat` | signed-in | events/routes.ts |
| POST | `/events/:id/cover` | signed-in | events/routes.ts |
| GET | `/events/:id/ics` | signed-in | events/routes.ts |
| POST | `/events/:id/invite` | signed-in | events/routes.ts |
| POST | `/events/:id/rsvp` | signed-in | events/routes.ts |
| DELETE | `/events/:id/rsvp` | signed-in | events/routes.ts |
| GET | `/me/events` | signed-in | events/routes.ts |
| GET | `/public/events/:slug` | public | events/routes.ts |

## feed (2)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/feed` | signed-in | feed/routes.ts |
| GET | `/feed/rail` | signed-in | feed/routes.ts |

## graph (29)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/connections` | signed-in | graph/routes.ts |
| DELETE | `/connections/:id` | signed-in | graph/routes.ts |
| POST | `/connections/:id/accept` | signed-in | graph/routes.ts |
| POST | `/connections/:id/ignore` | signed-in | graph/routes.ts |
| POST | `/connections/:id/withdraw` | signed-in | graph/routes.ts |
| GET | `/connections/counts` | signed-in | graph/routes.ts |
| GET | `/connections/export.csv` | signed-in | graph/routes.ts |
| GET | `/connections/pending` | signed-in | graph/routes.ts |
| POST | `/connections/request` | signed-in | graph/routes.ts |
| GET | `/me/blocked` | signed-in | graph/routes.ts |
| GET | `/me/following` | signed-in | graph/routes.ts |
| GET | `/me/muted` | signed-in | graph/routes.ts |
| POST | `/network/match` | signed-in | graph/routes.ts |
| GET | `/network/suggestions` | signed-in | graph/routes.ts |
| POST | `/network/suggestions/:recommendationId/dismiss` | signed-in | graph/routes.ts |
| POST | `/organizations/:id/mute` | signed-in | graph/routes.ts |
| DELETE | `/organizations/:id/mute` | signed-in | graph/routes.ts |
| PUT | `/organizations/:id/relationship` | signed-in | graph/routes.ts |
| GET | `/organizations/:id/relationship` | signed-in | graph/routes.ts |
| POST | `/people/:id/block` | signed-in | graph/routes.ts |
| DELETE | `/people/:id/block` | signed-in | graph/routes.ts |
| POST | `/people/:id/follow` | signed-in | graph/routes.ts |
| DELETE | `/people/:id/follow` | signed-in | graph/routes.ts |
| POST | `/people/:id/mute` | signed-in | graph/routes.ts |
| DELETE | `/people/:id/mute` | signed-in | graph/routes.ts |
| GET | `/people/:id/mutual` | signed-in | graph/routes.ts |
| PUT | `/people/:id/relationship` | signed-in | graph/routes.ts |
| GET | `/people/:id/relationship` | signed-in | graph/routes.ts |
| POST | `/reports` | signed-in | graph/routes.ts |

## groups (24)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/groups` | signed-in | groups/routes.ts |
| GET | `/groups` | signed-in | groups/routes.ts |
| PATCH | `/groups/:id` | signed-in | groups/routes.ts |
| DELETE | `/groups/:id` | signed-in | groups/routes.ts |
| GET | `/groups/:id/chat` | signed-in | groups/routes.ts |
| POST | `/groups/:id/cover` | signed-in | groups/routes.ts |
| GET | `/groups/:id/events` | signed-in | groups/routes.ts |
| POST | `/groups/:id/files` | signed-in | groups/routes.ts |
| GET | `/groups/:id/files` | signed-in | groups/routes.ts |
| DELETE | `/groups/:id/files/:fileId` | signed-in | groups/routes.ts |
| POST | `/groups/:id/invites` | signed-in | groups/routes.ts |
| GET | `/groups/:id/jobs` | signed-in | groups/routes.ts |
| POST | `/groups/:id/join` | signed-in | groups/routes.ts |
| POST | `/groups/:id/leave` | signed-in | groups/routes.ts |
| GET | `/groups/:id/listings` | signed-in | groups/routes.ts |
| POST | `/groups/:id/logo` | signed-in | groups/routes.ts |
| GET | `/groups/:id/members` | signed-in | groups/routes.ts |
| PATCH | `/groups/:id/members/:personId` | signed-in | groups/routes.ts |
| POST | `/groups/:id/posts` | signed-in | groups/routes.ts |
| GET | `/groups/:id/posts` | signed-in | groups/routes.ts |
| POST | `/groups/:id/posts/:postId/pin` | signed-in | groups/routes.ts |
| GET | `/groups/categories` | signed-in | groups/routes.ts |
| GET | `/me/groups` | signed-in | groups/routes.ts |
| GET | `/public/groups/:slug` | public | groups/routes.ts |

## intros (9)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/intros` | signed-in | intros/routes.ts |
| GET | `/intros` | signed-in | intros/routes.ts |
| POST | `/intros/:id/approve` | signed-in | intros/routes.ts |
| POST | `/intros/:id/complete` | signed-in | intros/routes.ts |
| POST | `/intros/:id/decline` | signed-in | intros/routes.ts |
| PATCH | `/intros/:id/draft` | signed-in | intros/routes.ts |
| POST | `/intros/:id/draft/suggest` | signed-in | intros/routes.ts |
| POST | `/intros/:id/withdraw` | signed-in | intros/routes.ts |
| GET | `/intros/paths` | signed-in | intros/routes.ts |

## jobs (22)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/jobs` | signed-in | jobs/routes.ts |
| GET | `/jobs` | signed-in | jobs/routes.ts |
| PATCH | `/jobs/:id` | signed-in | jobs/routes.ts |
| DELETE | `/jobs/:id` | signed-in | jobs/routes.ts |
| GET | `/jobs/:id/analytics` | signed-in | jobs/routes.ts |
| GET | `/jobs/:id/applications` | signed-in | jobs/routes.ts |
| PATCH | `/jobs/:id/applications/:appId` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/applications/:appId/message` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/apply` | signed-in | jobs/routes.ts |
| DELETE | `/jobs/:id/apply` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/ask-referral` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/close` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/promote` | signed-in | jobs/routes.ts |
| POST | `/jobs/:id/save` | signed-in | jobs/routes.ts |
| DELETE | `/jobs/:id/save` | signed-in | jobs/routes.ts |
| GET | `/me/applications` | signed-in | jobs/routes.ts |
| POST | `/me/job-alerts` | signed-in | jobs/routes.ts |
| GET | `/me/job-alerts` | signed-in | jobs/routes.ts |
| DELETE | `/me/job-alerts/:id` | signed-in | jobs/routes.ts |
| GET | `/me/saved-jobs` | signed-in | jobs/routes.ts |
| GET | `/organizations/:id/jobs` | signed-in | jobs/routes.ts |
| GET | `/public/jobs/:id` | public | jobs/routes.ts |

## marketplace (13)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/listings` | signed-in | marketplace/routes.ts |
| GET | `/listings` | signed-in | marketplace/routes.ts |
| PATCH | `/listings/:id` | signed-in | marketplace/routes.ts |
| DELETE | `/listings/:id` | signed-in | marketplace/routes.ts |
| POST | `/listings/:id/media` | signed-in | marketplace/routes.ts |
| DELETE | `/listings/:id/media/:mid` | signed-in | marketplace/routes.ts |
| POST | `/listings/:id/message` | signed-in | marketplace/routes.ts |
| POST | `/listings/:id/save` | signed-in | marketplace/routes.ts |
| DELETE | `/listings/:id/save` | signed-in | marketplace/routes.ts |
| GET | `/marketplace/categories` | signed-in | marketplace/routes.ts |
| GET | `/me/listings` | signed-in | marketplace/routes.ts |
| GET | `/me/saved-listings` | signed-in | marketplace/routes.ts |
| GET | `/public/listings/:id` | public | marketplace/routes.ts |

## media (5)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/me/media` | signed-in | media/routes.ts |
| POST | `/media` | signed-in | media/routes.ts |
| GET | `/media/:id` | signed-in | media/routes.ts |
| DELETE | `/media/:id` | signed-in | media/routes.ts |
| GET | `/media/file/:id/:variant` | public | media/routes.ts |

## messaging (25)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/presence` | signed-in | messaging/routes.ts |
| POST | `/threads` | signed-in | messaging/routes.ts |
| GET | `/threads` | signed-in | messaging/routes.ts |
| GET | `/threads/:id` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/accept` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/archive` | signed-in | messaging/routes.ts |
| DELETE | `/threads/:id/archive` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/decline` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/leave` | signed-in | messaging/routes.ts |
| GET | `/threads/:id/messages` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/messages` | signed-in | messaging/routes.ts |
| PATCH | `/threads/:id/messages/:mid` | signed-in | messaging/routes.ts |
| DELETE | `/threads/:id/messages/:mid` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/messages/:mid/forward` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/messages/:mid/react` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/mute` | signed-in | messaging/routes.ts |
| DELETE | `/threads/:id/mute` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/participants` | signed-in | messaging/routes.ts |
| DELETE | `/threads/:id/participants/:pid` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/pin` | signed-in | messaging/routes.ts |
| DELETE | `/threads/:id/pin` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/read` | signed-in | messaging/routes.ts |
| POST | `/threads/:id/typing` | signed-in | messaging/routes.ts |
| GET | `/threads/search` | signed-in | messaging/routes.ts |
| GET | `/threads/unread-count` | signed-in | messaging/routes.ts |

## moderation (23)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/me/analytics` | signed-in | moderation/companyAnalytics.ts |
| GET | `/organizations/:id/analytics` | signed-in | moderation/companyAnalytics.ts |
| GET | `/organizations/:id/analytics/export.csv` | signed-in | moderation/companyAnalytics.ts |
| GET | `/admin/audit` | staff | moderation/routes.ts |
| GET | `/admin/content` | staff | moderation/routes.ts |
| POST | `/admin/content/remove` | staff | moderation/routes.ts |
| POST | `/admin/moderation/appeals/:id/decide` | staff | moderation/routes.ts |
| GET | `/admin/moderation/cases` | staff | moderation/routes.ts |
| GET | `/admin/moderation/cases/:id` | staff | moderation/routes.ts |
| POST | `/admin/moderation/cases/:id/action` | staff | moderation/routes.ts |
| POST | `/admin/moderation/cases/:id/assign` | staff | moderation/routes.ts |
| GET | `/admin/notifications/health` | staff | moderation/routes.ts |
| GET | `/admin/organizations` | staff | moderation/routes.ts |
| POST | `/admin/organizations/:id/status` | staff | moderation/routes.ts |
| GET | `/admin/overview` | staff | moderation/routes.ts |
| GET | `/admin/security/alerts` | staff | moderation/routes.ts |
| GET | `/admin/users` | staff | moderation/routes.ts |
| GET | `/admin/users/:id` | staff | moderation/routes.ts |
| POST | `/admin/users/:id/staff` | staff | moderation/routes.ts |
| POST | `/admin/users/:id/status` | staff | moderation/routes.ts |
| POST | `/admin/users/:id/verify-email` | staff | moderation/routes.ts |
| POST | `/appeals` | signed-in | moderation/routes.ts |
| GET | `/me/moderation` | signed-in | moderation/routes.ts |

## notifications (6)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/me/notification-prefs` | signed-in | notifications/routes.ts |
| PUT | `/me/notification-prefs` | signed-in | notifications/routes.ts |
| GET | `/notifications` | signed-in | notifications/routes.ts |
| DELETE | `/notifications/:id` | signed-in | notifications/routes.ts |
| POST | `/notifications/read` | signed-in | notifications/routes.ts |
| GET | `/notifications/unread-count` | signed-in | notifications/routes.ts |

## opportunities (11)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/opportunities` | signed-in | opportunities/routes.ts |
| GET | `/opportunities` | signed-in | opportunities/routes.ts |
| PATCH | `/opportunities/:id` | signed-in | opportunities/routes.ts |
| DELETE | `/opportunities/:id` | signed-in | opportunities/routes.ts |
| POST | `/opportunities/:id/close` | signed-in | opportunities/routes.ts |
| POST | `/opportunities/:id/interest` | signed-in | opportunities/routes.ts |
| DELETE | `/opportunities/:id/interest` | signed-in | opportunities/routes.ts |
| GET | `/opportunities/:id/interests` | signed-in | opportunities/routes.ts |
| POST | `/opportunities/:id/question` | signed-in | opportunities/routes.ts |
| GET | `/opportunities/types` | signed-in | opportunities/routes.ts |
| GET | `/public/opportunities/:id` | public | opportunities/routes.ts |

## organizations (30)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/me/organizations` | signed-in | organizations/routes.ts |
| GET | `/organizations` | signed-in | organizations/routes.ts |
| POST | `/organizations` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id` | signed-in | organizations/routes.ts |
| PATCH | `/organizations/:id` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id/audit` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id/catalog` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/catalog` | signed-in | organizations/routes.ts |
| PATCH | `/organizations/:id/catalog/:itemId` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/catalog/:itemId` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/claim-loopcom` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/claim-loopcom` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/cover` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/follow` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/follow` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id/invites` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/invites` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/invites/:inviteId` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/join` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id/locations` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/locations` | signed-in | organizations/routes.ts |
| PATCH | `/organizations/:id/locations/:locId` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/locations/:locId` | signed-in | organizations/routes.ts |
| POST | `/organizations/:id/logo` | signed-in | organizations/routes.ts |
| GET | `/organizations/:id/members` | signed-in | organizations/routes.ts |
| PATCH | `/organizations/:id/members/:personId` | signed-in | organizations/routes.ts |
| DELETE | `/organizations/:id/members/:personId` | signed-in | organizations/routes.ts |
| POST | `/organizations/invites/accept` | signed-in | organizations/routes.ts |
| GET | `/public/companies/:slug` | public | organizations/routes.ts |
| GET | `/public/stats` | public | organizations/routes.ts |

## posts (26)

| Method | Path | Auth | File |
|---|---|---|---|
| PATCH | `/comments/:id` | signed-in | posts/routes.ts |
| DELETE | `/comments/:id` | signed-in | posts/routes.ts |
| POST | `/comments/:id/react` | signed-in | posts/routes.ts |
| GET | `/me/saved` | signed-in | posts/routes.ts |
| GET | `/organizations/:id/posts` | signed-in | posts/routes.ts |
| GET | `/people/:username/posts` | signed-in | posts/routes.ts |
| POST | `/posts` | signed-in | posts/routes.ts |
| GET | `/posts/:id` | signed-in | posts/routes.ts |
| PATCH | `/posts/:id` | signed-in | posts/routes.ts |
| DELETE | `/posts/:id` | signed-in | posts/routes.ts |
| GET | `/posts/:id/analytics` | signed-in | posts/routes.ts |
| GET | `/posts/:id/comments` | signed-in | posts/routes.ts |
| POST | `/posts/:id/comments` | signed-in | posts/routes.ts |
| POST | `/posts/:id/hide` | signed-in | posts/routes.ts |
| POST | `/posts/:id/impression` | signed-in | posts/routes.ts |
| POST | `/posts/:id/poll/vote` | signed-in | posts/routes.ts |
| POST | `/posts/:id/react` | signed-in | posts/routes.ts |
| DELETE | `/posts/:id/react` | signed-in | posts/routes.ts |
| POST | `/posts/:id/repost` | signed-in | posts/routes.ts |
| POST | `/posts/:id/save` | signed-in | posts/routes.ts |
| DELETE | `/posts/:id/save` | signed-in | posts/routes.ts |
| POST | `/posts/preview` | signed-in | posts/routes.ts |
| GET | `/public/organizations/:id/posts` | public | posts/routes.ts |
| GET | `/public/people/:username/posts` | public | posts/routes.ts |
| GET | `/public/posts/:id` | public | posts/routes.ts |
| GET | `/public/posts/:id/comments` | public | posts/routes.ts |

## profiles (33)

| Method | Path | Auth | File |
|---|---|---|---|
| POST | `/me/avatar` | signed-in | profiles/routes.ts |
| POST | `/me/cover` | signed-in | profiles/routes.ts |
| POST | `/me/onboarding/done` | signed-in | profiles/routes.ts |
| GET | `/me/profile` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile` | signed-in | profiles/routes.ts |
| POST | `/me/profile/certifications` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile/certifications/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/profile/certifications/:id` | signed-in | profiles/routes.ts |
| POST | `/me/profile/educations` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile/educations/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/profile/educations/:id` | signed-in | profiles/routes.ts |
| POST | `/me/profile/experiences` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile/experiences/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/profile/experiences/:id` | signed-in | profiles/routes.ts |
| POST | `/me/profile/portfolio` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile/portfolio/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/profile/portfolio/:id` | signed-in | profiles/routes.ts |
| GET | `/me/profile/preferences` | signed-in | profiles/routes.ts |
| PUT | `/me/profile/preferences` | signed-in | profiles/routes.ts |
| POST | `/me/profile/services` | signed-in | profiles/routes.ts |
| PATCH | `/me/profile/services/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/profile/services/:id` | signed-in | profiles/routes.ts |
| DELETE | `/me/recommendations/:id` | signed-in | profiles/routes.ts |
| POST | `/me/recommendations/:id/accept` | signed-in | profiles/routes.ts |
| POST | `/me/recommendations/:id/reject` | signed-in | profiles/routes.ts |
| PATCH | `/me/username` | signed-in | profiles/routes.ts |
| POST | `/people/:id/endorse` | signed-in | profiles/routes.ts |
| DELETE | `/people/:id/endorse` | signed-in | profiles/routes.ts |
| POST | `/people/:id/recommendations` | signed-in | profiles/routes.ts |
| GET | `/people/:username/activity` | signed-in | profiles/routes.ts |
| GET | `/people/:username/also-viewed` | signed-in | profiles/routes.ts |
| GET | `/people/:username/recommendations` | signed-in | profiles/routes.ts |
| GET | `/public/people/:username` | public | profiles/routes.ts |

## recommendations (17)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/admin/experiments` | staff | recommendations/routes.ts |
| POST | `/admin/experiments` | staff | recommendations/routes.ts |
| PATCH | `/admin/experiments/:id` | staff | recommendations/routes.ts |
| GET | `/admin/experiments/:id/results` | staff | recommendations/routes.ts |
| GET | `/admin/flags` | staff | recommendations/routes.ts |
| PUT | `/admin/flags/:key` | staff | recommendations/routes.ts |
| GET | `/experiments/active` | signed-in | recommendations/routes.ts |
| POST | `/recommendations/:impressionId/dismiss` | signed-in | recommendations/routes.ts |
| POST | `/recommendations/:impressionId/outcome` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/candidates` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/customers` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/events` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/explain/:impressionId` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/groups` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/jobs` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/organizations` | signed-in | recommendations/routes.ts |
| GET | `/recommendations/vendors` | signed-in | recommendations/routes.ts |

## rfq (23)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/public/rfq/:id` | public | rfq/routes.ts |
| GET | `/public/rfqs` | public | rfq/routes.ts |
| POST | `/rfq` | signed-in | rfq/routes.ts |
| GET | `/rfq` | signed-in | rfq/routes.ts |
| GET | `/rfq/:id` | signed-in | rfq/routes.ts |
| PATCH | `/rfq/:id` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/cancel` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/close` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/confirm-extraction` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/decline` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/questions` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/questions/:qid/answer` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes` | signed-in | rfq/routes.ts |
| PATCH | `/rfq/:id/quotes/:qid` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes/:qid/accept` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes/:qid/decline` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes/:qid/shortlist` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes/:qid/thread` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/quotes/:qid/withdraw` | signed-in | rfq/routes.ts |
| POST | `/rfq/:id/view` | signed-in | rfq/routes.ts |
| GET | `/rfq/categories` | signed-in | rfq/routes.ts |
| GET | `/rfq/inbox` | signed-in | rfq/routes.ts |
| POST | `/rfq/preview` | signed-in | rfq/routes.ts |

## search (9)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/search` | public | search/routes.ts |
| POST | `/search/click` | public | search/routes.ts |
| GET | `/search/recent` | public | search/routes.ts |
| DELETE | `/search/recent` | public | search/routes.ts |
| GET | `/search/saved` | public | search/routes.ts |
| POST | `/search/saved` | public | search/routes.ts |
| PATCH | `/search/saved/:id` | public | search/routes.ts |
| DELETE | `/search/saved/:id` | public | search/routes.ts |
| GET | `/search/suggest` | public | search/routes.ts |

## verification (7)

| Method | Path | Auth | File |
|---|---|---|---|
| GET | `/admin/verifications` | staff | verification/routes.ts |
| POST | `/admin/verifications/:id/decide` | staff | verification/routes.ts |
| GET | `/me/verifications` | signed-in | verification/routes.ts |
| POST | `/me/verifications` | signed-in | verification/routes.ts |
| GET | `/organizations/:id/verifications` | signed-in | verification/routes.ts |
| POST | `/organizations/:id/verifications` | signed-in | verification/routes.ts |
| POST | `/organizations/:id/verifications/:vid/recheck` | signed-in | verification/routes.ts |

