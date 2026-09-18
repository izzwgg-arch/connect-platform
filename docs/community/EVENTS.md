# Loopcom Community — event catalog

Generated from `src/lib/analytics.ts` and `src/lib/notify.ts`.

## Analytics events (40)

Schema (AnalyticsEvent): personId?, sessionId?, event, objectType?, objectId?, client?, appVersion?, surface?, position?, recommendationId?, experimentId?, props (screened: no keys matching password|secret|token|card|ssn|body|message), occurredAt.

- `feed_view`
- `post_impression`
- `post_open`
- `profile_view`
- `company_view`
- `search`
- `search_result_click`
- `connection_request`
- `connection_accept`
- `follow`
- `unfollow`
- `reaction`
- `comment`
- `share`
- `save`
- `hide`
- `report`
- `message_started`
- `message_replied`
- `call_started`
- `call_completed`
- `job_view`
- `job_apply`
- `rfq_created`
- `quote_submitted`
- `quote_accepted`
- `rfq_closed`
- `company_follow`
- `event_view`
- `event_rsvp`
- `marketplace_view`
- `opportunity_view`
- `signup`
- `login`
- `logout`
- `group_join`
- `intro_requested`
- `listing_view`
- `notification_open`
- `recommendation_outcome`

## Notification classes (32)

| Class | Label | Batch window (min) | In-app | Push | Email | SMS |
|---|---|---|---|---|---|---|
| `connection.request` | Connection requests | 0 | ✓ | ✓ | — | — |
| `connection.accepted` | Accepted connections | 30 | ✓ | ✓ | — | — |
| `follow.new` | New followers | 60 | ✓ | — | — | — |
| `post.reaction` | Reactions on your posts | 30 | ✓ | — | — | — |
| `post.comment` | Comments | 0 | ✓ | ✓ | — | — |
| `post.mention` | Mentions | 0 | ✓ | ✓ | — | — |
| `post.repost` | Reposts | 60 | ✓ | — | — | — |
| `message.new` | Messages | 0 | ✓ | ✓ | — | — |
| `message.request` | Message requests | 0 | ✓ | ✓ | — | — |
| `job.match` | Job matches | 0 | ✓ | ✓ | ✓ | — |
| `job.application` | Applications (employers) | 0 | ✓ | ✓ | ✓ | — |
| `job.stage` | Application updates | 0 | ✓ | ✓ | ✓ | — |
| `rfq.invite` | RFQs for your business | 0 | ✓ | ✓ | ✓ | — |
| `rfq.quote` | Quotes on your RFQs | 0 | ✓ | ✓ | ✓ | — |
| `rfq.question` | RFQ questions | 0 | ✓ | ✓ | — | — |
| `rfq.decision` | Quote decisions | 0 | ✓ | ✓ | ✓ | — |
| `rfq.closing` | RFQ closing soon | 0 | ✓ | ✓ | — | — |
| `event.reminder` | Event reminders | 0 | ✓ | ✓ | ✓ | — |
| `event.update` | Event updates | 0 | ✓ | ✓ | — | — |
| `recommendation.new` | Recommendations | 0 | ✓ | ✓ | — | — |
| `inquiry.business` | Business inquiries | 0 | ✓ | ✓ | ✓ | — |
| `opportunity.interest` | Opportunity interest | 0 | ✓ | ✓ | — | — |
| `intro.request` | Introduction requests | 0 | ✓ | ✓ | — | — |
| `intro.decision` | Introduction decisions | 0 | ✓ | ✓ | — | — |
| `group.request` | Group join requests | 0 | ✓ | — | — | — |
| `group.approved` | Group approvals | 0 | ✓ | ✓ | — | — |
| `org.invite` | Company invitations | 0 | ✓ | ✓ | ✓ | — |
| `org.verification` | Verification results | 0 | ✓ | ✓ | ✓ | — |
| `security.alert` | Security alerts | 0 | ✓ | ✓ | ✓ | ✓ |
| `moderation.action` | Moderation notices | 0 | ✓ | ✓ | ✓ | — |
| `reminder.due` | Your reminders | 0 | ✓ | ✓ | — | — |
| `search.alert` | Saved search alerts | 0 | ✓ | ✓ | — | — |
