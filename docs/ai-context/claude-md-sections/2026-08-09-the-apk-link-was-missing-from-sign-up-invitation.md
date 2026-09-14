# ⛔ AGENT HANDOFF — the APK link was missing from sign-up invitations (2026-08-09) — READ FIRST before changing ANY invite/welcome email, or for "the link got taken out of the email"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_INVITE_APK_LINK_2026-08-09.md`**
(commit `357f863c` on `feat/ivr-migration-takeover`, api DEPLOYED and
container-verified, queue job `c649d756`).

- ⛔ **TWO paths queue the SAME welcome/create-password email**, and only one had
  the Android link: the admin invite path (`server.ts` →
  `queueUserWelcomeEmail`) resolved a real URL, while the self-service onboarding
  path (`onboarding/setupOrchestrator.ts` → `queueInviteEmail`) passed
  **`androidApkUrl: null`**. It was never removed from the template — it was
  never put in on that path, so **every customer who signed up themselves got an
  invitation with no way to install the app** while hand-sent invites worked.
  Same family as the two IVR publish paths: find EVERY site that builds a
  template before believing an email feature is live.
- ⛔ **The proof is the `EmailJob` queue, not the template.** Testing the last 12
  `USER_INVITE` bodies for `/android\/download|connectcomms-latest\.apk/i` split
  perfectly down the two paths (sign-ups had none: iniimini, matamimweekly,
  ezralife13, lafixerco; admin invites all had it). Reading the template would
  have shown a correct-looking `androidSection` and proved nothing.
- **Ruled out first, deliberately:** the resolver returns `null` when
  `connectcomms-latest.apk` is missing under `APK_DOWNLOAD_DIR` — a container
  that lost that mount would silently drop the section. Checked: the file is on
  the host AND inside `app-api-1` (147.5 MB; both `api` and `api_candidate` mount
  it read-only).
- **Now in one place:** `apps/api/src/androidApkInviteUrl.ts` owns the APK dir,
  base URL, download-page URL and `getAndroidApkUrlForInviteEmail()`; both invite
  paths call it. Behaviour unchanged — `ANDROID_APK_DOWNLOAD_PAGE_URL` overrides,
  otherwise the download **page**, and only when a real (≥1 KB) APK exists so a
  broken link is impossible. ⛔ Values are read at **call time, not module load**,
  so they are testable; `import.meta` is a **TS1343 error** in this repo (module
  is CommonJS) — use `__dirname`.
- **Guard:** `androidApkInviteUrl.test.ts` (6 cases) tests the resolver AND reads
  both call-site sources, failing if either drops the helper or reintroduces
  `androidApkUrl: null`. ⛔ A resolver-only unit test passes straight through this
  bug — the defect was a **caller**.
- ⛔ **Deploy-queue shape:** `POST /ops/deploy/enqueue`, field **`service`** (not
  `target`). `POST /ops/deploy/jobs` does not exist and answers with an Express
  **404 HTML page** that skims like an auth failure.
- ⏳ **NOT PROVEN: no invitation has been sent since the deploy.** Proven by the
  code path in the running container plus a live 200 on
  `/api/mobile/android/download` — not by an email in an inbox. Invite a spare
  address and re-run the `EmailJob` query in §2 of the handoff.
