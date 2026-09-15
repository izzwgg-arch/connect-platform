# Universal search — 2026-09-14

## Request and outcome

Owner asked for search across anything the signed-in user can access, including pages and settings. The topbar `GlobalSearch` was an input-only placeholder. The unused `/search/global` route used one customer-view check for four different domains, returned full-model queries, and generated obsolete `/dashboard/...` links.

Implemented a keyboard-accessible dropdown with All / Pages / Settings / Records, Ctrl/Cmd K, arrows, Enter, Escape, loading/empty/error states, retry, and light/dark theme variables. Navigation pages are derived from `navConfig` and its exact `isNavItemVisibleForUser` function, including section grants, custom page grants, hidden-nav settings and platform-role gates. Personal settings include DND, appearance, ringing, text-email, voicemail email/transcription/greeting, profile and security. Tenant settings open their actual tab. Opening a setting does not change it.

Records currently cover workspace contacts and extensions, invoices, admin users/companies/phone numbers, conversations/messages, call history, voicemail (including notes/transcripts) and CRM contacts. Source queries are bounded and project metadata only. Additional domain records (for example order line items, campaign content and attachment contents) are not globally indexed; their permitted pages are searchable. Do not describe this as indexing every database field.

## Security and scope

`globalSearchRoutes.ts` resolves authoritative CRM-aware permissions and fails closed on resolution failure. Every provider requires its section/page grants and the existing role gate where applicable. Non-super users always use their JWT tenant; supplied tenant/global selectors cannot widen access. Selected PBX aliases are resolved to their Connect tenant IDs.

Global platform mode can search permitted admin inventory and call history. Select a company for contacts, extensions, CRM, messages and voicemail. Voicemail is never aggregated across companies. Legacy invoices retain the existing JWT-tenant restriction. No roles/permissions were assigned, no PBX writes were performed, and no database schema/infrastructure change is part of this task.

Calls, voicemail and CRM searches re-enter only fixed, read-only GET handlers with the original Authorization header, preserving mailbox ownership, linked-SIP call access and CRM campaign assignments. Call history `searchOnly=1` returns eight metadata rows only after the existing tenant, per-extension and linked-SIP in-memory selection runs; it skips PBX enrichment. Voicemail search AND-composes with the existing mailbox/tenant/playability restrictions. Chat queries enforce same-tenant active threads, active non-archived membership unless the existing tenant-chat permission allows broader reading, and exclude deleted-for-everyone and deleted-for-viewer messages.

Results are never cached publicly (`private, no-store`). The client debounces 450 ms, does not poll or auto-retry, drops stale responses and clears results when user/company/permissions change. No HTML from records is interpreted.

## Navigation

`useSearchNavigation` applies query links on initial navigation, Back, and same-page search selections. Contacts/team/admin users/companies/phone-number lists accept the selected search value. Call results set the matching day and filter. Voicemail filters server-side as well as client-side. Messages open their conversation; selecting a historical message does not yet scroll to that exact message. Invoice and CRM contacts use existing detail routes. Profile settings use a validated local event to open the existing menu section.

## Verification

- 24 tests passed: 13 API search tests, five navigation/catalog tests, six required PBX mutation safeguard tests. Covers authentication, malformed/short input, custom grants, section/page gates, hidden nav, tenant spoofing, global scope, permission resolver failure, inherited handler authentication/scope, private/deleted chat, partial errors, invoice gates, bounded secret-free projections and common search aliases.
- Portal typecheck passed (`--noEmit --incremental false`) after the final voicemail typing correction.
- API typecheck retains existing repository errors in billing/delivery/timer/module resolution areas; search module and search-related server edits had no diagnostics in the completed check. Final call-search path is also exercised through the dedicated suite's handler contract.
- Actual component browser fixture with real global CSS: light/dark dropdown inspected, DND Enter opens personal panel, microphone Enter opens `/settings#audio`, Alice record opens filtered contacts, changing company closes/clears search. Fixture uses mocked account/API data; it is not production data proof.
- Local build helper requires `/opt/connectcomms/ops/run-heavy.sh`, which is unavailable on this Windows workstation. Production builds must run through the normal deploy scripts.

## Release

Prepared on top of `6cae33e2`; commit/push and API/portal production deploy evidence will be appended here. Browser Deploy Center is the write path because the standing Windows SSH exception is read-only. Before dispatch, check both queue state and direct-deploy processes; no concurrent deploy was running at preparation. Earlier false-positive ban was already resolved in a separate task.

### Production rollout progress

- Search implementation committed as `23e6041ec40ccf2c8d13ed0d2d2298a4ad2f0a0d`, pushed to the working branch and `codex/universal-search`.
- API dry-run job `65f7fd86-4767-40a6-ba60-adfa72b522a6` succeeded against that SHA.
- A separate authorized desk-phone rollout started during preflight at descendant `2a8f4f835f76c1c4ecf165ecafd883d282c1b1c4`. `git merge-base --is-ancestor 23e6041e 2a8f4f83` succeeded. No competing queue deployment was launched; do not roll back that newer work to the search-only SHA.
- API direct log `/var/log/connect-deploys/direct-api-20260915T002151Z.log` ended `[deploy-api] done 2a8f4f83 requested_by=direct:root`; `/app/.build-commit` matches. `registerGlobalSearchRoutes` and `searchOnly` were read from the running API container. Portal rollout at the same SHA started in `/var/log/connect-deploys/direct-portal-20260915T002649Z.log`; final verification pending.
- Additional browser fixture checks: hidden pages omitted after permission change, old slow response cannot replace a newer Alice result, Ctrl K reopens, failure shows manual Try again. The test fixtures use no real user data and are removed after verification.

### Call date-link correction

During release review, identified that API search dates are UTC while Call History date inputs are local. A late-evening call could therefore open an empty next-day filter. `globalSearchDates.ts` converts the entire result UTC day into the viewer's local start/end dates, including eastern timezones, year boundaries and DST. Three focused tests and a strict standalone typecheck passed. This is a portal-only follow-up; the API search handler is unchanged. The 24 existing voicemail/CRM ownership/custom-role regression checks also passed, for 51 checks total across the targeted suites.

### Final call-access and navigation correction

Live review caught an early search metadata return preceding the history handler's in-memory extension filters. Moved it after the complete existing selection block, including linked foreign extension checks. No restricted-user data exposure was observed in live testing (the live account is SUPER_ADMIN); the code defect was identified by inspection and is covered by executing the actual selection block with restricted fixtures. Call deep links now run after the initial Today effect, select Custom and clear conflicting list filters. This corrects the empty historical-call view found in live navigation. Final redeployment verification follows.
