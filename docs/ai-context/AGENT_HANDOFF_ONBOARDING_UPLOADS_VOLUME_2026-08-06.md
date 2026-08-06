# AGENT HANDOFF — onboarding wizard uploads were destroyed by every api deploy (2026-08-06)

**Status: FIXED, DEPLOYED, and container-verified.** Fix commit `5b2214fe` on
`feat/ivr-migration-takeover`, shipped inside the ship-out tip `ff1d9a7b`.
⏳ **Not yet proven end-to-end** — see §6 before you call this closed.

Read this before touching onboarding file uploads, `submitPortIn`'s document
attachments, or **any time you add a new storage directory to `apps/api`**.

---

## 1. The bug, in one paragraph

A customer uploads their phone bill / signed LOA in the sign-up wizard. The
bytes were written to `onboardingStorageRoot()`, which fell back to
`path.resolve(process.cwd(), "data/onboarding-files")` because
`ONBOARDING_STORAGE_DIR` was never set in `docker-compose.app.yml` — i.e.
`/app/data/onboarding-files` **inside the api container's ephemeral writable
layer**, which no volume covered. Every api deploy builds a new container and
removes the old one, so the files were destroyed. The
`onboardingUploadedFile` **DB row survived**, so the admin UI and the port
attachment loop both kept believing the document existed.

⛔ **The failure is silent by construction.** Nothing throws at upload time
(the write succeeds), nothing throws at deploy time, and the attach failure
lands softly in `portDocAttachFailures` — a field nobody reads unless they are
already suspicious. The DB looks perfectly healthy the whole way through.

## 2. The proven casualty

| | |
|---|---|
| Submission | `cmsey1ydz0000o4xoxu92gh2m` — **inii mini** |
| File | `Invoice_14945_2026-08-01.pdf` (`PORTING_BILL`), uploaded 2026-08-05 20:56 |
| Killed by | the api deploys at 21:49 and 22:31 that same evening |
| Consequence | VoIP.ms **port order 217760** (Verizon) was filed with **no bill attached** |

`docker ps -a` shows old containers are removed, so the bytes are
**unrecoverable**. The customer has to re-upload through their wizard link.
See `AGENT_HANDOFF_ONBOARDING_E2E_PAYMENT_2026-08-04.md` §9 for the port itself.

**Audit run 2026-08-06 — exactly ONE orphaned row exists platform-wide** (the
one above). Re-run it after any future incident:

```js
// docker exec -i -w /app/packages/db app-api-1 node -   ← MUST be stdin + this cwd.
// A script copied to /tmp cannot resolve @prisma/client and dies MODULE_NOT_FOUND.
const { PrismaClient } = require("@prisma/client");
const fs = require("node:fs"); const path = require("node:path");
const db = new PrismaClient();
(async () => {
  const rows = await db.onboardingUploadedFile.findMany({
    include: { submission: { select: { companyName: true, phoneNumberChoice: true } } },
  });
  const root = process.env.ONBOARDING_STORAGE_DIR || "/var/lib/connect/onboarding-files";
  for (const r of rows) {
    const ok = fs.existsSync(path.resolve(root, String(r.storageKey || "")));
    console.log(ok ? "OK  " : "GONE", r.createdAt.toISOString().slice(0,16),
      r.submission?.companyName, r.kind, r.filename);
  }
  await db.$disconnect();
})();
```

## 3. The fix (`5b2214fe`)

- **`docker-compose.app.yml`** — new `onboarding-files` named volume mounted at
  `/var/lib/connect/onboarding-files`, with `ONBOARDING_STORAGE_DIR` pointing at
  it. Follows the existing `chat-attachments` / `crm-lead-docs` pattern.
- **`apps/api/src/onboarding/storage.ts`** (new) — the single source of truth for
  the storage root, key→path resolution, and existence checks. The root had been
  **copy-pasted into three files** (`publicRoutes.ts`, `voipMsProvisioning.ts`,
  `provisioningRoutes.ts`) and had already drifted.
- **`server.ts`** — `warnIfOnboardingStorageEphemeral(app.log)` at boot: a loud
  log line if `ONBOARDING_STORAGE_DIR` is ever unset again, so the next
  occurrence is visible in `docker logs` within seconds instead of weeks later.
- **`submitPortIn`** — a missing file now logs *"the uploaded file is no longer
  on the server (lost in an earlier deploy) — ask the customer to re-upload it"*
  instead of a bare `ENOENT`. It still lands in `portDocAttachFailures`, and a
  paperwork miss still must not kill the build.
- **Admin submission detail** — every uploaded file carries `fileOnDisk`, so the
  UI can flag a dead row instead of offering a download that 404s.

**Orphan policy: flag, never delete.** The row is the only remaining evidence
that the customer ever supplied the document — deleting it would erase the fact
that they did their part.

## 4. ⛔ The trap that makes this class of bug recur

**`docker-compose.app.yml` has TWO api service blocks with fully duplicated
env and volume lists: `api` and `api_candidate`** (the blue/green rollout
candidate, host `:3004`, profile `api_rollout`). A storage volume added to only
one of them looks completely correct in testing and then **silently loses every
file the moment a blue/green cutover happens**. Same for `crm-lead-docs` and
`crm-voicemail-drops` — both are deliberately shared for exactly this reason.

**Rule: any new storage directory in `apps/api` needs all four of —**
1. a named volume declared under `volumes:`,
2. a mount + `*_STORAGE_DIR` env in the **`api`** block,
3. the identical mount + env in the **`api_candidate`** block,
4. a boot-time warning if the env var is unset.

A cwd-relative fallback is fine for local dev and is a **data-loss bug in a
container**. Grep for `process.cwd()` in `apps/api` before shipping any new
file-writing feature.

## 5. Verified live (2026-08-06)

```
ONBOARDING_STORAGE_DIR=/var/lib/connect/onboarding-files   ← set in app-api-1
app_onboarding-files -> /var/lib/connect/onboarding-files  ← mount present
local  app_onboarding-files                                ← volume exists
/app/apps/api/src/onboarding/storage.ts                    ← new code in container
0 × "ONBOARDING_STORAGE_DIR is not set" in docker logs     ← warning correctly silent
```

Tests: full `apps/api` suite green — **1535 pass / 0 fail / 3 skipped**
(`node --experimental-test-module-mocks --import tsx --test`), including the
135 onboarding tests and the pre-existing attach-failure regression test.

## 6. ⏳ What is NOT proven

**The volume holds ZERO files.** No customer has uploaded a document since the
fix deployed, so the real path — upload → survive a deploy → attach to a port —
has never actually run in production. Everything in §5 proves the *plumbing* is
connected, not that a file survives.

**Prove it cheaply, without waiting for a customer:** open a sign-up link,
upload any small PDF, confirm the file lands under
`/var/lib/connect/onboarding-files/onboarding/<submissionId>/`, run any api
deploy, then confirm the file is **still there** and the admin detail shows
`fileOnDisk: true`.

**Open follow-up:** inii mini's bill still needs re-collecting from the
customer, and port order 217760 still has no bill attached.
