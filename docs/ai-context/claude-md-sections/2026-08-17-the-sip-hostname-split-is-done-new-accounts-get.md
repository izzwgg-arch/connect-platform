# ⛔⛔ AGENT HANDOFF — the SIP hostname split is DONE: new accounts get Loopcom, every existing customer is PINNED where they were (2026-08-17) — READ FIRST before touching `SIP_PUBLIC_WS_URL`, before setting or clearing `tenant.sipWsUrl` on anybody, before trusting a deploy's `success` line, or before retiring ANY SIP hostname

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/PLAN_CLOUDFLARE_EDGE_SIP_SPLIT_2026-08-16.md` → Phase A2**
(`45923f4f` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**,
`.env.platform:106` flipped, and **one live DB change: `sipWsUrl` set on exactly 5 tenant
rows.** No nginx, no DNS, no Cloudflare, no PBX write, no telephony restart, no customer
contacted, no migration run by this work.)

- ⛔⛔ **THE SHAPE OF THE ANSWER, and it is the opposite of what was being attempted:
  Izzy wanted "existing customers stay exactly as they are; only accounts created from
  today onward use the Loopcom hostname," and `SIP_PUBLIC_WS_URL` is ONE GLOBAL VALUE.
  It was made to say that by PINNING THE OLD, NOT STAMPING THE NEW.** The five tenants
  that depended on the global were set to the hostname they already resolved to —
  `wss://sip.connectcomunications.com/sip`, which was the live value of the variable at
  that moment, so the write moved nobody — and the global was then free to become
  `wss://sip.loopcom.net/sip` and reach **only rows that do not exist yet**.
  ⛔ **This is why the "five creation paths" trap below never applied: nothing was added
  to tenant creation at all.** A new tenant takes the schema default
  (`webrtcRouteViaSbc = true`, `sipWsUrl = null`) and therefore takes the global. There
  is no helper to miss and no sixth creation site to forget.
- ⛔⛔ **PIN FIRST, FLIP SECOND. Reversing that order IS the outage** — flip while a live
  tenant still has `sipWsUrl = NULL` and that customer is handed the new address at their
  users' next sign-in, which is exactly what Izzy ruled out. The rule is written into
  `apps/api/src/sipPublicEndpoint.ts`'s doc block and a test keeps the sentence there.
- ✅ **PROVEN BY A BEFORE/AFTER RESOLUTION SNAPSHOT OF ALL 29 LIVE TENANTS, not asserted.**
  `resolveWebrtcConfig`'s logic was replayed against every live tenant inside `app-api-1`
  before the pin, after the pin, and after the deploy: **0 tenants changed what they
  resolve to, all three times.** Distribution is unchanged at 23 ×
  `wss://m.connectcomunications.com:8089/ws`, 5 × `wss://sip.connectcomunications.com/sip`,
  1 × `wss://209.145.60.79:8089/ws` (the second "Connect Communications", pre-existing).
  ⛔ **Do that snapshot before and after ANY future change here** — it is the only check
  that can tell "the global moved" from "a customer moved". Script pattern in the plan doc.
- ✅ **Tenants that now depend on the global: ZERO.** That is the safety property. The
  one-line check before touching the variable again:
  `SELECT name FROM "Tenant" WHERE "pbxRemovedAt" IS NULL AND "webrtcRouteViaSbc" AND
  "sipWsUrl" IS NULL;` — **any existing customer in that list would be moved by the
  change.** It should list only accounts you are content to move.
- **The five pinned** (`sipWsUrl` null → `wss://sip.connectcomunications.com/sip`,
  `webrtcRouteViaSbc` left true, nothing else touched): **B Visible, Displaydex, Gesheft,
  inii mini, Loopcom Demo**. Backup of the prior values:
  **`/root/sip-pin-backup-2026-08-17T2223Z.json`** on loopcom. **Rollback = set those five
  ids' `sipWsUrl` back to `null`** — but ⛔ **only after putting the global back**, or the
  rollback itself hands them loopcom.
