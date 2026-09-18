# Loopcom Community — completion report (Phase: build, 2026-09-18)

Per the brief (§62–§63): what was requested, what exists, where, and what proves it. Nothing below claims "100% bug-free" — it lists the evidence and the open items. **Not deployed** (Izzy: separate server later); everything runs locally per `README.md`.

## Evidence summary

| Check | Result | How to reproduce |
|---|---|---|
| Api integration tests (real Postgres) | **242 / 242** across 22 domains + auth/core/chaos/isolation | `cd apps/community-api && pnpm test` |
| Tier-1 repeatability (§49) | **17 flows × 20 = 340 / 340** over HTTP, no retries | `pnpm test:tier1` (api running with test hooks + rate-limit off) |
| Chaos / failure (§52) | 5 / 5 — storage failure, mail relay down, no Redis, duplicate delivery, SSO outage | `pnpm test:chaos` |
| Cross-org / privacy isolation, adversarial (§53) | 5 / 5 | `node --import tsx --test src/testing/isolation.test.ts` |
| Load (§50), 100 virtual users, realistic mix | 0 errors; found the feed at 58 s p50 → fixed to 0.2–0.5 s uncontended; RFQ create 11.5 s → 2.2 s with 25 invites | `LOAD_USERS=100 LOAD_SECONDS=45 pnpm test:load` (numbers below) |
| Control inventory (§47) | see E2E section | `pnpm test:controls` |
| Web typecheck | clean | `cd apps/community-web && npx tsc --noEmit` |
| Mobile | 65 / 65 unit tests, tsc clean, `expo export --platform android` bundles (1,497 modules) | `cd apps/community-mobile && pnpm test` |
| Playwright E2E (real browser, 3 device projects) | see E2E section | `cd apps/community-web && npx playwright test` |
| Dependency audit | `@fastify/jwt` bumped to 10.2.2; **Next 14.2.35 advisories open** (upgrade to 15.x tracked) | `pnpm audit` |
| Docs generated from source | 387 routes, 86 models, 40 events, 32 notification classes, 22 domains | `pnpm docs:generate` |

Load numbers (this laptop, Postgres shared with the test suites and other sessions — not a production-like box; `dbMs` for `SELECT 1` reached 240–490 ms under load): 100 VUs / 45 s → 1,064–1,380 requests, 22–28 rps, 0 errors, p95 ≈ 8 s under contention; uncontended single requests: feed 160–515 ms, search 150–670 ms, profile 120 ms, notifications 45 ms. Re-run on the target server before launch and record it here.

## Requested features — status

Legend: ✅ built + tested · ◐ built, partial (says what is missing) · ✗ not built.

