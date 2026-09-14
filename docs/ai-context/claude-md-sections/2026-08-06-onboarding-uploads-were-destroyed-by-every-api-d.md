# ⛔ AGENT HANDOFF — onboarding uploads were destroyed by every api deploy (2026-08-06) — READ FIRST for wizard file uploads, port document attachments, or BEFORE ADDING ANY NEW STORAGE DIRECTORY to apps/api

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ONBOARDING_UPLOADS_VOLUME_2026-08-06.md`**
(commit `5b2214fe` on `feat/ivr-migration-takeover`, shipped inside the tip
`ff1d9a7b` — **DEPLOYED and container-verified 2026-08-06**.)

- ⛔ **THE RULE: a `process.cwd()` storage fallback is fine in dev and is a
  DATA-LOSS BUG in a container.** `onboardingStorageRoot()` fell back to
  `<cwd>/data/onboarding-files` because `ONBOARDING_STORAGE_DIR` was never set
  and no volume covered `/app/data`, so every api deploy destroyed the
  customer's uploaded bills/LOAs — while the `onboardingUploadedFile` **DB row
  survived**, leaving the admin UI and the port-attach loop believing the file
  was there. **Silent at every step**: the write succeeds, the deploy succeeds,
  and the attach failure lands in `portDocAttachFailures`, which nobody reads.
- **Proven casualty**: inii mini (`cmsey1ydz0000o4xoxu92gh2m`) uploaded
  `Invoice_14945_2026-08-01.pdf` at 20:56 on 2026-08-05; the 21:49 and 22:31
  deploys destroyed it, and **VoIP.ms port order 217760 was filed with no bill
  attached**. Old containers are removed, so it is unrecoverable — the customer
  must re-upload. An audit on 2026-08-06 found **exactly ONE** orphaned row
  platform-wide (that one); query in the handoff §2. **Policy is flag, never
  delete** — the row is the only evidence the customer ever supplied the doc,
  so admin detail now carries `fileOnDisk` instead of dropping the row.
- ⛔ **`docker-compose.app.yml` has TWO api service blocks with duplicated env
  and volumes — `api` AND `api_candidate`** (blue/green, host `:3004`). A volume
  added to only one tests perfectly and then silently loses every file at the
  next cutover. Any new storage dir needs FOUR things: the named volume, the
  mount + `*_STORAGE_DIR` env in **both** blocks, and a boot-time warning when
  the env is unset (`warnIfOnboardingStorageEphemeral` in `server.ts` is the
  pattern). `crm-lead-docs` / `crm-voicemail-drops` are shared for this reason.
- The root had been **copy-pasted into three files** and had drifted; it now
  lives once in `apps/api/src/onboarding/storage.ts`, which also gives the admin
  download path the path-traversal guard it never had.
- ⏳ **NOT PROVEN END TO END — the volume holds ZERO files.** No upload has
  happened since the deploy, so "file survives a deploy" is proven only as
  plumbing (env + mount + volume + new code all verified inside `app-api-1`).
  Prove it in 5 minutes without a customer: upload any small PDF through a
  sign-up link, deploy, confirm the file is still under
  `/var/lib/connect/onboarding-files/` and `fileOnDisk` is true.
- Env trap: an audit script copied to `/tmp` dies `MODULE_NOT_FOUND` on
  `@prisma/client` — pipe it via **stdin** into
  `docker exec -i -w /app/packages/db app-api-1 node -`.
