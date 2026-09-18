# Loopcom Community — domain map

Registered in `src/domains.ts` (a domain not listed there does not exist). Each domain: `routes.ts` (HTTP), `policy.ts` (pure decisions), `service.ts` (db work), `*.test.ts` (integration tests on the real db).

| Domain | Routes | Test files |
|---|---|---|
| profiles | 33 | 1 |
| organizations | 30 | 1 |
| graph | 29 | 1 |
| posts | 26 | 1 |
| feed | 2 | 1 |
| messaging | 25 | 1 |
| notifications | 6 | 1 |
| search | 9 | 1 |
| media | 5 | 1 |
| groups | 24 | 1 |
| events | 13 | 2 |
| jobs | 22 | 1 |
| marketplace | 13 | 1 |
| rfq | 23 | 1 |
| opportunities | 11 | 1 |
| intros | 9 | 1 |
| crm | 18 | 1 |
| recommendations | 17 | 1 |
| moderation | 23 | 1 |
| admin | 0 | 0 |
| verification | 7 | 1 |
| concierge | 3 | 1 |

Cross-cutting: `auth/` (identity), `core/` (SSE, analytics ingest, flags, privacy, devices, schedulers), `lib/` (audit, notify, realtime, storage, mail, push, idempotency, search, pagination), `policy/graph.ts`, `concierge/`.
