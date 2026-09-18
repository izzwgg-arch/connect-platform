# ⛔⛔ AGENT HANDOFF — Loopcom Community: audit of the existing system, target architecture, and the v1 mockups (2026-09-18) — READ FIRST before building anything under `community/`

Izzy's brief (2026-09-18, verbatim intro): *"give it the nice connect theme look, light mode and dark mode"* + the full "Loopcom Community" product brief (a Jewish-focused B2B professional network: identity, profiles, companies, graph, feed, messaging, search, groups, events, jobs, marketplace, RFQ, opportunities, referrals, CRM, notifications, iOS/Android, analytics, moderation, admin, security, testing).

**State at the end of this task: DESIGN + ASSESSMENT ONLY. Nothing built, no schema change, no route, no deploy.**
The brief itself says *"Before building major UI, produce high-fidelity mockups … Show the product owner"*, and this repo's convention is mockups → Izzy's word → build. The build starts on his approval of the design language below.

- Mockups (24 screens, Connect tokens, light + dark toggle): **https://claude.ai/artifact/NKRSEmuPNncn8fq3h9z7yW**
- Repo copy of the same file: `docs/mockups/loopcom-community/mockups-v1.html` (logos embedded as data URIs; open it in a browser, the switch is top-right).
- Screens: Design system · Landing · Sign in · Create Loopcom ID · Onboarding · Personal profile · Company profile · Home feed · My network · Connections · Universal search · Messages · Notifications · Jobs · Marketplace · RFQ & quotes · Opportunities · Groups · Events · Company admin · Analytics · Settings · Moderation/admin console · iPhone + Android (4 phone frames).

---

## 1. Audit of the existing Loopcom system — what Community reuses

Read from the tree on 2026-09-18 (`packages/db/prisma/schema.prisma` = 215 models; `apps/api/src/server.ts` = 43,130 lines; `apps/realtime/src/server.ts` = 43 lines).

