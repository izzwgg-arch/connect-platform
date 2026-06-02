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
