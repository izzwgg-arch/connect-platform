# Tests run

## B Visible missed charges + billingRecurringCustomLines — 2026-09-15

- `node --experimental-test-module-mocks --import tsx --test src/billing/billingRecurringCustomLines.test.ts src/billing/billingPeriodGuards.test.ts` (apps/api): **8/8 pass** — parse junk-tolerance/caps/taxable-strictness, built-line shape, CRLF-normalised source guard pinning the engine push BEFORE `applyBillingPeriodToRecurringLines`, plus both existing period-guard tests. ⛔ Plain `tsx --test` fails billingPeriodGuards on `mock.module is not a function` — the runner flag, not a regression.
- New test file registered in `apps/api/package.json`'s explicit test list (the runner never globs billing tests).
- `npx tsc --noEmit` (apps/api): no NEW errors — the documented pre-existing pair (billingPricingDiagnostics/State `accountPricing`) plus other sessions' in-flight areas (ops/, delivery/, globalSearch, mfa); nothing in the files this task touched.
- Live proof (prod, read-only): deployed preview route for B Visible returns $205.00 with both CUSTOM lines for the default period and Oct 2026.
- Not run: full api suite (change is two new files + a 7-line engine insert, guarded by its own registered suite); no real Oct 2 invoice/charge yet.

## LoopCom Mobile full product build — 2026-09-16

- `apps/api` loopcomMobile suite: **20/20 pass** (welcome-email template + once-per-tenant trigger guard added 09-16) — was 19/19 before the welcome addition; original scope: (money math incl. twice-run recount identity, ONE-request eSIM purchase + timeout-not-resent, real Ed25519 tamper/stale/wrong-key refusals, and the source guards: product routes registered + owner-gated (check count >= route count), tenant-from-JWT, no purchase/order call in product routes, no carrier port-filing call, EmailJob-only email lane, transfer PIN never echoed, activation code never in an email, nav/catalog/bucket contract for all 11 mobile keys, nine per-page API prefix rules).
- `apps/portal` nav suites: **40/40 pass** (loopcomMobileNav rewritten for the section: ten pages x visibility-honesty through the real `isNavItemVisibleForUser` for USER and TENANT_ADMIN jwts, hidden without the key; PermissionGate + no-SUPER_ADMIN + no-native-select swept across all ten page sources + both detail pages; console owner-check + "PURCHASES 1 eSIM" + "cannot double-bill" strings; permissionToggleCoverage 10/10 incl. one-toggle-per-page and no-lying-toggle over the new section).
- `apps/portal` FULL suite: **638 pass / 4 fail** — all four pre-existing at HEAD in files this build never touched (deskPhones setupDriver reboot guard, coworkerHands "Delete anything" copy, CRM campaignsIndexLayout CRMWorkspaceShell, webrtcSdpDiagnostics codec check). Verified: none of those suites' scanned sources are in this build's change set.
- `apps/api` FULL suite: **4,342 pass / 35 fail of 4,378** — every failure outside this build's change set: 34 in the onboarding orchestrator/scoped-links/checkout family (assertions like `resolvePbxRouteHelperConfig is not a function` and provider-wording drift "job needs company and did" vs expected "…, voipms" — the provider-switch/onboarding sessions' in-flight area on this shared worktree) + the publicOrigins tree sweep flagging `m.connectcomunications.com` in server.ts (introduced `2ade3422`, 2026-08-21). Nothing in those suites imports `src/loopcomMobile/*`, and this build's api diff is loopcomMobile/* + the server.ts mobile registration/prefix rules only.
- Typecheck: api = exactly the 87 pre-existing ambient errors (0 in `src/loopcomMobile/*`, 0 introduced); portal = 0 errors.
- Email templates: all 8 (incl. the welcome) rendered through the production `emailShell` with sample data (the artifact's Emails screen, v4, IS that output).
- ⏳ Not run/not provable yet: no real mobile line exists, so no live provisioning/usage/webhook/invoice/email delivery was exercised against production objects; deploy + container verification recorded in the summary file.

## Face-to-face AI Support mockup — 2026-09-15

- Static fragment/assets check passed for `talk-to-ai-support.html`: 29,338 bytes, under 1 MB; correct root; no document wrapper or escaped markup; all three generated avatar assets and critical live-call, admin and transfer states are referenced.
- Updated Concept A image was inspected after its tie-removal and Loopcom-infinity-pin edit; this now-superseded avatar draft remains historical review material only.
- Scope correction review: `talk-to-laybel.html` static fragment check passed at 9,907 bytes; no document wrapper or escaped markup; it contains the `Talk to Laybel` row and local start/end voice-state controls. It uses no avatar asset or provider integration.
- The visualization wrapper rendered successfully.
- `apps/portal/components/floatingAssistantOpening.test.ts`: passed 11/11 using `tsx --test`, including `Talk to Laybel is a voice mode of the existing Assistant, not another agent`.
- `git diff --check` passed for the Laybel implementation.
- Shared-worktree portal typecheck is presently blocked by an unrelated concurrent error in `apps/portal/components/deskPhones/DeskPhoneWizard.tsx` (`runId` used before declaration). A clean temporary worktree cannot resolve the local non-checked-in dependency tree, so it is not a substitute for a full typecheck.
- Not run: production deployment or production browser acceptance. No provider integration, LiveKit/avatar session, customer/PBX/remote-support operation, or new recording/storage path is involved.

## Browser Companion Playwright engine — 2026-09-15

- `pnpm --filter @connect/desktop build` — passed (schema generation and TS 6 build).
- `node --import tsx --test apps/desktop/src/coworker/*.test.ts` — passed, including the new Playwright integration test.
- `node --test apps/desktop/scripts/browser-companion/security.test.mjs` — 3/3 passed.
- `node --import tsx --test apps/desktop/src/coworker/playwrightRuntime.test.ts` — passed. Uses installed Chrome headlessly with a temporary profile and verifies scope isolation, approval binding/replay prevention, a form fill and byte-verified same-origin download.
- Clean package candidate `scratchpad/browser-companion-package-20260915162157175/release/Connect-Setup-0.1.17-rc.16.exe` — ASAR required-file check passed; `verify-built-icon.ts` passed against unpacked `Loopcom.exe`.

Not run: installed-app live chat/provider acceptance, ordinary-profile Chrome access, 2FA/captcha handling, vision transport, restart/stress matrix and production distribution.

## Installed-app verification — 2026-09-15

- Installed `Connect-Setup-0.1.17-rc.16.exe` with owner approval, restarted Loopcom, and observed the current processes running from `C:\Users\izzyw\AppData\Local\Programs\@connectdesktop\Loopcom.exe`.
- Elevated ASAR inspection of the installed app passed for `playwrightRuntime.js`, `playwright-core/index.js`, `playwright-core/package.json`, and `coworkerConnections.html`.
- The desktop-control service returned no targetable Loopcom window after restart. No visible Settings or live agent conversation assertion was made.

## Coworker IDE mockup — 2026-09-15

- Static fragment check passed for `loopcom-coworker-ide-mockup.html`: it is under 1 MB, has the required preview root, contains no document wrapper or escaped markup, and has balanced main/article elements.
- Not run: product UI tests, desktop build, packaging, or browser acceptance. This task produced a review mockup only; no application source changed.