- ⛔ **`tenant.sipWsUrl` WINS OUTRIGHT, even when `webrtcRouteViaSbc` is false.**
  `resolveWebrtcConfig` (`apps/api/src/server.ts:773`): **explicit `sipWsUrl` → else if
  `webrtcRouteViaSbc` the global `sipPublicWsUrl()` → else `pbxWsEndpoint`**, and only
  then does `normalizeSipWsUrlHost` rewrite **IP-literal hosts only** (so pinning an FQDN
  is a no-op through it — that is what makes the pin behaviour-preserving). That
  precedence is the load-bearing fact of this whole arrangement; `sipRouteDefault.test.ts`
  and `sipPublicEndpoint.test.ts` both guard it.
- ⛔ **20 tenants were ALREADY pinned per-tenant long before this** — to a **direct-PBX**
  URL (`wss://m.connectcomunications.com:8089/ws`, or the raw IP on the five newest) — and
  four more (NY Garden Sprinkler, Connect, Coat One Seal Coating, Connect Communications)
  are `sipWsUrl=null` **and** `viaSbc=false`, so they take `PBX_WS_ENDPOINT`. The plan
  doc's old "sipWsUrl is NULL on all four" line was never true platform-wide.
  ⛔ **So a new account is now materially different from those 24: it goes through the
  nginx `/sip` 443 proxy, not direct to the PBX on :8089.** That was Izzy's deliberate
  call in `8495d379` (filtered internet is the norm for this customer base), not a
  side effect of the hostname change.
- ⏳ **NOT PROVEN, and this is the honest limit: no softphone has ever registered against
  `sip.loopcom.net`.** It answers **101** from the server and the api hands it out, but
  nothing has completed a SIP REGISTER through it — because no new tenant has been created
  since the flip, and every existing client keeps its cached URL forever. **The acceptance
  test is the next real sign-up**, judged from the PBX contact list
  (`pjsip show endpoint T<t>_<ext>_1` reading `Avail`), never from a client's own
  "registered". ⏳ **Nobody has re-authenticated** on any of the five pinned tenants either,
  so the pin is proven as resolution, not as a completed registration.
- ⛔ **AND A MISSED CREATION PATH WOULD FAIL PERMANENTLY, NOT SOFTLY.** Nothing sets
  `sipWsUrl` at tenant creation — **all five creation sites**
  (`onboarding/onboardingPayment.ts:89`, `onboarding/setupOrchestrator.ts:269`,
  `pbxExtensionSync.ts:312`, `server.ts:2390`, `server.ts:5557`) create it **null**. It is
  stamped **later**, by two WebRTC-enable backfills (`server.ts:9511`,
  `pbxExtensionSync.ts:628`), each writing the **direct-PBX** endpoint under a
  `!tenantRow.sipWsUrl` guard **and skipped entirely for 443 tenants** (`8495d379`).
  ⛔ **This trap is now AVOIDED rather than solved, and the distinction matters:** the
  pin-the-old design means nothing needs stamping at creation, so there is no helper to
  miss. **If anyone ever does decide to stamp `sipWsUrl` at creation, this trap comes
  straight back** — a path that missed the helper would be pinned to the OLD route forever
  by the first extension sync, silently and permanently for that customer. Route all five
  through one shared helper and guard it with a test that reads every call site's source.
  ⛔ Also noted in passing, pre-existing and **not** fixed: `server.ts:9500` canonicalises
  the IP before persisting and `pbxExtensionSync.ts:620` does **not**, which is why the
  five newest tenants carry a raw-IP `sipWsUrl` while older ones carry the FQDN.
- ⛔ **`webrtcRouteViaSbc` is consumed by NO live client.** Every reference outside
  `apps/api/src` is in `apps/frontend-legacy/portal-v2-legacy/`, which CLAUDE.md already
  records as dead code (in no compose file, no workspace entry). It is purely a
  server-side selector for *which fallback* to use — so it cannot be relied on to signal
  anything to a phone.

- ✅ **`sip.loopcom.net` SERVES SIP.** 101 + `Sec-WebSocket-Protocol: sip`, own Let's
  Encrypt cert (expires 2026-11-14, auto-renewing), port 80 → 301, non-`/sip` → 404.
  **All three pre-existing SIP hostnames still return 101** — additive, no regression.
  `/api/health` 200, portal 200, bad login 401, default TLS server still
  `CN = app.connectcomunications.com`.
