# CRM Email Intake

Scope: learned website submission emails processed through the existing CRM email sync pipeline.

## Product Shape

- UI lives in `CRM Settings -> Email / Website Submissions`.
- Admins paste or upload a sample email, preview detected sender/subject/field mapping, then save a tenant-scoped rule.
- No webhook feature, no standalone intake module, and no large review page in Phase 1.

## Data Model

- `CrmWebsiteSubmissionEmailRule`: tenant + mailbox scoped learned rule. Stores sender/domain match, subject/body pattern metadata, CRM field map, attachment expectations, assignment target, confidence threshold, and auto-create vs review-first mode.
- `CrmWebsiteSubmission`: one processing record per tenant + Gmail message id. Stores extracted fields, unmapped summary, confidence, contact/message links, status, and safe error text.
- `CrmUserNotification`: minimal dismissible user-scoped notification used by the topbar notification panel.
- `CrmLeadDocument.source = EMAIL_ATTACHMENT`: original email attachments linked to contacts through existing CRM document storage.

## Worker Flow

`apps/worker/src/crmEmailSync.ts` keeps the existing tracked-thread reply sync unchanged.

After that loop, the worker:

1. Loads active rules for `(tenantId, connectionId)`.
2. Searches recent Gmail inbox candidates only for those rules.
3. Fetches full body/attachments only for candidate messages.
4. Matches sender/domain/subject/body patterns.
5. Calls `processWebsiteSubmissionEmail`.
6. Records aggregate counts in the existing `CRM_EMAIL_SYNC_RESULT` audit log.

Set `CRM_WEBSITE_SUBMISSION_EMAIL_ENABLED=false` to disable the intake branch without disabling normal CRM reply sync.

## Extraction Rules

Extraction maps only to the CRM profile fields that exist today:

- `Contact`: name, company, title, notes, source.
- `ContactEmail`: email.
- `ContactPhone`: phone.
- `ContactAddress`: street, city, state, zip, country.
- `CrmContactMeta`: stage and assignment.

Useful information without a CRM field goes into submission summary/notes. Do not force unmapped values into random fields.

## Security

- All reads/writes are tenant-scoped.
- Rule management requires CRM email settings access.
- Notifications and timeline text are redacted; no full SSN, bank account, routing, or long account numbers.
- Original attachments are preserved only in tenant-scoped CRM document storage and opened through existing signed document routes.
- Normal email reply sync remains metadata-first; full-body reads are limited to active learned submission rules.

## Manual QA

1. Tenant admin opens CRM Settings.
2. Pastes a sample website submission email.
3. Preview shows sender/domain, subject pattern, mapped CRM fields, unmapped summary, and attachment expectations.
4. Admin saves an active rule for a connected Gmail mailbox with readonly/reply tracking enabled.
5. Send a matching email to that mailbox.
6. Run CRM email sync.
7. Verify contact is created or updated without overwriting existing populated fields.
8. Verify attachments appear under contact documents.
9. Verify a `WEBSITE_SUBMISSION` timeline event appears.
10. Verify assigned user gets a dismissible notification with no sensitive values.
11. Verify non-matching/disabled rules are ignored and normal CRM replies still sync.
