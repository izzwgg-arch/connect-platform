# ⛔⛔ AGENT HANDOFF — LOOPCOM WORKS (TrimPro → Loopcom product): inventory, architecture, mockups, repo layout, and the looks-only reskin (2026-09-18) — READ FIRST before touching `Loopcom works/`, the `works/loopcom-works` branch, `apps/agent/src/conversation/routes.ts`, or anything named `WorksIntegration` / `/api/v1/works/*`

Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_WORKS_2026-09-18.md`**. Audits (8, verbatim):
`docs/ai-context/loopcom-works-audit/`. Mockups: https://claude.ai/artifact/LZvf79qD8f5aF3nfQ55nDy
(repo copy `docs/mockups/loopcom-works/mockups-v1.html`). Memory: [[loopcom-works-project]].

- **What it is:** TrimPro (field-service app, 6 months in prod for its original customer at
  `154.12.235.86` — ⛔ untouched, out of scope) copied to `Loopcom works/` in THIS repo (Izzy:
  "use the regular Loopcom Connect Git repo") to become **LoopCom Works** at
  `https://works.loopcom.net` on its own server: same layouts/workflows, Loopcom's real look +
  logo, SSO from the portal (no second password), standalone sign-in too, the SAME Loopcom AI
  for both, click-to-call/screen pop/SMS/timeline via a Loopcom API for entitled companies,
  security pass, mobile rebrand, prod deploy, 20× E2E proof. Mockups first (Izzy's rule).
- **Repo layout (DONE):** nested 3.8 GB `.git` moved to `C:\dev\projects\_backups\loopcom-works-nested-git-2026-09-18\`
  (history also on `izzwgg-arch/Trimpro`); `Loopcom works/.gitignore` blocks the 2.5 GB of
  tarballs/APKs/logcats + `.env` + `apps/mobile/credentials.json`; Connect `.easignore`/`.dockerignore`
  exclude the folder; the legacy TrimPro DB password scrubbed from 6 scripts. Work goes through the
  private worktree `C:\dev\projects\c2-works` on branch **`works/loopcom-works`** (cut from
  origin/feat/ivr-migration-takeover @ 8fad6359) — the shared tree is 60 ahead / 152 behind.
  ⛔ `prisma/migrations/*/migration.sql` is GITIGNORED in the copy (8 of 25 tracked) — a fresh
  clone can't `migrate deploy` until phase 3 baselines it.
- **Audits (8 Sonnet agents, read-only, all re-read by the lead):** A1 787 TrimPro strings (PDF
  fallback logo is an SVG *string* with "TrimPro" in it; QBO sync writes "Trim Pro …" into
  customers' QuickBooks; 3 domains hardcoded ~55×; `middleware.ts` rewrites hosts to
  app.trimprony.com). A2 96 pages/278 routes, **3,990 hard-coded colours, dark mode dead**.
  A3 real mobile app = `apps/mobile/` (Expo 54, managed, bundle `com.trimpro.field` welded to
  Firebase). **A4 13 CRITICAL** (unauth'd `set-password`; unsigned Sola payment webhook; self-promote
  to ADMIN via roles; 6 cross-tenant IDOR write paths; unauth'd QBO OAuth callbacks; open
  `bootstrap/admin`) + 7 HIGH (secrets in `next.config.js env`, no rate limits, unauth'd
  `/uploads/*`, SSRF via image optimizer, next 14.0.4 CVEs, no CSP/HSTS). A5 portal tokens
  (`globals.css` 3410/12223/13749; 56px topbar, 280/72 sidebar, 1080 breakpoint; ⛔ portal's
  `--crm-*` is dark-only and "Inter" is never loaded — don't copy). A6 agent = Fastify :3920, no
  streaming, existing `x-agent-internal-secret` + asserted-identity door; `AgentConversation.tenantId`
  is a plain string (no FK) → standalone Works orgs use `works:<orgId>`. A7 api JWT has no exp/no
  session table; **no click-to-call route** (`AriActions.originate` exists, 0 callers); **no outbound
  webhook model**; SMS = `/chat/threads`; live calls on `/ws/telephony`. A8 Works prod uses
  `db push --accept-data-loss`, single PM2 fork; Connect deploy = blue/green + `.build-commit`.
- **Architecture DECIDED (§3 of the handoff):** identity by immutable ids (`Tenant.loopcomTenantId`,
  `User.loopcomUserId`, Connect `WorksIntegration{tenantId, worksOrgId, enabled}`); SSO = 60-s
  single-use handoff code minted by api (`googleLogin.ts` pattern, DB-backed) → Works exchanges it
  server-to-server → Works issues its own existing tokens; revocation = validate on refresh + push
  events; Works inside Loopcom = **seamless navigation + SSO, not an iframe**; API = `/api/v1/works/*`
  on Connect + `/api/v1/loopcom/*` on Works, one platform HMAC service key (ts+nonce+body hash,
  replay cache), tenant scoping verified per call; events = NEW outbound signed-webhook dispatcher in
  `apps/worker` (`WebhookSubscription`/`WebhookDelivery`), screen pop = `call.ringing` → Works
  socket.io; AI = third `resolveIdentity()` branch + `worksTools.ts` calling Works' tool door with
  the verified identity, confirm-gated writes via `AgentAction`, Works can never be platform staff;
  security fixes in 13 ordered steps before the first deploy; deploy = Docker Compose per
  `infra/community/` precedent + baseline migration + port-pair + nginx backup member + nightly
  pg_dump off-box + restore drill; staging at `works-staging.loopcom.net`.
- ⏳ **Izzy's six decisions (handoff §5):** approve mockups (+ "Works" tag vs re-rendered lockup;
  grouped vs flat sidebar); keep `com.trimpro.field` or new bundle ids; legal entity + support/sender
  addresses; provision the server + DNS; rename `Loopcom works/` → `loopcom-works/`; Works' own
  Sola/Cardknox merchant account.
- **PHASE 2 DONE the same evening — the looks-only reskin + rebrand (Izzy: "Build it and then
  start the dev server" / "No change on the code, just looks. Every button, every click must
  work").** How: instead of editing 153 pages, `tailwind.config.ts` re-points every Tailwind
  hue at CSS vars from `lib/branding/loopcom-palette.ts` (portal light/dark values; neutrals as
  a monotonic surface scale, chromatic hues inverted shade-for-shade in dark; `white` kept for
  `text-white`, `bg-white` flipped by `.dark .bg-white`), `app/globals.css` maps shadcn +
  `--brand-*` defaults onto the portal tokens and adds the shell primitives (`lw-topbar`,
  `lw-sidebar`, `lw-nav-link`, `lw-login*`), `next-themes` wired (`lw-theme`, class strategy,
  Sun/Moon in the sidebar footer + segmented toggle on login), `components/ui/*` restyled (class
  strings only), sidebar/topbar/login/auth/public layout restyled (handlers untouched), logo
  components keep their exports but render `/brand/loopcom-wordmark-560.png` + a "Works" tag,
  favicon/manifest/metadata/OG from the Signal Core kit, email shell + statement/PDF colours to
  the Loopcom palette, `middleware.ts` canonical host → `works.loopcom.net` (`CANONICAL_APP_HOST`).
  Two fenced Sonnet agents did the text-only sweeps: 59 web files (`Trim Pro`→`LoopCom Works`,
  `support@loopcom.net`, Terms/Privacy party `Loopcom LLC`, PDF fallback-logo SVG text, email
  defaults) and the Expo app (`app.json` name/permission strings/splash colours, Signal Core
  icon+splash+adaptive+favicon, `loopcom-wordmark.png` on login, theme tokens, 9 screens'
  brand hexes) — bundle ids/schemes/domains/storage keys/`qbo-sync.ts` untouched. ✅ PROOF:
  production `next build` ✓ (382 routes); tsc 207 = baseline; node:test 154/156 (2 fail on the
  untouched import too); **click-through E2E on the prod build: form login → 25 sidebar pages
  (content, 0 page errors) → create + edit client through the real forms → estimate/invoice/PO
  detail + 200 `application/pdf` → theme + collapse persist → search → logout = 40/41 (the 1
  was the test's own assertion; fixed)**, 20-iteration run in `TESTS_RUN.md`; light+dark
  screenshots of login/dashboard/clients/client/invoice/settings reviewed. ⛔ prod build
  redirects localhost/IP hosts (TrimPro's canonical rule) — test it as
  `http://works.localtest.me:3002`; dev is `npm run dev:3001` (3000 is another TrimPro dev
  server). ⏳ NOT PROVEN: Izzy's eyes; mobile build; dark on all 96 pages (6 reviewed); email
  look by a human. Security fixes + Loopcom integration still wait for his go.
- ⛔ **NOT PROVEN / NOT DONE (phase 0):** no server exists;
  no SSO/API/agent code written; mockups reviewed by nobody yet. Browser 1 (office Chrome, signed in)
  froze its renderer on the portal `/dashboard` ("Application error") — portal issue, noted only.
- **Build order:** phases 1–8 in handoff §6 (security → brand/reskin → server → Connect API/SSO →
  Works comms → agent → mobile → 20× stress), each committed by pathspec on `works/loopcom-works`.