| Area | What exists | Reuse verdict |
|---|---|---|
| **Identity** | `User` has `tenantId` REQUIRED and `email @unique` GLOBALLY. One user = one tenant. JWT never expires (on purpose, see `2026-08-18-session-tokens-still-never-expire…`). bcrypt hashes. | ⛔ Cannot be the Loopcom ID as-is: a person must exist without a tenant and may belong to many organizations. **New `CommunityPerson` (the Loopcom ID)** with an OPTIONAL `userId` link. Existing users link, never duplicate (email/phone uniqueness across both tables enforced at the door). Community sessions = short-lived access + rotating refresh tokens, **separate** from the portal JWT (untouched). |
| **MFA / passkeys** | `apps/api/src/mfa/` — TOTP, login OTP by SMS/email, recovery codes, pre-auth token. `mfaService.ts` mentions WebAuthn only in prose. | ✅ Reuse the OTP + TOTP flows. ➕ Add WebAuthn passkeys (`@simplewebauthn/server`). |
| **Google login** | `googleLogin.ts` — LOGIN ONLY, never sign-up (standing rule). | ✅ Same rule for Community web. Apple Sign In is new (required on iOS). |
| **Cross-company identity precedent** | `LoopcomDirectIdentity` (userId unique, phoneE164 unique, `findable`, `requireRequests`), `directPolicy.ts` pure functions, per-USER isolation, deep-equal `not_found` oracle, one-message request cap. | ✅✅ **This is the template.** Community identity, message requests and the anti-spam property copy Direct's shape. |
| **Chat** | `ConnectChatThread/Participant/Message/Attachment/Reaction` — all carry a REQUIRED `tenantId`. `apps/realtime` = ws fan-out over Redis pub/sub. `chatAttachmentStorage.ts` = S3-compatible (`@aws-sdk/client-s3`). | ✅ Reuse realtime + attachment storage + reactions/voice-note/denoise code paths. ⛔ New `CommunityThread` kind WITHOUT `tenantId` (Direct's rule + its guard test shape). |
| **Contacts / CRM** | `Contact` is private per user (`contactVisibility.ts`), CRM = `Crm*` models, tenant-scoped. | ✅ The Community "mini CRM" writes `CommunityRelationshipNote` etc. and can PUSH a contact into the tenant CRM through the existing `Contact` create path — never a second CRM record model. |
| **Calling / video / SMS / WhatsApp / email** | PBX per tenant; `VideoMeeting` (LiveKit) — Direct posts join links into a thread; SMS via VoIP.ms/Telnyx/SignalWire dispatch registry; WhatsApp module; `EmailJob` lane (500/day cap, sender "Loopcom"). | ✅ Contact actions on profiles/companies are **entitlement-derived** from the linked tenant; Community itself owns no telecom. Emails go on the EmailJob lane with the existing templates' footer rules. |
| **Notifications** | `fcmDirect.ts`, `MobileDevice`, push registration, `CrmUserNotification`. | ✅ Reuse push transport. ➕ New `CommunityNotification` + per-class channel prefs + batching worker (BullMQ). |
| **Search** | `globalSearchRoutes.ts` = Prisma `contains` ILIKE. No OpenSearch, no pgvector. | ➕ Postgres FTS + `pg_trgm` day one; `pgvector` for semantic; OpenSearch is a seam, not a dependency (brief §39). |
| **AI** | `apps/agent` (LLM, tools, knowledge, triage, voice), api `voiceAgent/`, ElevenLabs/Polly. | ✅ RFQ extraction and the concierge run on the agent service's LLM lane; every extraction is shown for confirmation. |
| **Permissions** | `permissionGates.ts`, `platformRolePermissions.ts`, custom roles (authoritative REPLACE), `navConfig.ts` is the catalog, both toggle screens read it. | ✅ Community pages inside the portal get nav entries + toggles in the SAME commit (Fourth Rule). Organization RBAC inside Community is its own table (`CommunityMembership.role` + permission set), because a person may hold different roles in different orgs. |
| **Mobile** | `apps/mobile` = Expo 54 / RN 0.81 / React 19.1, theme tokens in `src/theme/colors.ts` (dark `#090e18`, light `#f0f4f9`), CallKit, FCM/APNs, deep links, store accounts live (Play vc103, TestFlight build 60). | ✅✅ **Decision: extend the existing RN app** (see §5). |
| **Desktop** | Electron (Loopcom Windows app) hosts the portal. | ✅ Community web pages render there for free. |
| **Deploy / observability** | `scripts/deploy-direct.sh` api/portal/worker, blue-green, `.build-commit` verify; pino logs; no OTel, no ClickHouse. | ✅ Same deploy. ➕ OTel tracing + a `community_event` table rolled up nightly for analytics (ClickHouse only when volume proves it). |
| **Storage** | S3-compatible via aws-sdk; no image pipeline, no malware scan. | ➕ Media pipeline (sharp resize, MIME sniff, ClamAV container, signed URLs). |

**Do-not-break list** (things Community must not touch): `User.tenantId` semantics, portal JWT lifetime, `ConnectChat*` tenant filters, `Contact.ownerUserId` visibility, the billing engine, PBX writes, the EmailJob cap.

## 2. Target architecture

One modular monolith in `apps/api` under `src/community/<domain>/` (identity, profiles, organizations, graph, feed, posts, messaging, search, jobs, marketplace, rfq, opportunities, events, groups, notifications, recommendations, analytics, moderation, verification, crm, communications, ai) — each domain = `routes.ts` + `service.ts` + `policy.ts` (pure decision functions, Direct-style) + `*.test.ts`. Prisma models prefixed `Community*` in the SAME schema (one DB, additive migrations only). Realtime stays `apps/realtime` with a `community:` channel namespace. Background = existing BullMQ worker with `community.*` queues (media, notify, rollup, match). Web = `apps/portal/app/(platform)/community/*` hosted in the portal shell for linked customers AND a standalone `community.loopcom.net` host that renders the same Next routes with the Community-only shell (no PBX sidebar) for people without a tenant. Public read routes (`/people/{username}`, `/companies/{slug}`, `/posts/{id}`, `/jobs/{id}`, `/events/{id}`, `/groups/{slug}`, `/rfq/{id}`, `/opportunities/{id}`) go through `jwtPublicRouteBypass.ts` with the SAME allowlist pattern (add to the guard test).

## 3. Domain model (v1 tables, all additive)

`CommunityPerson` (Loopcom ID: id, email?, phoneE164?, passwordHash argon2id, userId? unique→User, username unique, status, emailVerifiedAt, phoneVerifiedAt, deletedAt+deleteAfter) · `CommunitySession` (refresh token family, device, revokedAt) · `CommunityPasskey` · `CommunityProfile` (1:1, headline/about/location/serviceArea/languages/objectives[]) + `CommunityProfileSection` visibility rows (PUBLIC/CONNECTIONS/ORG/PRIVATE) · `CommunityExperience/Education/Skill/Service/Media/Recommendation/Endorsement` · `CommunityOrganization` (slug, tenantId? unique link, legal/display name, industry, size, hours→uses tenant Jewish-calendar settings when linked) + `CommunityLocation` + `CommunityMembership` (personId, orgId, role enum + `permissions Json`, affiliation VERIFIED_DOMAIN/VERIFIED_ADMIN/PENDING) · `CommunityVerification` (subject person|org, kind enum {PHONE,EMAIL,DOMAIN,BUSINESS,EMPLOYEE,LICENSE,INSURANCE,LOOPCOM_CUSTOMER,TRANSACTION}, evidence, reviewedBy, expiresAt) · `CommunityConnection` (a<b canonical pair, status PENDING/ACTIVE/WITHDRAWN/REMOVED, unique(a,b)) · `CommunityRelationshipTag` (owner-private type: CUSTOMER/VENDOR/WORKED_WITH/REFERRED/PARTNER/MENTOR, `mutual` flag when both sides set it) · `CommunityFollow/Mute/Block/Report` · `CommunityPost` (kind, body, visibility, commentsPolicy, scheduledFor, orgId?) + `CommunityPostMedia/Reaction/Comment/Save/Repost/Poll/PollVote` · `CommunityThread` (kind DM/GROUP/RFQ/EVENT/GROUPCHAT, NO tenantId) + `CommunityThreadParticipant` (state ACTIVE/REQUESTED/DECLINED, lastReadAt) + `CommunityMessage` + attachments/reactions · `CommunityGroup` + members/rules · `CommunityEvent` + registrations (visibility) · `CommunityJob` + `CommunityApplication` (profile snapshot Json, stage) · `CommunityMarketplaceCategory` (parentId — data, not code) + `CommunityListing` · `CommunityRfq` (extracted fields + confirmed flag) + `CommunityRfqInvite` + `CommunityQuote` (**partial unique index: one ACCEPTED quote per rfq**) + `CommunityRfqQuestion` · `CommunityOpportunityType` (fieldSchema Json) + `CommunityOpportunity` + interests · `CommunityIntroRequest` (requester, intermediary, target; intermediary approval REQUIRED before target sees anything) · `CommunityNote/Reminder/Task` (private CRM) · `CommunityNotification` + `CommunityNotificationPref` · `CommunityEvent_Analytics` (actor, session, event, objectType, objectId, client, appVersion, surface, position, recommendationId, experimentId — no message bodies, no secrets) · `CommunityRecommendationImpression` · `CommunityFeatureFlag` / `CommunityExperiment` / assignment · `CommunityModerationCase` + actions + appeals · `CommunityAuditLog` (actor, action, target, before/after, source). Idempotency keys on connection/rfq/quote-accept/invite/upload mutations (`Idempotency-Key` header → `CommunityIdempotency` table, 24h).

## 4. Permissions model

Three layers, checked in this order in every route: (1) **platform** (`SUPER_ADMIN` jwt or Community moderator role → admin console); (2) **organization** (`CommunityMembership.role` → permission keys: `org.manage_members`, `org.post`, `org.quote`, `org.hire`, `org.billing`, `org.moderate`, `org.edit_page`, `org.verify` — owner/admin/manager/employee/recruiter/sales/marketing/billing_admin/moderator are presets, custom = explicit set); (3) **relationship** (viewer's degree + blocks + section visibility → what a profile shows; blocks return the SAME `not_found` shape as absence). Portal-side: the hosted Community pages get `can_view_community_*` keys, one per page, no default bucket ("granting IS the launch", as with Mobile) — plus their In-sidebar switches and custom-role toggles in the same commit.

## 5. Mobile strategy — decision

**Extend `apps/mobile` (Expo 54 / RN 0.81).** Reasons: it already has the store identities, push (FCM/APNs), CallKit, deep-link plumbing, the theme tokens and the crash/diagnostics reporting; a second native codebase would duplicate all of it and split the release pipeline that is already fragile (see `app-release-pipelines`). Community ships as a tab set (Home / Network / Post / Messages / Me) shown to everyone with a Loopcom ID; the telephony tabs stay gated on a linked tenant. Flutter and native Swift/Kotlin were considered and rejected on reuse grounds, not speed. Native pieces needed: passkeys (`react-native-passkey`), Apple Sign In (`expo-apple-authentication`), predictive back (already on Android 15 target), QR (existing scanner). Parity matrix lives in `docs/community/parity.md` once the build starts.

## 6. Build order (from the brief §67, mapped to this repo)

1. **Foundation** — `CommunityPerson` + sessions + passkeys + Apple/Google + account linking; org + membership + RBAC; audit log; analytics event table; feature flags; design tokens shared (portal already has them; mobile `colors.ts` already matches). Gate: 20× signup/login/logout/reset loop green.
2. **Core network** — profiles, companies, connections/follows, search (FTS+trgm), feed (candidate → eligibility → safety → score → diversity → prefs), posts + media pipeline, notifications, messaging (thread kind, realtime).
3. **Community** — groups, events (calendar-aware), heuristic recommendations with impression IDs.
4. **Commercial** — marketplace categories/listings, RFQ + quotes (idempotent accept), opportunities (typed schemas), intro requests.
5. **Employment** — jobs, applications, pipeline.
6. **Loopcom integration** — tenant → org claim, entitlement-derived contact actions, CRM push, concierge on the agent lane.
7. **Intelligence** — pgvector embeddings from declared signals only, experiments, semantic search.

Each phase ends with the completion report the brief demands (§62) and its proof package (§63). Nothing is "done" without the E2E run, the 20× Tier-1 loop, and the control inventory (§47) — those test harnesses are part of phase 1's deliverable, not an afterthought.

## 7. Testing strategy (what exists to build on)

`apps/api` runs node:test files named explicitly (`test-runners-name-files-explicitly`); source-reading guard tests are the house style (replay against pre-fix HEAD; normalise CRLF). Community adds: a control inventory JSON per screen (`docs/community/controls.json`, generated from `data-testid`) that a Playwright suite walks; a `tier1.spec.ts` that loops each Tier-1 flow 20× against the blue-green CANDIDATE port before it goes stable; k6 load scripts under `scripts/community/load/`; a Redis-down / search-down chaos script. Flaky = bug, never retried-to-green.

## 8. Design decisions in the mockups (so the build does not re-litigate them)

- Tokens are Connect's verbatim: bare `:root` DARK, `[data-theme="light"]` opt-in, **never `prefers-color-scheme`** ([[billing-must-use-connect-theme-tokens]]). Status text on light uses the INK variants (`#0f7a4a` / `#8a5a00` / `#b42318`); fills keep the app hue. One wordmark file (`loopcom-nav-h64@2x.png`) in both themes, no filter.
- The only brand motif is the infinity mark: the 2px gradient hairline (login card), the gradient primary button, and the arc on covers. Nothing else is decorated.
- Verification = independent chips, never a score. Relationship-derived facts show only what both sides allowed ("3 people you know are verified customers"). "Why am I seeing this" on every recommended item.
- Feed modes are separate candidate generators, not filters. Message requests cap the sender at one message (Direct's property). Hours are computed from the tenant's Jewish-calendar module when linked.
- Marketplace categories and opportunity types are DATA. Quote acceptance is idempotent by index.

## 9. ⛔ Traps for whoever builds it

- ⛔ `User.email` is globally unique and `User.tenantId` is required — do NOT try to make `User` the Loopcom ID; link to it.
- ⛔ A Community thread must NOT carry `tenantId`; a guard test like Direct's must enforce it, or the first tenant filter someone adds returns nothing for every real conversation.
- ⛔ New portal pages + nav entry + both toggle screens land in ONE commit (the Fourth Rule); the pipeline deploys the branch tip whenever it likes (the Direct 40-minute exposure).
- ⛔ `server.ts` is 43k lines — register Community as a plugin file, never inline.
- ⛔ The mockups' names, companies, numbers and prices are EXAMPLES; the page says so.
- ⛔ Chrome (extension) could not reach a `localhost` server from this profile, and `file://` gets `https://` prefixed by the navigate tool — publish the artifact and look at the live page.

## 10. ⏳ Not done / waiting

- Izzy's word on the design language (this artifact) → then phase 1.
- No schema, routes, tests, migrations, or mobile code exist for Community yet.
- Standalone host `community.loopcom.net` needs DNS + nginx (server-side state; see the nginx/CSP traps in the desk-phone handoff).
