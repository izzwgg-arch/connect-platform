# ⛔⛔ AGENT HANDOFF — the platform's public identity lives in ONE module now (`publicOrigins.ts`), the SIP/WS/pay/email links follow the host you are on, and `/auth/signup` is shut (2026-08-19) — READ FIRST before typing `app.connectcomunications.com` or `loopcom.net` into ANY source file, before adding a link to an email, before touching the Google OAuth redirect, or before answering "does Loopcom do everything the old domain does?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §11**
(`6a0f3a01` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified.** No env change, no DNS change, no tenant row touched.)
Izzy, 2026-08-18: *"The whole connectcomunications platform is going to become
loopcom.net. I want to have Loopcom completely set up 100% in parallel with
connectcomunications before I remove connectcomunications from the platform …
Top to bottom, A to Z, everything."*

- ⛔⛔ **THE RULE: no source file names a hostname. `apps/api/src/publicOrigins.ts`
  is the ONE place** — `PLATFORM_PORTAL_HOSTS` (`app.connectcomunications.com`,
  `app.loopcom.net`), `canonicalPortalOrigin()` / `canonicalApiBase()` (durable
  links that must work from an email months later — **one env flip,
  `PUBLIC_PORTAL_URL`, moves the whole platform**), `portalOriginForRequest(req)` /
  `apiBaseForRequest(req)` (browser-facing answers follow the host the person is
  on — ⛔ **only OUR hosts count**; a forged `Host` cannot mint a foreign link),
  `oauthRedirectUriForRequest(req, registered)` (keeps the REGISTERED path, swaps
  only the origin), and the mail identity (`support@`/`billing@`/`noreply@` under
  `PLATFORM_MAIL_DOMAIN`). ~30 literal sites across apps/api now call it — pay
  links (**11 had no env override at all**), email templates, PBX webhook default,
  OAuth, SBC probes, which between them had been reading **seven different env
  names**. `publicOrigins.test.ts` sweeps the tree and fails if the literal
  reappears as CODE (the one allow-listed exception is `LEGACY_SIP_WS_URL` in
  `sipPublicEndpoint.ts`, which is a *pin* to the old SIP host on purpose).
- ⛔ **What "parity" means today, so nobody re-audits it:** both hostnames serve
  the same nginx block (11 paths, headers, TLS, cert, ban lists, `/brand/`,
  `/sip`), both mail domains carry SPF + DKIM + DMARC `p=none`, and the api answers
  every browser request for the host it was asked on. **What is still one global
  value:** `PUBLIC_PORTAL_URL` (unset → durable links say the OLD host until Izzy
  flips it — the cut-over lever), `SIP_PUBLIC_WS_URL` (already `sip.loopcom.net`
  for new tenants), the Google OAuth client (⛔ **`https://app.loopcom.net/api/crm/
  email/oauth/callback` and the drive callback must be registered in Google Cloud
  or Gmail/Drive sign-in on Loopcom fails at Google, not at us**), the mailboxes
  (`support@`/`billing@loopcom.net` exist only if Google Workspace has them — the
  domain being verified proves nothing), `m.loopcom.net` for the PBX (⛔ PBX write:
  DNS + cert, needs a mandate), and the legal name on invoice PDFs.
- ✅ **Portal: the live-call WebSocket is SAME-ORIGIN now**
  (`hooks/useTelephonySocket.ts` `resolveTelephonyWsUrl` — the build env is
  honoured only on the very host it names, or localhost). It was baked as the old
  host, so **a Loopcom user opened their call feed cross-origin to the old
  domain**; compose no longer bakes that default. Desktop-installer and Android
  links are relative; the sign-up pages take the support address from
  `lib/platformIdentity.ts`. Guard: `lib/loopcomParity.test.ts` (registered).
- ✅ **`/auth/signup` is OFF unless `PUBLIC_SIGNUP_ENABLED=1`** (answers 404 like an
  unrouted path) **and no longer grants role `ADMIN` to `support*@connectcomunications.com`**.
  It was public, unverified, had **0 callers** in the repo and **1 nginx hit in 14
  days**, and `ADMIN` is exactly the role that arms three latent tenant-isolation
  findings.
- **Worker + `packages/integrations`** ride the same env chain (a bug where
  `PORTAL_PUBLIC_URL`, an origin, was used as an API base is gone). **Mobile:**
  `apps/mobile/src/config/publicOrigin.ts` is the ONE constant for the next
  (Loopcom) build; six literals routed through it; ⛔ no behaviour change until an
  APK/TestFlight build ships.
- ⛔⛔ **THE WORKER HALF OF THIS SHIPPED HOURS LATE, AND THAT IS THE LESSON: an
  api+portal deploy does NOT deploy the worker.** `deploy-direct.sh` takes
  `api|portal` only, so `apps/worker` and `packages/integrations` sat on an
  **18 August image** while the round-3 commit was reported deployed — found only
  because Izzy asked "is everything from this chat deployed?" (`app-worker-1` has
  **no `/app/.build-commit`** at all, so the usual check silently answers nothing —
  grep the container for a marker string instead). ✅ **Deployed 2026-08-19 at
  `95beef53`** (`DEPLOY_BRANCH=feat/ivr-migration-takeover DEPLOY_FORCE_RESTART=1
  bash scripts/deploy-worker.sh` — ⛔ it takes **env vars, not `--branch`**, and
  answers `FAIL: DEPLOY_BRANCH or DEPLOY_COMMIT is required` otherwise; ~15 min),
  verified by grepping the running container (1 hit in `connectChatSmsJob.ts`, 2 in
  `pbx-wirepbx`), 0 restarts, no error-level lines.
  ⛔ **It changed NOTHING at the time and that is exactly why it was easy to
  miss** — all six env names in that chain (`PUBLIC_API_BASE_URL`,
  `API_PUBLIC_URL`, `PORTAL_PUBLIC_URL`, `PUBLIC_PORTAL_URL`, `CONNECT_APP_URL`,
  `APP_PUBLIC_URL`) are **unset in the worker**, so old and new code both fell
  through to the same literal. **It would have bitten at the cut-over**: the old
  chain never reads `PUBLIC_PORTAL_URL`, so the worker would have kept emitting
  the OLD domain in MMS media links after the flip, and if anyone ever set
  `PORTAL_PUBLIC_URL` it would have built an API base with no `/api`.
- ⏳ **NOT PROVEN: no Loopcom-host OAuth sign-in, no email opened from a Loopcom
  link, no phone paired from `app.loopcom.net`.** The cut-over itself
  (`PUBLIC_PORTAL_URL` → `https://app.loopcom.net`, then removing the old vhost) is
  Izzy's decision and is NOT started.
