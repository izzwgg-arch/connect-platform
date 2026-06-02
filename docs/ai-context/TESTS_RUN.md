# Tests run — Connect SMS length validation (2026-06-02)

## Shared SMS text unit tests

```bash
cd packages/shared
pnpm exec tsx --test src/smsText.test.ts
```

**Result:** 8/8 passed

```
✔ plain text under 160 GSM septets is valid single segment
✔ exactly 160 GSM characters sends as one segment
✔ over-limit blocks with useful error
✔ line breaks count as one GSM septet each
✔ emojis switch to Unicode encoding honestly
✔ smart quotes force Unicode encoding
✔ pasted hidden characters do not falsely block normal short text
✔ GSM extended characters count as two septets
```

## Portal typecheck

```bash
cd apps/portal
pnpm typecheck
```

**Result:** passed (after `ChatComposer` disabled-prop boolean fix)

## Not run (pre-existing failures / out of scope)

- Full `packages/shared` test suite — 1 unrelated failure in `portalPermissions.customRoles.test.ts`
- Full `apps/api` typecheck — pre-existing errors in billing/onboarding/crm files unrelated to this change
