# Tests Run

Newest entries first.

---

## Portal survives a 401 — global dead-session handler + pollers stop (2026-08-18)

Branch `feat/ivr-migration-takeover`, commits `93fb96d1` + `f183ee3d`. Portal only;
**portal DEPLOYED and container-verified** (`/app/.build-commit` = `f183ee3d`).

### New suite

```bash
cd apps/portal && npx tsx --test lib/sessionExpiry.test.ts
```

**Result:** 23/23. Classifier matrix (401 unauthorized+token = dead; 403 forbidden,
`invalid_credentials`, `bad_signature`, no-token, non-JSON = not), once-per-token
idempotence (20 calls → 1 clear, 1 redirect), public paths and desktop passive windows
never redirected, the local short-circuit (dead/empty token refused on authenticated paths,
never on public paths, re-armed by a fresh token), source guards on every call site, and
an api-contract guard that reads `apps/api/src/server.ts`.

### Source guards proven non-vacuous

Replayed against the pre-change files from `HEAD` in a scratch mirror (`git show HEAD:…`):
**4 of the 4 call-site guards fail** (apiClient wiring, AuthGate listener, telephony WS
1008 handling, the poller gates); the api-contract guard passes on both, as it should.

### Portal suite + typecheck

```bash
cd apps/portal && npm test          # 158 tests, 156 pass, 2 fail — the pre-existing
                                    # webrtcSdpDiagnostics + campaignsIndexLayout failures
cd apps/portal && npx tsc -p tsconfig.json --noEmit    # 0 errors
```

### Live browser check on the deployed build (no sign-in, no real credentials)

`https://app.connectcomunications.com/login`: form renders, only `/version → 200`, **zero
`/api/*` requests** (the one stray `/api/me/outbound-routes → 401` from before `f183ee3d` is
gone), no CSP/CORS console messages. `/p/PROBE000`: URL unchanged (no redirect), page reads
"This payment link is invalid or no longer available", `404 / 404` on the two pay-link
calls, no CSP/CORS messages. `/api/health` 200 on both hostnames.

### Not run, honestly

The dead-session path end to end (a real session whose token the api then refuses) — nothing
expires today and no real credentials were used. Human recipe in the security audit §8.7.

---

## Source-reading tests normalise CRLF — Windows-only failure closed (2026-08-18)

Branch `feat/ivr-migration-takeover`. Test-only + docs; no production code touched.

### The failure reproduced, then proven gone (CRLF mirror in scratch, real tree untouched)

```bash
# scratch mirror: server.ts et al. re-encoded to CRLF, tests copied alongside
node --import tsx --test src/orig.callsites.test.ts       # ORIGINAL test → ✖ actual: 'fu'
node --import tsx --test src/userDisplayName.callsites.test.ts src/supportReport.test.ts   # fixed → 17/17
node --import tsx --test lib/voicemailPreloadBound.test.ts  # portal, fixed → 6/6
```

**Result:** original test fails on CRLF exactly as reported (`actual: 'fu'`); the three
fixed tests pass on the CRLF mirror and on the real (LF) checkout.

### API full suite

```bash
cd apps/api && npm test
```

**Result (run twice):** 2369 tests, 2358 pass, 8 fail — the 7 pre-existing
`syncPbxTenantDirectoryFromRows` failures, plus `voice/elevenLabsRoutes.stress.test.ts`
"a 10-wide concurrent burst" (`expected 1-4 successes, got 10`). The latter is untouched,
passes 3/3 in isolation, and only fails under full-suite CPU load (the burst serialises);
recorded as a load flake, not a regression. Expected steady baseline is therefore **7**.

---

## CRM page rollout and backend support (2026-06-06)

### Portal typecheck

```bash
pnpm --filter @connect/portal typecheck
```

**Result:** passed after `ChecklistWorkspace` stale `viewMode` prop type was removed.

### Focused CRM/API tests

```bash
node --experimental-test-module-mocks --import tsx --test \
  "apps/api/src/crmFormService.test.ts" \
  "apps/api/src/crm/bulkEmail.test.ts" \
  "apps/api/src/crm/crmPermissionAudit.test.ts" \
  "apps/api/src/smsSharedInbox.test.ts"
```

**Result:** 37/37 passed.

### API full suite

```bash
pnpm --filter @connect/api test
```

**Result:** failed with two remaining `cdrDirection.test.ts` assertions:

- `7-digit 'to': ambiguous local PSTN, not counted as external -> keep stored`
- `9-digit 'to': not in external range -> keep stored`

The earlier `smsSharedInbox.test.ts` failure was fixed by adding a `crmTenantSettings`
mock for the CRM SMS decoration lookup.

### API typecheck

```bash
pnpm --filter @connect/api typecheck
```

**Result:** failed on pre-existing WebRTC/shared module-resolution issues and related
implicit-any test parameters outside the CRM rollout files.

---

# Tests run — VoIP.ms sms_toolong fix (2026-06-02)

## Shared SMS text unit tests

```bash
cd packages/shared
pnpm exec tsx --test src/smsText.test.ts
```

**Result:** 13/13 passed

```
✔ plain visible GSM text under 160 chars passes VoIP.ms validation
✔ 159 GSM chars passes single VoIP.ms sendSMS payload
✔ exactly 160 GSM chars passes single VoIP.ms sendSMS payload
✔ 161 GSM chars splits into two VoIP.ms API payloads but remains sendable
✔ 140 visible chars with 95 pipe symbols splits due to GSM septets, not blocked
✔ smart apostrophes normalize to GSM so short text stays one VoIP.ms part
✔ hidden characters are stripped and do not falsely block normal short text
✔ over VoIP.ms total cap blocks with precise error
✔ line breaks count as one GSM septet each after normalization
✔ counter shows encoding, bytes, and VoIP.ms part count
✔ Connect Chat does not append STOP or campaign footer during normalization
✔ 161-char payload fails single-part VoIP.ms validation with useful detail
✔ emojis remain Unicode and show byte/char counts honestly
```

## Portal typecheck

```bash
cd apps/portal
pnpm typecheck
```

**Result:** passed

## Workspace install (integrations → shared)

```bash
pnpm install --filter @connect/integrations...
```

**Result:** passed

## Not run

- Full `apps/api` typecheck — pre-existing unrelated errors in billing/onboarding/crm files
- Production deploy — not requested in this task
