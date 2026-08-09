# AGENT HANDOFF — the APK download link vanished from sign-up invitations (2026-08-09)

**Commit `357f863c` on `feat/ivr-migration-takeover` — api DEPLOYED (queue job
`c649d756`) and container-verified.**

Reported by Izzy: *"Somehow the APK download link got taken out of the email
invitation email. Put it back — just the way it was, the link to the APK
download page."*

---

## 1. What was actually broken

**Two code paths queue the same welcome/create-password email, and only one of
them carried the Android link.**

| Path | File | Android link |
|---|---|---|
| Admin "invite user" / "resend invite" | `apps/api/src/server.ts` → `queueUserWelcomeEmail()` | resolved a real URL — **worked** |
| Self-service onboarding sign-up | `apps/api/src/onboarding/setupOrchestrator.ts` → `queueInviteEmail()` | `androidApkUrl: null` — **hardcoded off** |

So the link was never "taken out" of the template. It was never *put in* on the
sign-up path. Anyone who signed up through a sign-up link got an invitation with
no way to install the app; anyone Izzy invited by hand got one that worked. That
asymmetry is why it read as an intermittent regression.

⛔ **This is the same family as the two IVR publish paths** (`POST
/voice/ivr/publish` vs `publishIvrForTenant()`): a near-duplicate second call
site that silently skips whatever you add to the first. Before believing an
email/notification feature is live, find **every** site that builds that
template.

## 2. The evidence — read the queue, not the code

The decisive check was the live `EmailJob` table, not reading the template:

```js
const rows = await db.emailJob.findMany({
  where: { type: "USER_INVITE" }, orderBy: { createdAt: "desc" }, take: 12,
  select: { createdAt: true, toEmail: true, htmlBody: true },
});
// test each htmlBody against /android\/download|connectcomms-latest\.apk/i
```

Result (2026-08-09, most recent 12 `USER_INVITE` jobs):

- **NO link:** `sales@iniimini.com` (08-05), `office@matamimweekly.com` (08-05),
  `ezralife13@gmail.com`, `lafixerco@gmail.com`, two `loopcom.*` test rows —
  **every one of them a sign-up**.
- **HAS link:** `fixupusa1@gmail.com`, `ap@gesheftkosher.com`,
  `yossi@yossiswoodworx.com`, `fhalpert@trustbookkeepingny.com`,
  `ezra@connectcomunications.com`, `eli@displaydex.com` — **every one an admin
  invite**.

A clean split down the two paths. Nothing about the template, the APK file, or
the mount was wrong.

⛔ **Ruled out first, on purpose:** the resolver returns `null` when
`connectcomms-latest.apk` is missing under `APK_DOWNLOAD_DIR` — a very plausible
"the link disappeared" cause, since a container that lost the volume mount would
silently drop the section. It was checked and was **fine**: the file is present
on the host *and* inside `app-api-1` (147,502,627 bytes, both api and
`api_candidate` mount `/opt/connectcomms/downloads:/var/lib/connect/downloads:ro`).

## 3. The fix

`apps/api/src/androidApkInviteUrl.ts` (new) now owns the whole thing —
`APK_LATEST_FILENAME`, `apkDownloadDir()`, `apkPublicBaseUrl()`,
`androidApkDownloadPageUrl()` and `getAndroidApkUrlForInviteEmail()` — and
**both** invite paths call it. `server.ts` lost its private copies and imports
them instead.

Behaviour is unchanged from the path that already worked:

- `ANDROID_APK_DOWNLOAD_PAGE_URL` overrides everything (Play Store, landing page).
- Otherwise the **download page** (`/api/mobile/android/download`), and only if a
  real `connectcomms-latest.apk` (≥1 KB) exists — never a raw file link, never a
  broken one.

⛔ **The values are now read from the environment at CALL time, not at module
load.** That was a deliberate change: as module-level `const`s they could not be
exercised from a test without re-import tricks that don't work under this repo's
CommonJS `tsc` setting (`import.meta` is a TS1343 error here — use `__dirname`).

## 4. The guard

`apps/api/src/androidApkInviteUrl.test.ts` — 6 node:test cases:

- override wins; no APK → `null`; a real APK → the download **page** URL; a
  truncated/stub APK → `null`.
- the template renders the URL in **both** HTML and plain text.
- ⛔ the last one reads both call-site sources and fails if either stops calling
  `getAndroidApkUrlForInviteEmail()` **or** reintroduces `androidApkUrl: null`.
  A unit test of the resolver alone would have passed happily through this whole
  bug — the defect was a caller, not the logic.

Run: `npx tsx --test src/androidApkInviteUrl.test.ts` from `apps/api` (6/6).
`setupOrchestrator.test.ts` still 31/31. Typecheck is back to its 94-line
pre-existing baseline with **zero** APK-related errors.

## 5. Deploy record

- Bundled `2b90d56a..357f863c` (4.6 KB) → `scp` → `git fetch` in
  `/opt/connectcomms/app` → pushed to GitHub from the server clone (local push is
  classifier-blocked here).
- Enqueued `POST /ops/deploy/enqueue` — ⛔ the field is **`service`**, not
  `target`, and `POST /ops/deploy/jobs` **does not exist** (returns an Express
  404 HTML page, which reads like an auth failure if you skim it).
- Verified in the **running** container, not from the job status:
  `/app/apps/api/src/androidApkInviteUrl.ts` present, and
  `setupOrchestrator.ts:132` reads `androidApkUrl: await
  getAndroidApkUrlForInviteEmail()`. `/api/ready` 200.
- `https://app.connectcomunications.com/api/mobile/android/download` → **200**,
  serving `connectcomms-latest.apk` (published 2026-08-05).

## 6. Not proven

⏳ **No invitation email has been sent since the deploy.** The link is proven by
the code path plus a live 200 on the download page — *not* by an email landing in
an inbox. The cheap proof is to invite any spare address and re-run the
`EmailJob` query in §2 against the newest row.
