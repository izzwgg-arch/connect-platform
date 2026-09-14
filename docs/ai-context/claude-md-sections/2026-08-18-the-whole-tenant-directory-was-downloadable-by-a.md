# ⛔⛔ AGENT HANDOFF — the whole tenant directory was downloadable by a stranger, and two doors that "checked a secret" had no secret (2026-08-18) — READ FIRST before touching `/internal/*`, the VoIP.ms SMS webhook, any signed-URL helper, or before believing a guard that reads an env var

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0a**
(`d4184c26` on `feat/ivr-migration-takeover`. nginx **LIVE and verified from
outside**; api **DEPLOYED and container-verified** — `/app/.build-commit` reads
`d4184c26a828`. No PBX write, no migration, no env edit, no DNS/Cloudflare
change, no tenant row touched.)
⛔ **The deploy log's last line reads `done 49b617e4`, which is NOT this commit
and is NOT a failed deploy** — another session pushed three portal/docs commits
while the build ran, so that line reports the clone's HEAD after a later fetch.
**The `verify:` line and `/app/.build-commit` are the authority, and both read
`d4184c26a828`.**

- ⛔⛔ **`GET /api/internal/telephony/pbx-tenant-map` RETURNED THE ENTIRE TENANT
  DIRECTORY TO AN ANONYMOUS CALLER — 200, 24,839 bytes, on BOTH hostnames.**
  Proven live from a workstation, not inferred. Every `/internal/*` route is on
  the JWT bypass list, nginx proxied `/api/` with **no path exclusion**, and the
  shared secret that nominally guards them (`CDR_INGEST_SECRET`) is **EMPTY in
  api, telephony and worker** while the guards **fail OPEN**
  (`if (!secret) return true`). `POST /internal/cdr-ingest` would equally have
  let a stranger write calls into any tenant's history.
  ✅ **Closed at nginx** — `location /api/internal/` allowing only loopback, the
  docker bridges and the PBX, then `deny all`, on **both** vhosts. Now **403**
  externally (nginx's own, `Server: nginx/1.24.0`) while loopback and the PBX
  still get 200. Backups `/root/nginx-connectcomms{,-loopcom}-backup-20260818-015655Z-internal-deny.conf`.
- ⛔⛔ **THE FILE THE AUDIT NAMED IS NOT THE FILE NGINX LOADS.**
  `sites-enabled/connectcomms` is a **REAL FILE** (8,864 B, `connect_api_active`
  blue/green upstream); `sites-available/connectcomms` is a **stale 4,780 B copy**
  still pointing at `127.0.0.1:3001`. **Editing the sites-available one changes
  nothing and looks like a successful fix.** Only `connectcomms-loopcom` is a
  symlink. ⛔ Always `stat`/`diff` the two before editing either.
- ⛔⛔ **THE `/internal/*` CODE STILL FAILS OPEN, DELIBERATELY — AND MAKING IT
  FAIL CLOSED TODAY IS A PLATFORM-WIDE OUTAGE.** Every internal caller omits the
  header when the secret is empty (`...(secret ? { "x-cdr-secret": secret } : {})`),
  so a fail-closed flip rejects CDR ingest (calls vanish from history), mobile
  ring/wake pushes (phones stop ringing), voicemail-notify and PBX event ingest.
  **The fix is a SEQUENCE and the order IS the safety property:** set
  `CDR_INGEST_SECRET` in `.env.platform` → restart **api + telephony + worker**
  together → *then* make `verifyCdrSecret` (`server.ts:18351`) and the 8 inline
  sites fail closed. A partial rollout is the same outage.
- ⛔ **Internal callers do NOT go through nginx — that is what made the deny
  safe, and it was checked before it was applied, not after.**
  `CDR_INGEST_URL=http://api:3001/internal/cdr-ingest` (docker DNS). 14 days of
  logs hold **18** `/api/internal/*` requests total: 17 from the PBX to
  `wake-extension`, **all already 400**, plus one scanner. ⛔ **Read the access
  log for real callers before denying anything** — the answer was not guessable.
- ✅ **The VoIP.ms inbound SMS webhook now FAILS CLOSED**
  (`apps/api/src/voipMsWebhookAuth.ts`). It was `let authorized = !cfg.webhookSecretEncrypted`
  with the 401 **itself gated on the secret existing**, and no secret has ever
  been set — so anyone knowing a customer's public DID could inject a message
  into their inbox from any sender, with push notifications and a CRM timeline
  entry. ⛔ **The audit warned that failing closed alone "would stop real inbound
  SMS". It does not, and that was PROVEN before shipping:** all **127** webhook
  POSTs in 14 days carried VoIP.ms's **unsubstituted placeholders**
  (`from={FROM}&to={TO}`) — **zero real messages, ever.** Real inbound arrives by
  the worker's poll. ⛔ **Ask the log what a webhook actually receives before
  assuming it carries traffic.**
- ✅ **Chat signed URLs are keyed now.** `buildChatDbSignedDownloadUrl` /
  `verifyChatDbSignedDownload` used **`createHash` — an UNKEYED digest**, so
  anyone who had seen one message payload could mint a permanent, self-renewing
  download URL. Now `createHmac`. And `signingSecret()` fell back to the literal
  **`"dev-signing-secret"`, which is in this repo** — so `exp` was meaningless and
  any expired URL could be re-signed.
- ⛔⛔ **api AND worker ALREADY DISAGREED ON THE CHAT KEY — the audit's env table
  is right for api and wrong for the worker.** `MOH_URL_SIGNING_SECRET` is EMPTY
  in `app-api-1` but **43 chars** in `app-worker-1`/`app-telephony-1`, and the old
  chain was `CHAT || MOH || CDR || literal` — so api signed with the literal while
  the worker signed with the MOH secret, and **every worker-minted chat link was
  already silently unverifiable.** The chain is now `CHAT_URL_SIGNING_SECRET` else
  a key **derived from `JWT_SECRET`** (verified byte-identical across all three
  containers via sha256 fingerprint), else **throw**. ⛔ **Never re-add a literal,
  and never re-add MOH/CDR to this chain** — cross-purpose secrets are what made
  the processes disagree. ⛔ `""` is falsy, so every candidate is emptiness-checked
  **after trimming**.
- ⛔ **Blast radius was measured, not assumed:** the heavy path
  (`buildChatSignedDownloadUrl`, **12,960 fetches/14d**) is minted *and* verified
  by api alone, so an api-only deploy is self-consistent and clients re-fetch on
  their next 7 s chat poll. The two worker-minted schemes have **zero** live usage
  (**0** outbound messages with attachments in 14 days; **0** fetches of
  `/api/chat/a/`; **0** VoIP.ms-range IPs ever fetched an attachment).
  ⏳ **The worker still runs the old module** — redeploying it would also repair
  the pre-existing MMS drift, but nothing depends on it today.
- ⛔ **Tests are proven real, not just green:** the 18 chat-signing tests were run
  against the pre-fix module from git and **10 of them FAIL**, including "a
  forged unkeyed URL is REJECTED". The webhook tests read `connectChatRoutes.ts`'s
  **source** for the call site, because the defect was a caller.
  ⛔ `packages/shared` names test files **explicitly** — `chatSignedUrl.test.ts`
  had to be registered or it would never have run.
- ⏳ **STILL OPEN, deliberately out of scope** (§4, §5 and §6a–§6l of the audit):
  **`TENANT_ADMIN` can read `GET /admin/tenants` and `PATCH` another customer's
  row** (8 live TENANT_ADMIN accounts in 8 real customer tenants), and
  **anonymous tenant + invoice creation** through the permanently-false `NODE_ENV`
  gate in `onboarding/publicRoutes.ts`. Both need permission-model decisions.
  ⏳ **§3b is fixed for chat only** — the prompt, MOH, CRM-doc and CRM-voicemail-drop
  helpers still resolve to `"dev-signing-secret"`.
- ✅ **The signing change is PROVEN INSIDE THE RUNNING CONTAINER, not just by
  unit test** — the deployed module was driven with production env: the heavy
  path mints **and verifies** (`{"ok":true"}`), the key is **not** the repo
  literal, it **is** the `JWT_SECRET`-derived value, chat-db round-trips, and a
  forged unkeyed URL is **rejected**. So chat attachments will load.
- ✅ **Live after deploy:** `/api/internal/telephony/pbx-tenant-map` **403** on
  both hostnames (it survived the blue/green nginx reload — the deny block uses
  the `connect_api_active` upstream, so it follows the flip), the VoIP.ms webhook
  **401** (was 200), and health / portal / `/version` all **200** on both hosts.
- ⏳ **NOT PROVEN: no human has opened a chat attachment or received a text since
  the deploy** — it was 04:27 local and there is no customer traffic to read.
  ⛔ **The acceptance test is the first chat attachment of the morning**: watch
  for 200s on `/chat/attachments/download` in the nginx log and **zero** 401s
  with `bad_signature`. Everything else is proven by 34 tests (10 of which fail
  against the pre-fix module), a clean shared typecheck, an api typecheck at its
  exact 75-error baseline, and the full suites (shared 352/352; api 2,190/2,200
  with all 7 failures the pre-existing `pbxTenantDirectorySync` ones).