- ✅ **THE FLIP IS LIVE, FILE AND CONTAINER NOW AGREE, AND IT REACHES NOBODY WHO ALREADY
  EXISTS** (this bullet has been wrong in three different directions across three
  sessions — read it as of 2026-08-17 22:30 UTC and re-verify before quoting it).
  `.env.platform:106` = `wss://sip.loopcom.net/sip`, and
  `docker exec app-api-1 sh -c 'echo $SIP_PUBLIC_WS_URL'` reads the same, on the container
  built `45923f4f`. Backup of the pre-flip file:
  `/opt/connectcomms/env/.env.platform.bak.20260817T222410Z.sipflip-loopcom` (`diff` =
  **exactly one changed line**, and only one occurrence of the variable exists in the file).
  ⛔ **What the live value does and does not mean:** it is now the **NEW-TENANT** hostname
  only — every existing tenant is pinned, so nobody is handed it on a fresh sign-in today;
  and **every already-signed-in client keeps its cached `sipWsUrl` forever** regardless.
  Judge who moved by the PBX contact list (`pjsip show endpoint T<t>_<ext>_1` reading
  `Avail`), never by a client's own "registered".
  ⛔ **This makes retiring `sip.connectcomunications.com` MORE dangerous, not
  less** — five tenants are now explicitly pinned to it *and* clients hold it cached, so
  it must never be retired on a schedule.
  ⛔ *(Historical, kept because the lesson stands: an env-only change cannot trigger a
  rebuild, so a flip sits staged on disk until an api deploy that touches api code carries
  it — which is exactly why an env change is only ever proven by `docker exec`, never by a
  deploy's exit line. **This deploy shipped a real `apps/api/` commit, so it rebuilt: build
  127 s, blue/green completed, `verify: container commit 45923f4f2d70 matches target`.**)*
- ⛔⛔ **THE TRAP TO KNOW ABOUT — A DEPLOY THAT PRINTS `success` AND CHANGES NOTHING.**
  `deploy-direct.sh api` exited **`success`** while logging, mid-output,
  `skip=unrelated_paths` → *"no api-relevant paths changed — skipping build/restart"*.
  `deploy_common_needs_rebuild` (`scripts/lib/deploy-common.sh:313`) decides purely on
  whether api-relevant **paths** changed — **an env var is not a path, so an env-only
  change can NEVER trigger a rebuild.** ⛔ **After any env change the ONLY proof is
  `docker exec app-api-1 sh -c 'echo $SIP_PUBLIC_WS_URL'`. Never trust the exit line** —
  it is the last thing printed and it says success.
- ⛔ **`DEPLOY_FORCE_RESTART=1` DOES NOT WORK for api** (tried; identical skip). There is
  **no `--force` flag** on `deploy-direct.sh`, and the deploy queue runs the same script.
  `docker compose up -d api` is **forbidden** (AGENTS.md rule 12 — the historic `/api/*`
  502 class). **So an env-only api change has NO sanctioned deploy path**, and one earlier
  session correctly stopped rather than improvise one.
  ✅ **The way through, used on 2026-08-17 and reusable: ship the env change alongside a
  REAL `apps/api/` commit.** Not a touch-file — the commit that landed with this flip
  corrects `sipPublicEndpoint.ts`'s doc block, which had gone factually wrong (it still
  claimed no per-tenant edit could move a 443 tenant), plus two guard tests. ⛔ Anything
  under `apps/api/`, `packages/db|shared|integrations|security/`, the lockfile,
  `package.json`, `docker-compose.app.yml`, `Dockerfile*` or `tsconfig*.json` triggers the
  rebuild (`_deploy_common_service_paths`, `scripts/lib/deploy-common.sh:285`) —
  **`docs/` and `CLAUDE.md` do NOT**, which is why two docs-only commits sat undeployed.
  ⛔ **Check `git diff --name-only <container .build-commit>..HEAD -- packages/db/prisma/`
  before deploying** — empty means `prisma migrate deploy` is skipped, which is how you
  know you are not shipping a surprise migration.
- ⛔ **FULL ROLLBACK, AND THE ORDER IS THE MIRROR OF THE ROLLOUT — GLOBAL FIRST, PIN
  SECOND.** (1) restore `/opt/connectcomms/env/.env.platform.bak.20260817T222410Z.sipflip-loopcom`
  (diff = exactly one line, 106) and deploy api with a real `apps/api/` commit;
  (2) *only then* set `sipWsUrl` back to `null` on the five ids in
  `/root/sip-pin-backup-2026-08-17T2223Z.json`. **Unpinning while the global still says
  loopcom hands those five customers the new hostname** — the one outcome to avoid. Either
  half alone is safe and inert; only that order is wrong. The DNS record, cert and nginx
  block are additive and harmless either way.
