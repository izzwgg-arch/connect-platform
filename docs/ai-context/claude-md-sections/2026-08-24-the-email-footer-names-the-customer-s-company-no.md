# ⛔ AGENT HANDOFF — the email footer names the CUSTOMER'S company now, not "your organization" (2026-08-24) — READ FIRST before touching `loopcomEmailShell.ts`, before putting a NEW email on that shell, or for "the footer names the wrong company"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`a2bfadd6` on `feat/ivr-migration-takeover`. ✅ **api DEPLOYED and
container-verified** (`.build-commit` = `a2bfadd6`, all four new strings grepped
inside `app-api-1`, the old hardcoded footer greps **0**, health 200 on both
hostnames, 0 restarts) **and the agent REBUILT and container-verified** (running,
0 restarts, **0 error-level lines**, health 200). No migration, no PBX write, no
env change, no tenant row touched.)
Izzy, 2026-08-24, looking at a Trust Bookkeepings voicemail email: *"where it
says sent on behalf of your organization, it should say the tenant name."*
Memory: [[email-footer-names-the-tenant]].

- ⛔⛔ **THE FOOTER IS DECIDED IN ONE FILE AND THREE CUSTOMER-FACING EMAILS RIDE
  IT** — `packages/shared/src/loopcomEmailShell.ts`, used by the **voicemail
  notification** (`voicemailEmailTemplate.ts`), the **user invite**
  (`userEmailTemplates.ts`) and the **SMS-to-email forward**
  (`apps/agent/.../smsEmail.ts`). Wiring only the one you were shown leaves the
  other two saying "your organization" — the half-fix shape this repo has paid
  for repeatedly (two IVR publish paths, two invite paths, two SMS ingest paths).
  **A guard test reads all three callers' SOURCE**, because the renderer is
  trivially right and the defect that matters is a caller that knows the company
  and forgets to say so.
- ⛔ **`organizationName` is OPTIONAL, TRIMMED, and falls back to the old
  wording.** Blank/whitespace/absent → "your organization", exactly as before.
  **Never make it required and never guess a value** — an email naming the WRONG
  company is worse than one naming none. It is escaped at the shell (a company
  name is customer-typed text going into HTML).
- ⛔⛔ **THE NAME MUST COME FROM A LOOKUP ALREADY SCOPED TO THAT EMAIL'S TENANT.**
  The voicemail one rides the **existing** `loadExtensionConfig` query, which is
  already `where: { tenantId, extNumber }` — so the name can only ever be the
  tenant the voicemail belongs to. A second fetch keyed on some other id is
  exactly how one customer's name lands on another customer's email.
- ⛔ **`Extension` HAS a `tenant` relation; `Voicemail` DOES NOT** (it carries a
  bare `tenantId` column). Checked in `schema.prisma` before writing the select —
  this same select shape on `Voicemail` is what made the email watchdog throw on
  every run for weeks. Do not copy one to the other.
- ⛔ **The agent's tenant lookup is `try/catch`, NOT `.catch()`.** If
  `prisma.tenant` is ever absent the property access throws **synchronously**,
  before a promise exists, so a `.catch()` never runs and the whole SMS forward
  dies — the exact shape that broke every invitation for a commit on 2026-08-17.
  A failed lookup costs a company name in a footer; **it must never cost the
  email**, and a test drives that with the lookup throwing, returning null, and
  returning a blank name.
- ⛔ **The name prints AS STORED.** `Tenant.name` is what the customer typed at
  sign-up and the invite body already prints it raw. ⚠️ **All 30 live tenants
  have a real name (0 blank), so the fallback should never be seen in
  production** — but two read oddly: **"inii mini"** (all lowercase) and
  **"A plus center"**. Capitalising them is a product decision, deliberately NOT
  made; fix it by renaming the tenant, not by inventing a transform.
- ⚠️ **THREE EMAILS STILL SAY "your organization", ON PURPOSE:**
  `passwordCreatedConfirmationEmail`, `passwordResetEmail` and
  `passwordChangedEmail` ride the **legacy pre-rebrand `shell()`** in
  `userEmailTemplates.ts`, which still brands itself **Connect Communications**
  and carries its own footer. Touching them is the rebrand decision that file
  says is "deliberately unchanged until their redesign is approved" — not this
  one. The billing shell is separate again and has no such line at all.
- ✅ **PROVEN BY DRIVING THE DEPLOYED CODE AGAINST REAL PRODUCTION DATA WITH THE
  WRITES INTERCEPTED** — the read-through/stub-the-writes recipe. Inside
  `app-api-1`, the real extension query returned `tenant.name =
  "Trust Bookkeepings"`, and the real `processVoicemailForEmail` built the email
  for **the exact voicemail from Izzy's screenshot** (Koznits/7189159095, ext
  105, 2026-08-24T16:33:27Z) addressed to `fhalpert@trustbookkeepingny.com`, with
  the footer reading **"This email was sent on behalf of Trust Bookkeepings."** —
  **`emailJob.create` and `voicemail.update` both stubbed, nothing written.**
- ✅ Also proven: 15 shared + 94 api voicemail/invite + 88 agent notify tests;
  **all 7 new source guards FAIL replayed against `HEAD`**; shared typecheck 0,
  api **76 = the exact baseline**, agent **14 = the exact baseline**, none in an
  edited file; and all three emails rendered and their footers read by eye.
  ⛔ The two `voicemail/*.test.ts` files that use `mock.module` need
  `node --experimental-test-module-mocks --import tsx --test` — without the flag
  they die and read as a regression (documented trap, hit again here).
- ⏳ **NOT PROVEN: nobody has RECEIVED one.** It is proven as deployed code, as
  tests, and as a real email built from real data — never as a message in an
  inbox. **The acceptance test is the next real voicemail to any tenant except
  Gesheft** (still emailed by the PBX, whose footer this does not touch): the
  footer should name their company. The negatives that matter: the invite email
  still says "Welcome to <tenant>" AND names them in the footer, and an SMS
  forward still goes out even if the tenant lookup fails.
