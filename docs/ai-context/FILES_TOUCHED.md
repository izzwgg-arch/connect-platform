# Files touched — Connect SMS length validation (2026-06-02)

| File | Why |
|------|-----|
| `packages/shared/src/smsText.ts` | New shared GSM/UCS-2 analysis, normalization, validation, counter labels, multipart split |
| `packages/shared/src/smsText.test.ts` | Unit tests for under/at/over limit, line breaks, Unicode, hidden chars |
| `packages/shared/src/index.ts` | Export `smsText` helpers |
| `packages/shared/package.json` | Include `smsText.test.ts` in test script |
| `apps/api/src/connectChatRoutes.ts` | Pre-queue SMS validation in `sendConnectChatSmsMessage`; store normalized body |
| `apps/worker/src/connectChatSmsJob.ts` | Encoding-aware MMS fallback segment split |
| `apps/portal/components/chat/SmsCharCounter.tsx` | Live SMS counter UI (Chat + CRM) |
| `apps/portal/components/chat/ChatComposer.tsx` | SMS counter + disable send when over limit |
| `apps/portal/components/crm/contact/ContactSmsPanel.tsx` | Replace misleading `/1600` JS length with encoding-aware counter |
| `apps/portal/app/(platform)/chat/page.tsx` | Surface API `SMS_TOO_LONG` message in send toast |
| `apps/portal/app/globals.css` | `.cc-sms-counter` spacing under chat composer |
| `docs/ai-context/CHANGELOG.md` | Release note for this fix |
| `docs/ai-context/API_ROUTES.md` | Document SMS validation errors on Connect Chat / CRM SMS send |
| `docs/chat/mms-test-matrix.md` | SMS text length limits reference for QA |
| `docs/ai-context/FILES_TOUCHED.md` | This file |
| `docs/ai-context/TESTS_RUN.md` | Commands and results for this task |
