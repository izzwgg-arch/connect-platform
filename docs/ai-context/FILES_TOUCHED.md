# Files touched — VoIP.ms sms_toolong fix (2026-06-02)

| File | Why |
|------|-----|
| `packages/shared/src/smsText.ts` | VoIP.ms 160-char limit, smart-punct normalization, payload byte/septet analysis, auto-split helpers, precise error messages |
| `packages/shared/src/smsText.test.ts` | 13 tests: 140-visible/septet overflow, 159/160/161, smart apostrophes, hidden chars, STOP/footer absence |
| `packages/integrations/package.json` | Add `@connect/shared` for VoIP.ms preflight validation |
| `packages/integrations/src/index.ts` | `VoipMsSmsProvider.sendMessage` preflight + payload logging + `sms_toolong` detail |
| `apps/worker/src/connectChatSmsJob.ts` | Auto-split all outbound SMS into VoIP.ms-safe parts; per-part send logs |
| `docs/ai-context/CHANGELOG.md` | Release note |
| `docs/ai-context/FILES_TOUCHED.md` | This file |
| `docs/ai-context/TESTS_RUN.md` | Commands and results |
| `packages/integrations/tsconfig.json` | Allow importing `@connect/shared/smsText` without rootDir conflict |
| `tsconfig.base.json` | Path alias for `@connect/shared/smsText` |

**Unchanged (already correct from prior pass):** `apps/api/src/connectChatRoutes.ts`, portal `SmsCharCounter` / composers — consume updated `@connect/shared` analysis automatically.
