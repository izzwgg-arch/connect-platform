# Loopcom Community — architecture

One modular monolith (the api), one web app, one mobile app, one database — with seams where the brief wants room to grow (§39–40, §72). Generated companions: `API.md` (routes), `ERD.md` (models), `EVENTS.md`, `PERMISSIONS.md`, `DOMAINS.md` — regenerate with `pnpm --filter @loopcom/community-api docs:generate`.

```
 browser (Next 14)      iPhone / Android (Expo 54)
        │ HTTPS + SSE            │ HTTPS (+SSE via react-native-sse / polling)
        └──────────┬─────────────┘
              nginx  /  → web :3100      /api/ → api :3101 (buffering off)
                           │
                    community-api (Fastify 5)
        ┌────────┬─────────┼──────────┬───────────┐
     auth/    domains/*  core/       lib/        policy/
   identity  (22 routes  SSE, flags, audit,     graph.ts
   sessions   modules)   analytics  notify,     (pure)
   passkeys              ingest,    realtime,
   SSO                   schedulers storage,
                                    mail, push
                           │
      Postgres 16 (own db, FTS + trigram; pgvector optional)
      disk / S3 storage · Redis (optional fan-out) · SMTP · Expo push
      Loopcom api (SSO verify only) · Anthropic (understanding only)
```

## Domains (logical, one process)

identity · profiles · organizations (+verification) · graph · posts · feed · messaging · notifications · search · media · groups · events · jobs · marketplace · rfq · opportunities · intros · crm (+QR) · recommendations (+experiments/flags) · moderation (+admin, analytics) · concierge. Each is a folder with `routes.ts` (HTTP only), `policy.ts` (pure decisions, unit-tested), `service.ts` (db work), `*.test.ts` (integration on the real db). `src/domains.ts` is the registry.

## Request path

1. `onRequest`: request id + security headers.
2. `preHandler` actor resolution (`src/auth/actor.ts`): bearer/`?access_token=` → JWT → session row alive → person status → `StaffGrant` → `req.actor`. Public prefixes tolerate anonymous.
3. `preHandler` idempotency replay (`Idempotency-Key`).
4. Route: zod → ownership → permission → policy → db → `audit` / `notify` / `track` / `publishTo`.
5. Error handler: `ApiError` → `{error, message}`; zod → 400 `invalid_input`; 5xx logged with request id and returned as a human sentence.

## Feed ranking pipeline (brief §30)

`candidates(mode)` → `eligibility` (visibility, hidden, muted, blocked — batched) → `safety` (author status, content restrictions) → `score` (recency × relationship × industry × objectives × engagement) → `diversity` (≤2 consecutive by one author) → `preferences` → `page` (cursor). Every page item is a `RecommendationImpression` row whose id the client echoes on click/outcome.

## Recommendations

Rules-first, explainable models in `src/recommendations/models.ts` (byn, cymw, jyml, cand, groups, events, vendors) + PYMK in the graph domain; each impression carries `reason`; `/recommendations/explain/:id` shows the evidence. Embedding seam: `embeddings.ts` builds a declared-signal bag only (no demographic inference — a hard rule).

## Realtime

`publishTo(personId, type, data)` → in-process EventEmitter, or Redis pub/sub when `REDIS_URL` is set (several api instances). Clients hold one SSE stream (`/realtime/stream`); events: notification, message (+unreadDelta), thread, typing, presence, connection, rfq, quote.

## Search

Postgres FTS (`searchTsv` generated columns) + trigram (`%`, GIN, db-level threshold 0.12) over `searchText` per model; the search domain hydrates + permission-filters and adds `why`. `semanticIds()` is the pgvector seam.

## Scale seams (deliberately not built yet)

- Redis for realtime fan-out and rate-limit counters across instances (env flip).
- OpenSearch behind `src/search/engine.ts` when FTS+trigram stops being enough.
- ClickHouse behind `AnalyticsEvent` → `AnalyticsDaily` rollup when volume warrants.
- A queue (BullMQ) behind `src/core/schedulers.ts` jobs when one instance is not enough.
- CDN in front of `/media/file/*` (public assets are `immutable`).

## What Community shares with Loopcom

Nothing at the data layer. The Loopcom SSO seam (`src/auth/loopcomSso.ts`) verifies a Loopcom token against the Loopcom api; `Person.loopcomUserId/loopcomTenantId` and `Organization.loopcomTenantId` record the link; contact actions on pages (Call/Video/SMS/WhatsApp) are shown when both sides are linked. The Loopcom-side link (portal sidebar → `/sso/loopcom?token=`) and a `/community/crm-import` receiver are the two future changes on the Loopcom side.