- ⛔ **Squarespace's Google re-auth gates the WRITE, not the READ.** The DNS page renders
  unattended, but `ADD RECORD` throws *"Verify to continue as support@…"*; **Izzy had to
  sign in**, after which the record went in with no further prompt. Two UI traps on that
  form: **`ADD RECORD` needs TWO clicks** (the first silently does nothing), and the
  **TYPE control is a custom `DIV`, not a `<select>`** — `form_input` fails on it; click
  it open and click the option. ✅ **The tell that the type took is the last field's label
  changing from `DATA` to `IP ADDRESS`.** Re-read the form before saving.
- **Backups:** `/root/nginx-full-backup-20260816-222322.tar.gz` (whole `/etc/nginx`),
  `/root/nginx-connectcomms-backup-20260816-222322.conf`,
  `/root/nginx-connectcomms-sip-backup-20260816-222322.conf`,
  `/root/connectcomms-sha256-20260816-222322.txt`,
  `/opt/connectcomms/env/.env.platform.bak.20260816T202641Z`. ⛔ **`certonly` proved
  itself:** `sites-available/connectcomms` is **byte-identical** after the whole
  operation (sha256 `a33f0c7f…`) — capture that hash up front, it is the only way to know
  certbot did not rewrite a hand-written vhost.
- ⛔⛔ **A `403` ON `app.*/sip` FROM IZZY'S WORKSTATION IS HIS CONTENT FILTER, NOT A
  REGRESSION — this was one step from being filed as an outage.** From his line,
  `app.connectcomunications.com/sip` and `app.loopcom.net/sip` return **403** while
  `sip.connectcomunications.com/sip` returns **101** on the same machine; the identical
  probe **from the server returns 101 on all three**. The filter categorises the `app.`
  hostnames differently. **Re-run any SIP-hostname probe from the box before believing
  a failure.** ⛔ And use `curl --http1.1` with the upgrade headers — a plain curl
  returns **426**, which is the wrong test, not a fault.
- ⛔ **`app.` and `sip.` are NOT the same SIP path.** `sites-available/connectcomms`
  proxies `/sip` to **`127.0.0.1:7443`** — the `sbc-kamailio` container, the unfinished
  experiment that has never carried a call — while `connectcomms-sip` and
  `connectcomms-loopcom` go **straight to `m.connectcomunications.com:8089/ws`**. All
  three answer 101, so the upgrade proves the **route, not the call**. Any new SIP vhost
  must mirror the **direct-to-PBX** form.
- ⛔ **The filename of a new vhost is load-bearing.** `sites-enabled/*` loads in sorted
  order and the first `listen 443` block is nginx's default server for unmatched
  hostnames. Today that is `connectcomms` (verified live: unmatched SNI returns
  `CN = app.connectcomunications.com`). Use **`connectcomms-sip-loopcom`**, which sorts
  last; a name like `app-sip` would silently steal the default server.
- ⛔ **This is ADDITIVE and `sip.connectcomunications.com` can NEVER be retired on a
  schedule.** Clients cache `sipWsUrl` forever and the apps never refresh it — which is
  exactly why the flip is safe *and* why it moves nobody until they sign out and back in.
  Retiring an old SIP hostname while one client still holds it cached is the only way
  this work causes an outage.
- ⛔ `apps/api/src/sipPublicEndpoint.ts` is **one global value by design** — after the
  flip a portal user on `app.connectcomunications.com` would be handed a **loopcom.net**
  SIP host. Per-domain SIP is an **open decision the owner has not made**; do not "fix"
  it unasked.
- ⛔ **A bad-credential login that reads 500 is probably your shell.** It first returned
  **500** here; that was **nested-ssh quoting mangling the JSON**, not the API. With
  `--data @file` it is a clean **401 `invalid_credentials`**.
- ✅ **loopcom.net was not collaterally damaged** — re-verified after the DNS edit: apex
  still returns all **four** Squarespace A records, **five** Google MX records intact,
  `www` CNAME intact, `https://loopcom.net/` still **200**.