| Brief § | Feature | Api | Web | iOS/Android | Tests |
|---|---|---|---|---|---|
| 1 Universal Loopcom ID | email/phone registration, verification codes, passkeys (WebAuthn), Google + Apple id_token, Loopcom SSO + link/unlink, MFA (TOTP), sessions/devices, logout-all, reset/change, deactivate, 14-day delete + purge, export, blocked accounts | ✅ `src/auth/*` | ✅ `/login /join /forgot-password /reset-password /sso/loopcom /settings/*` | ◐ all except passkeys (Expo has no WebAuthn API without a native module) | auth 9, isolation 5 |
| 2 Onboarding | 5 steps, objectives chips (declared, never inferred), skip | ✅ | ✅ `/welcome` | ✅ | E2E identity |
| 3 Personal profiles | all sections + per-category privacy, recommendations, endorsements, username, avatar/cover | ✅ `src/profiles` | ✅ `/people/[username] /me/profile` | ✅ (portfolio CRUD ✗) | 13 |
| 4 Company profiles | page, locations, hours (calendar-aware when linked), contact toggles, catalog, people, jobs, followers, RFQ door | ✅ `src/organizations` | ✅ `/companies/[slug] /company/*` | ✅ | 14 |
| 5 Verification | independent signals (phone, email, domain via DNS TXT, business, employee, license, insurance, Loopcom customer, transaction) + staff review; never a score | ✅ `src/verification` | ✅ | — (read-only chips) | 4 |
| 6 Social graph | connect/accept/ignore/withdraw/remove, follow, mute, block, report, relationship kinds (mutual flip), mutuals, degrees | ✅ `src/graph` | ✅ `/network /connections /settings/blocked` | ✅ | 14 |
| 7 Home feed | 7 modes, ranking pipeline (candidates→eligibility→safety→score→diversity→prefs→page), impression ids + why | ✅ `src/feed` | ✅ | ✅ | 10 |
| 8 Content creation | text/image/gallery/video/document/link (SSRF-guarded preview)/poll/article/company update, mentions, visibility, comments policy, edit/delete, schedule, analytics, alt text | ✅ `src/posts` | ✅ | ✅ | 21 |
| 9 Messaging | 1:1/group, requests (one-message cap), rich text/images/files/audio, reactions, reply, forward, edit, delete, search, typing, presence, privacy-aware read receipts, mute/pin/archive/report/block, realtime SSE | ✅ `src/messaging` | ✅ `/messages` | ✅ (SSE via react-native-sse; mute/pin/archive screens ✗) | 15 |
| 10 Loopcom communication | Call/Video/SMS/WhatsApp/Message/Request quote/Schedule buttons shown by entitlement (both sides linked) | ✅ flags | ✅ | ✅ | profiles/orgs tests |
| 11 Universal search | 9 types, FTS + trigram, facets, saved/recent, suggest, natural-language interpretation with match reasons | ✅ `src/search` | ✅ `/search` | ✅ (saved searches UI ✗) | 12 |
| 12 Groups | public/private, approval, feed, chat, files, events, jobs/listings, members/roles, rules, pins, invites | ✅ `src/groups` | ✅ | ✅ | 23 (with events) |
| 13 Events | online/in-person/hybrid, RSVP, capacity + waitlist, attendee visibility, .ics + Google link, reminders, chat, speakers/sponsors, Shabbos/Yom Tov notes | ✅ `src/events` | ✅ | ✅ | (with groups) |
| 14 Jobs | search/filters/alerts, apply with chosen sections + private résumé, status, recruiter messaging, employer pipeline/notes/stages/analytics, referral ask | ✅ `src/jobs` | ✅ `/jobs /company/hiring /me/applications` | ✅ | 8 |
| 15 Marketplace | data-driven category tree, listings (5 types), media, availability, service areas, message seller, saves | ✅ `src/marketplace` | ✅ | ✅ | 9 |
| 16 RFQ engine | plain-English extraction (confirmed by the buyer), vendor matching + invites, quote/decline/ask/alternate/attachments, compare, shortlist, accept (db-enforced single acceptance), close, outcomes → transaction verification + mutual tag, closing job | ✅ `src/rfq` | ✅ | ✅ | 10 |
| 17 Opportunities | 12 types as data with JSON field schemas, dynamic forms, interest threads, questions | ✅ `src/opportunities` | ✅ | ✅ | 9 |
| 18 Introductions | discoverable-path rule only, middle approves, AI/template draft, three-way thread | ✅ `src/intros` | ✅ `/network/intros` + profile dialog | ✗ native screen (web) | 13 |
| 19 Reputation | verified customer/repeat/responsive/transaction/insurance/license chips; recommendations accepted by the subject | ✅ | ✅ | ✅ | — |
| 20 Mini CRM | notes, tags, reminders, next action, deal value, timeline, pipeline, export; Loopcom hand-off seam (honest `queued:false`) | ✅ `src/crm` | ✅ `/crm` | ✅ | 11 |
| 21 QR networking | QR per person, scan → profile/connect/follow/vCard/note | ✅ | ✅ `/me/qr /scan` | ✅ | (crm) |
| 22 Notifications | 32 classes, in-app/push/email/SMS prefs, batching, quiet hours, Expo push delivery job | ✅ `src/notifications`, `lib/push.ts` | ✅ | ✅ (prefs screen ✗) | 6 + push 2 |
| 23/24 iOS + Android | Expo 54 app, native navigation, camera/photos/docs/QR, push, deep links, biometric lock, share, offline cache | — | — | ◐ built + bundles; **never run on a physical device** | 65 |
| 25 Mobile strategy | documented: extend the existing Expo/RN stack, separate app | `apps/community-mobile/README.md` | | | |
| 26 Deep links | `/people /companies /posts /jobs /events /groups /rfq /opportunities /marketplace` | ✅ | ✅ | ✅ | linking tests |
| 27 Analytics events | 40-event catalog, screened props, impression + experiment ids, daily rollup | ✅ `lib/analytics.ts` | ✅ client batching | ✅ | — |
| 28 Privacy by design | per-category visibility, prefs, export, delete, no sensitive inference (documented + enforced in `embeddings.ts`) | ✅ | ✅ | ✅ | isolation |
| 29 Recommendations | rules-first explainable models, impressions, dismiss, explain | ✅ `src/recommendations` | ✅ `/recommendations` | ✅ | 6 |
| 30 Feed ranking | as above, every impression has an id | ✅ | | | 10 |
| 31 Embeddings | declared-signal bag only; pgvector seam (extension absent locally) | ◐ seam | | | — |
| 32 Experimentation | flags (internal/selected/percent/all, emergency off), experiments with hypothesis/population/treatment/control/metrics/guardrails/min sample/rollback, stable assignment, results | ✅ | ✅ `/admin/flags /admin/experiments` | — | (rec) |
| 33 AI concierge | understand (Claude tool-call when keyed, rules otherwise) → search → explain → signed actions on confirm; never fabricates | ✅ `src/concierge` | ✅ `/concierge` | ✅ | 4 |
| 34 AI networking assistant | intro suggestions with reasons (`introsForYou` model built, not routed) + intro draft | ◐ | ◐ | ✗ | — |
| 35 Moderation | queue, evidence, warn/restrict/remove/suspend/ban/dismiss with required notes, appeals, audit | ✅ `src/moderation` | ✅ `/admin/moderation` | — | 14 |
| 36 Anti-spam | outreach caps (explainable), signals, sweep raising cases, progressive restriction | ✅ | ✅ | — | (graph/moderation) |
| 37 Admin control center | overview, users, orgs, verification queue, content, audit, notifications health, security alerts, flags, experiments, system health | ✅ | ✅ `/admin/*` | — | 14 |
| 38 Security | see `THREAT_MODEL.md` (argon2id, rotation, CSP, rate limits, SSRF guard, audit, signed actions/URLs) | ✅ | ✅ | ✅ | chaos/isolation |
| 39–40 Data architecture | Postgres (+FTS/trigram), disk/S3, optional Redis, seams for OpenSearch/ClickHouse/queue | ✅ `ARCHITECTURE.md` | | | |
| 41 Media pipeline | byte-sniffed MIME, size caps, EXIF-stripping re-encode, thumb/medium/original, sha256, signed private URLs; **malware scan ✗** (`scanResult = not-scanned`) | ◐ | ✅ Uploader/Gallery | ✅ | 6 |
| 42 Performance | load runner + the two fixes above; SLO targets in `RUNBOOKS.md` | ◐ (no CDN yet) | | | |
| 43 Observability | pino request logs + ids, audit, system health p95, notifications health, security alerts; **no OTel exporter yet** | ◐ | | | |
| 44 Backups/DR | `scripts/community/backup.sh` (encrypted, verified, retention) + `restore-drill.sh` (scratch restore + integrity checks) | ✅ scripts | | | **drill not yet run on a server** |
| 45 CI/CD | `.github/workflows/community.yml`: migrations, typecheck, tests, inventory, tier-1, audit, SBOM, web build, mobile export | ✅ | | | not yet executed on GitHub |
| 46–49 Testing philosophy / matrix / 20× | integration + E2E + tier-1 loop as listed | ✅ | | | |
| 50–52 Load / soak / chaos | `test:load` (LOAD_SECONDS=3600 = soak), `test:chaos` | ✅ | | | soak not yet run for an hour |
| 54 Device testing | Playwright mobile projects (Pixel 7, iPhone 14 viewports); **no physical devices** | ◐ | | ✗ | |
| 55 Accessibility | labels/roles/focus on every control; axe in `theme-a11y.spec.ts` | ◐ see E2E | | | |
| 56–60 Migrations, flags, versioned API, idempotency, audit | additive migrations only; flags; `/public/*` stable paths; `Idempotency-Key`; `AuditLog` | ✅ | | | |
| 61 Documentation | README, CONVENTIONS, ARCHITECTURE, API, ERD, EVENTS, PERMISSIONS, DOMAINS, THREAT_MODEL, RUNBOOKS, parity, controls.json, mobile README | ✅ | | | |
| 70–71 Existing vs non-Loopcom customers | SSO creates/links; claim company from tenant; outsiders register | ✅ | ✅ | ✅ | auth 9 |

## Open defects / gaps (Critical/High first)

1. **High** — Next.js 14.2.35 advisories (patched in 15.x). Upgrade with the E2E suite as the gate.
2. **High** — Mobile never executed on a real device or emulator (no device on this machine): SSE, calendar, lightbox gestures, push and biometric lock are typecheck+bundle-verified only.
3. **Medium** — No malware scanner on uploads (`scanResult = not-scanned`); ClamAV sidecar planned for the server.
4. **Medium** — No OpenTelemetry exporter / crash reporting service wired (logs + in-process p95 only).
5. **Medium** — Backup/restore drill and the 1-hour soak have not been run yet (scripts exist).
6. **Low** — Mobile gaps: passkeys, portfolio CRUD, notification prefs screen, saved searches, thread mute/pin/archive, native intros screen.
7. **Low** — `introsForYou` model not exposed on a route; `customersYouMayWant` ignores opportunities (no category on them).
8. **Low** — Search "all" runs the nine type searches concurrently and is the slowest read (~0.7 s uncontended).

## What the next phase needs from Izzy

- The separate server (or a hostname) → `infra/community/docker-compose.yml`; SMTP credentials; Google/Apple client ids; an Anthropic key for the concierge; Expo/EAS credentials (Apple team, FCM) for store builds.
- A decision on the Loopcom-side sidebar link (portal change, Fourth Rule applies).
