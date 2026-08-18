# PLAN — put Connect behind Cloudflare, and the SIP split-out that has to happen first

Status (2026-08-18): **PHASE A DONE AND VERIFIED. PHASE A2 DONE. PHASE B'S SERVER SIDE IS
DONE — BUT NOT ONE TENANT HAS MOVED. PHASE C STAGING IS COMPLETE (2026-08-18, owner-
approved: SSL-strict config rule scoped to `app.`, WAF skip rule on both hostnames,
LOG-only rate limit on the login path, Cloudflare Managed Ruleset in LOG mode — see the
Phase C update box + §C8), and ⛔ `app.` IS STILL DNS-ONLY — THE PROXY FLIP HAS NOT
HAPPENED.** See the update box at the top of Phase C before touching any Cloudflare
setting; in particular **"Bot Fight Mode" no longer exists on this zone** and the old
step 11 is un-followable as written.
⛔ **Read that middle clause literally.** `SIP_PUBLIC_WS_URL` is set and the api serves
`wss://sip.connectcomunications.com/sip`, but **the apps never refresh a cached
`sipWsUrl`**, so every phone signed in today is still registering against `app.` and
will keep doing so until its user signs out and back in. **Phase B is NOT complete and
`app.` MUST NOT be proxied yet.** Migrating the four tenants is the owner's to schedule.
Also new this day: **`app.loopcom.net` now serves Connect** (§4b) — and the first real
browser pass on it found the **public pay pages were DEAD there** (hardcoded absolute
API URL → CORS block). Fixed and deployed the same day, `93a85d25`; ⛔ **read the
"second hostname makes every hardcoded absolute API URL a bug class" section in §4b
before adding any URL to a portal page.**
✅✅ **2026-08-17: PHASE A2 IS COMPLETE. `sip.loopcom.net` is live (101) and IS the
handed-out hostname — but for NEW ACCOUNTS ONLY.** Izzy's decision: **existing customers
stay exactly as they are; only accounts created from today onward get the Loopcom
hostname.** A single global `SIP_PUBLIC_WS_URL` cannot express that, so it was made to:
**the five tenants that depended on the global were PINNED to the hostname they already
resolved to, and only then was the global flipped.** Zero tenants depend on it now, and a
before/after resolution snapshot of all 29 live tenants shows **0 existing customers
moved**. ⛔ **PIN FIRST, FLIP SECOND — reversing that order is the outage.** Read the
update box at the top of Phase A2 before any SIP work. Every step is reversible and each
carries its own rollback (⛔ the rollback order is the mirror: global first, pin second).

✅ **Plan upgraded to Cloudflare Pro** on `connectcomunications.com` (2026-08-16,
verified: badge reads `pro`, DNS limit 200 → 3,500, Spectrum appeared). ⛔ **Pro is
PER ZONE** — `loopcom.net`/`.org`/`.ai` would each need their own upgrade.
⛔ Spectrum on Pro covers SSH/Minecraft only; **arbitrary TCP (i.e. real SIP) is
Enterprise**, so Pro does NOT remove the need for the SIP split below.

## Phase A — COMPLETE, verified 2026-08-16

- `sip.connectcomunications.com` A → 45.14.194.179, **DNS only**. Verified it resolves
  to the origin and not a Cloudflare address. ⛔ On the Add-record form the proxy
  toggle defaults to **Proxied** and a coordinate click missed it — it was caught by
  re-reading the dialog, which still said "proxied through Cloudflare". **Always
  re-read the summary sentence before saving a DNS record.**
- Let's Encrypt cert issued (expires 2026-11-14, auto-renewing).
- nginx: `/etc/nginx/sites-available/connectcomms-sip`, **HTTPS only** for `/sip`
  (port 80 returns 301). ⛔ certbot merged 80 and 443 into ONE server block, which
  would have served `/sip` over plaintext HTTP — split into two blocks by hand.
  Backups: `/root/nginx-connectcomms-sip-backup-*.conf`.
- **Proven:** `sip.…/sip` returns **`101 Switching Protocols`** +
  `Sec-WebSocket-Protocol: sip`; `app.…/sip` still returns **101** (no regression);
  port 80 returns **301**.
- ⛔ **Nothing has moved for any customer.** Both hostnames serve SIP; all four
  tenants still use `app.` until Phase B changes the code.

---

## Phase A2 — `sip.loopcom.net` — ✅ **COMPLETE. LIVE FOR NEW ACCOUNTS ONLY; EVERY EXISTING CUSTOMER IS PINNED WHERE THEY WERE (2026-08-17)**

> ### ✅ 2026-08-17 FINAL UPDATE — READ THIS BEFORE THE REST OF PHASE A2, WHICH IS NOW HISTORY
>
> **Owner's decision (Izzy, 2026-08-17):** *existing customers should stay exactly as they
> are; only accounts that sign up from today onward should use the Loopcom SIP hostname.*
>
> `SIP_PUBLIC_WS_URL` is **one global value**, so it cannot express that on its own.
> **It was made to express it by pinning the OLD, not by stamping the NEW.**
>
> ```sql
> -- Step 1 (the pin). Behaviour-preserving: this string WAS the live value of
> -- SIP_PUBLIC_WS_URL at the moment it ran, so every one of these tenants kept
> -- resolving to exactly what it already resolved to.
> UPDATE "Tenant" SET "sipWsUrl" = 'wss://sip.connectcomunications.com/sip'
>  WHERE "pbxRemovedAt" IS NULL AND "webrtcRouteViaSbc" AND "sipWsUrl" IS NULL;
> -- 5 rows: B Visible, Displaydex, Gesheft, inii mini, Loopcom Demo
> ```
> ```bash
> # Step 2 (the flip), ONLY after step 1 verified.
> SIP_PUBLIC_WS_URL=wss://sip.loopcom.net/sip     # .env.platform:106
> ```
>
> ⛔⛔ **PIN FIRST, FLIP SECOND. Reversing the order IS the outage** — flip while a live
> tenant still has `sipWsUrl = NULL` and that customer is handed the new address at their
> users' next sign-in, which is exactly what the owner ruled out. The rule now lives in
> `apps/api/src/sipPublicEndpoint.ts`'s doc block, with a test that keeps it there.
>
> ✅ **Because nothing had to be stamped at tenant creation, the "five creation paths"
> trap below never applied.** A new tenant takes the schema defaults
> (`webrtcRouteViaSbc = true` since `8495d379`, `sipWsUrl = null`) and therefore takes the
> global. There is no helper to miss and no sixth creation site to forget. ⛔ **That trap
> comes straight back the moment anyone decides to stamp `sipWsUrl` at creation.**
>
> | | value | as of 2026-08-17 22:30 UTC |
> |---|---|---|
> | `.env.platform:106` | `wss://sip.loopcom.net/sip` | ✅ flipped |
> | running `app-api-1` | `wss://sip.loopcom.net/sip` | ✅ **agrees** (container `45923f4f`) |
> | tenants depending on the global | **0** | ✅ the safety property |
>
> #### ⛔ The verification that actually settles this — a before/after resolution snapshot
>
> Replay `resolveWebrtcConfig`'s logic against **every live tenant**, inside `app-api-1`
> so it reads the container's real env. Run it before the pin, after the pin, and after
> the deploy, and diff by tenant id. **This is the only check that can tell "the global
> moved" apart from "a customer moved."** On 2026-08-17 all three runs matched:
>
> ```
> 29 live tenants | existing tenants that changed resolution: 0
> 23 × wss://m.connectcomunications.com:8089/ws
>  5 × wss://sip.connectcomunications.com/sip   (the five pinned)
>  1 × wss://209.145.60.79:8089/ws              (2nd "Connect Communications", pre-existing)
> ```
>
> The resolution logic to replay (`apps/api/src/server.ts:773`), which has not changed:
>
> ```
> tenant.sipWsUrl (non-empty)   → WINS OUTRIGHT, even when webrtcRouteViaSbc is false
>   else webrtcRouteViaSbc      → sipPublicWsUrl()   (the global env value)
>   else                        → pbxWsEndpoint      (wss://209.145.60.79:8089/ws, direct to PBX)
> then normalizeSipWsUrlHost()  → rewrites IP-LITERAL hosts only
> ```
>
> ⛔ **That last line is why pinning an FQDN is a no-op through the normaliser**, which is
> what makes the pin provably behaviour-preserving rather than merely intended to be.
>
> #### The one-line check before ever touching `SIP_PUBLIC_WS_URL` again
>
> ```sql
> SELECT name FROM "Tenant"
>  WHERE "pbxRemovedAt" IS NULL AND "webrtcRouteViaSbc" AND "sipWsUrl" IS NULL;
> ```
> **Any existing customer in that list would be moved by the change.** It should list only
> accounts you are content to move. Today it returns nothing.
>
> #### ⛔ Rollback — the mirror of the rollout, GLOBAL FIRST, PIN SECOND
>
> 1. restore `/opt/connectcomms/env/.env.platform.bak.20260817T222410Z.sipflip-loopcom`
>    (`diff` = exactly one line, 106) and deploy api **with a real `apps/api/` commit**;
> 2. *only then* set `sipWsUrl` back to `null` on the five ids recorded in
>    `/root/sip-pin-backup-2026-08-17T2223Z.json` on loopcom.
>
> ⛔ **Unpinning while the global still says loopcom hands those five customers the new
> hostname.** Either half alone is safe and inert; only that order is wrong.
>
> #### ⛔⛔ CORRECTION TO §2 OF THIS DOCUMENT, kept because it is what reshaped the work
>
> **"`sipWsUrl` is NULL on all four tenants" was only ever true of those four.** Read live
> 2026-08-17 across **29 live tenants**: **20 had `sipWsUrl` SET, 9 NULL, 5 on
> `webrtcRouteViaSbc=true`.** The global reached **only** the five that were `viaSbc=true`
> **and** `sipWsUrl=null`. Twenty tenants were already pinned per-tenant to a **direct-PBX**
> URL, and four more (`sipWsUrl=null`, `viaSbc=false`) take `PBX_WS_ENDPOINT`.
> **The per-tenant mechanism this plan said did not exist was already the dominant one in
> production — which is precisely why the pin was available as the answer.**
>
> ⛔ **A new account is now materially different from those 24:** it goes through the nginx
> `/sip` 443 proxy, not direct to the PBX on `:8089`. That was the owner's deliberate call
> in `8495d379` (filtered internet is the norm for this customer base), not a side effect
> of the hostname change.
>
> ⛔ **`webrtcRouteViaSbc` is consumed by NO live client** — every reference outside
> `apps/api/src` is in `apps/frontend-legacy/portal-v2-legacy/`, which is dead code. It is
> purely a server-side fallback selector.
>
> ⛔ Pre-existing, **not** fixed: `server.ts:9500` canonicalises the IP before persisting
> `sipWsUrl`; `pbxExtensionSync.ts:620` does **not** — which is why the five newest tenants
> carry a raw-IP `sipWsUrl` and older ones carry the FQDN.
>
> #### ⏳ NOT PROVEN — the honest limit
>
> **No softphone has ever registered against `sip.loopcom.net`.** It answers **101** from
> the server and the api hands it out, but nothing has completed a SIP REGISTER through it,
> because no new tenant has been created since the flip and every existing client keeps its
> cached URL forever. **The acceptance test is the next real sign-up**, judged from the PBX
> contact list (`pjsip show endpoint T<t>_<ext>_1` reading `Avail`), never from a client's
> own "registered". ⏳ **Nobody has re-authenticated on any of the five pinned tenants**
> either, so the pin is proven as resolution, not as a completed registration.
>
> #### ✅ How the env change finally reached the container
>
> An env-only change can never trigger a rebuild (see "the deploy that cannot happen"
> below). **The way through is to ship the env change alongside a REAL `apps/api/` commit**
> — here, `45923f4f`, which corrects `sipPublicEndpoint.ts`'s doc block (it still claimed
> no per-tenant edit could move a 443 tenant) and adds two guard tests. Deploy rebuilt
> (build 127 s), blue/green completed, `verify: container commit 45923f4f2d70 matches
> target`, nginx back on `server 127.0.0.1:3001;`.
> ⛔ **Both pending migrations (`20260817220000_email_job_attachments`,
> `20260817230000_default_sip_route_via_443`) were ALREADY applied** by an earlier deploy
> at 21:52 / 22:07 UTC, so this deploy ran no migration —
> `git diff --name-only <container .build-commit>..HEAD -- packages/db/prisma/` was empty,
> which is the check to run before any deploy you do not want carrying a surprise schema
> change.
>
> **Everything below this box describes the 2026-08-16 state and is kept as history.**

Done 2026-08-16. Owner's decision: the SIP hostname should carry LoopCom branding, so
`sip.loopcom.net` becomes the **handed-out** value in place of
`sip.connectcomunications.com`. **Additive only — every existing hostname stays live
indefinitely, because clients cache their SIP URL forever.**

✅ **DNS, cert and nginx are DONE and PROVEN.** `sip.loopcom.net` returns **101
Switching Protocols** + `Sec-WebSocket-Protocol: sip`, on its own Let's Encrypt cert,
and **all three pre-existing SIP hostnames still return 101** (no regression).

⛔⛔ **BUT THE FLIP HAS NOT TAKEN EFFECT, AND THIS IS THE ONE THING TO READ.**
`.env.platform` says `wss://sip.loopcom.net/sip`; **the running `app-api-1` still says
`wss://sip.connectcomunications.com/sip`.** Clients are still being handed the OLD
hostname. See "the deploy that cannot happen" below — it is a real gap in the deploy
tooling, not an oversight.

### ⛔ THE DEPLOY THAT REPORTS `success` AND CHANGES NOTHING — env-only changes have NO sanctioned path

`deploy-direct.sh api` ran, printed **`[deploy-direct] success`**, and **did not
recreate the container.** The log line that matters is buried mid-output:

```
[deploy-common] skip=unrelated_paths
[deploy-api] commit changed cf8d16ff..ae594eda but no api-relevant paths changed — skipping build/restart
```

⛔ **`deploy_common_needs_rebuild` (`scripts/lib/deploy-common.sh:313`) decides purely on
whether api-relevant PATHS changed between the deployed commit and HEAD. An environment
variable is not a path, so an env-only change can never trigger a rebuild** — and the
script still exits `success`. This is the same family as the `deploy-worker.sh`
self-skip, and it is **more dangerous here because the success line is the last thing
printed.** ⛔ **After any env change, `docker exec app-api-1 sh -c 'echo
$SIP_PUBLIC_WS_URL'` is the ONLY proof. Never trust the deploy's exit line.**

⛔ **`DEPLOY_FORCE_RESTART=1` DOES NOT WORK for api** — it was tried and produced the
identical skip. There is **no `--force` flag on `deploy-direct.sh`** (its only flags are
`--branch`, `--commit`, `--dry-run`, `--skip-queue-check`), and the deploy queue runs the
same `deploy-api.sh`, so it skips identically. ⛔ `docker compose up -d api` by hand is
**forbidden** (AGENTS.md rule 12 — the non-blue/green path destroys the listening
container before nginx has a candidate, which is the historic `/api/*` 502 class).
**So there is genuinely no sanctioned way to recreate the api container for an env-only
change, and this session deliberately stopped rather than improvise one.**

**How it takes effect:** the next api deploy that touches an api-relevant path rebuilds
and picks the value up automatically. ⛔ **That means the SIP hostname handed to clients
will change during someone else's unrelated deploy** — the container's `/app/.build-commit`
still reads `cf8d16ff`, so the comparison window is already open. Whoever deploys api
next is the one who ships this flip. It is the intended change and the route is proven,
but nobody will be watching for it, so **it is called out here on purpose.**

⛔ **Rollback, if the flip should NOT ship:** restore
`/opt/connectcomms/env/.env.platform` from
**`/opt/connectcomms/env/.env.platform.bak.20260816T202641Z`** (a `diff` against it shows
**exactly one changed line**, 106). Nothing else to undo — the DNS record, cert and nginx
block are additive and harmless whether or not the env value points at them.

### The Squarespace blocker — hit twice, then cleared by the owner

The session **reads** fine unattended, but clicking `ADD RECORD` throws:

> **Verify to continue as support@connectcomunications.com** — *Login with Google to
> continue.* [CONTINUE]

⛔ **An agent must not authenticate as the owner.** This session stopped twice and handed
back; **Izzy completed the Google sign-in**, after which the record was added by the
agent with no further prompt. The gate covers the **write**, not the **read**, so
inspection and verification never need him.

⛔ **Two UI traps on that form, both of which silently produce a wrong record:**
1. **`ADD RECORD` needs TWO clicks** — the first silently does nothing (the row list just
   re-orders). Do not conclude the gate fired because nothing opened.
2. **The record TYPE is a custom `DIV`, not a `<select>`** — `form_input` fails on it
   with "Element type DIV is not a supported form input"; it must be clicked open and the
   option clicked. ✅ **The tell that the type actually took is that the last field's
   label changes from `DATA` to `IP ADDRESS`.** Re-read the form before saving; a
   coordinate click that misses a control is this project's most repeated DNS mistake.

**The record, as saved and verified:** `A` / `sip` / `45.14.194.179` / TTL 4 hrs.
Squarespace confirmed *"A custom record was saved"*.

⛔ **Nothing else on that page was touched**, verified before and after: the **four apex
`A` records** (198.185.159.144/145, 198.49.23.144/145 — the live Squarespace marketing
site), the **`www` CNAME** (`ext-sq.squarespace.com`), the **`HTTPS` service record**,
the **five Google MX records**, the Google verification TXT, and the pre-existing custom
records **`A app`** and **`TXT _dmarc`**. Re-checked after the change: apex still returns
all four A records, **MX count still 5**, `https://loopcom.net/` still **200**.
Squarespace is not Cloudflare — there is **no proxy toggle** on this form, so the
grey-cloud trap from Phase A does not apply; the record is DNS-only by nature, confirmed
by it resolving to the origin `45.14.194.179` and not a Cloudflare anycast address.

### What was changed, and the backups

| # | change | rollback |
|---|---|---|
| 1 | Squarespace custom record `A sip → 45.14.194.179` | delete the record |
| 2 | Cert `sip.loopcom.net` (LE, expires **2026-11-14**, auto-renewing, `--deploy-hook 'systemctl reload nginx'`) | `certbot delete --cert-name sip.loopcom.net` |
| 3 | **NEW** `/etc/nginx/sites-available/connectcomms-sip-loopcom` + symlink | `rm` the symlink, `nginx -t && systemctl reload nginx` |
| 4 | `.env.platform:106` → `wss://sip.loopcom.net/sip` (**staged, not live**) | restore the `.bak` below |

**Backups:** `/root/nginx-full-backup-20260816-222322.tar.gz` (whole `/etc/nginx`),
`/root/nginx-connectcomms-backup-20260816-222322.conf`,
`/root/nginx-connectcomms-sip-backup-20260816-222322.conf`,
`/root/connectcomms-sha256-20260816-222322.txt`, and
`/opt/connectcomms/env/.env.platform.bak.20260816T202641Z`.

⛔ **`certonly` did its job — proven, not assumed.** `sites-available/connectcomms` is
**byte-identical** after the whole operation (sha256 `a33f0c7f…` before and after, which
is why that hash was captured up front), and the stage-1 file was **not** rewritten into
a merged 80+443 block the way certbot did to the `sip.` file in Phase A.

### Verified after the change — all from the SERVER

| check | result |
|---|---|
| `sip.loopcom.net/sip` | **101** + `Sec-WebSocket-Protocol: sip` |
| `sip.connectcomunications.com/sip` | **101** (no regression) |
| `app.connectcomunications.com/sip` | **101** (no regression) |
| `app.loopcom.net/sip` | **101** (no regression) |
| `http://sip.loopcom.net/sip` | **301** → `https://sip.loopcom.net/sip` |
| `https://sip.loopcom.net/` (non-`/sip`) | **404** (as designed) |
| cert on new host | `CN = sip.loopcom.net`, `notAfter Nov 14 2026` |
| **default TLS server (unmatched SNI)** | **still `CN = app.connectcomunications.com`** |
| `/api/health` (both hosts) | **200** |
| portal `/` | **200** |
| bad-credential login | **401** |
| `app-api-1` | healthy |
| ⛔ `docker exec app-api-1 … $SIP_PUBLIC_WS_URL` | ⛔ **still the OLD value** |

⛔⛔ **THE TRAP THAT ALMOST GOT FILED AS A REGRESSION: from Izzy's own workstation,
`app.connectcomunications.com/sip` and `app.loopcom.net/sip` return `403 Forbidden`,
while `sip.connectcomunications.com/sip` returns `101` from that same machine.** That
**403 is his content filter**, not nginx — the identical probe from the server returns
**101 on all three**. This is the [[webrtc-filtered-internet-port-8089]] family in a new
costume: the filter categorises the `app.` hostnames differently from `sip.`. **Never
conclude a SIP-hostname regression from a workstation curl on a filtered line — re-run
it from the box before believing it.** (Existing certs at the time: three, one each for
`app.connectcomunications.com`, `app.loopcom.net`, `sip.connectcomunications.com`.)

⛔ **`app.` and `sip.` are NOT the same SIP path, and this is worth knowing before the
cutover.** `sites-available/connectcomms` proxies `/sip` to **`https://127.0.0.1:7443`**
— the **`sbc-kamailio` container** (up 4 weeks), the unfinished experiment
[[connect2-ops-alerts]] records as never having carried a call. `connectcomms-sip` and
`connectcomms-loopcom` both proxy `/sip` **straight to
`https://m.connectcomunications.com:8089/ws`**. All three return 101, so the upgrade
proves the *route*, not the *call*. The new block must mirror the **direct-to-PBX** form.

### How it was built — the procedural facts worth reusing

⛔ **Prove DNS resolves before certbot.** Running it against an unpropagated name burns a
Let's Encrypt failure and reads like a broken vhost. Verified from the authoritative
nameservers **and** 8.8.8.8/1.1.1.1 before proceeding.

⛔ **The filename picks nginx's default server.** `sites-enabled/*` is included in
**sorted** order and the first `listen 443` block becomes the default for unmatched
hostnames. Order is now `connectcomms`, `connectcomms-loopcom`, `connectcomms-platform`,
`connectcomms-sip`, `connectcomms-sip-loopcom` — the new file sorts **last**, so the
default stayed `app.connectcomunications.com` (re-verified by unmatched-SNI probe
**after** the change). A name like `app-sip` would have silently stolen it.

The vhost is `connectcomms-sip` **verbatim** with hostname and cert paths swapped,
including `proxy_read_timeout 3600` / `proxy_send_timeout 3600` and
`proxy_pass https://m.connectcomunications.com:8089/ws` — **direct to the PBX, not
kamailio**. `/sip` is HTTPS-only; port 80 is a 301. ⛔ No `security-headers.conf` here —
this block serves no HTML. ⛔ Always `systemctl reload`, never `restart`.

**The exact sequence that was run** (repeat it for any future SIP hostname):

```bash
# 1) CERT. ⛔ `certbot --nginx` (installer form) CANNOT be first — it needs a vhost
#    already carrying the server_name, and when it owns the file it MERGES 80 and 443
#    into ONE block, which would serve /sip over plaintext HTTP (this exact thing
#    happened on the sip.connectcomunications.com file in Phase A). Throwaway :80
#    block first, then `certonly`, so certbot never rewrites the hand-written vhost.
cp -a /etc/nginx/sites-available/connectcomms-sip \
      /root/nginx-connectcomms-sip-backup-$(date +%Y%m%d-%H%M%S).conf
tar czf /root/nginx-full-backup-$(date +%Y%m%d-%H%M%S).tar.gz /etc/nginx

cat > /etc/nginx/sites-available/connectcomms-sip-loopcom <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name sip.loopcom.net;
    root /var/www/html;
    location /.well-known/acme-challenge/ { allow all; }
}
EOF
ln -s /etc/nginx/sites-available/connectcomms-sip-loopcom /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

certbot certonly --nginx -d sip.loopcom.net --cert-name sip.loopcom.net \
        --non-interactive --deploy-hook 'systemctl reload nginx'

# 2) REAL VHOST — overwrite the throwaway with the full two-block form.
#    ⛔ FILENAME IS LOAD-BEARING: sites-enabled/* loads in SORTED order and the first
#    `listen 443` block becomes nginx's default server for unmatched hostnames. Current
#    order is connectcomms, connectcomms-loopcom, connectcomms-platform,
#    connectcomms-sip — `connectcomms-sip-loopcom` sorts LAST, so the default stays the
#    app.connectcomunications.com block. A name like `app-sip` would silently steal it.
```

The vhost body is `connectcomms-sip` **verbatim** with the hostname and cert paths
swapped: port 80 → `return 301 https://$host$request_uri;`, port 443 with
`proxy_pass https://m.connectcomunications.com:8089/ws; proxy_ssl_server_name on;`,
`proxy_http_version 1.1`, the `Upgrade`/`Connection "upgrade"`/`Host`/`X-Forwarded-*`
headers, **`proxy_read_timeout 3600; proxy_send_timeout 3600;`**, and
`location / { return 404; }`. ⛔ Keep `/sip` **HTTPS-only** — it carries SIP credentials.
⛔ Do **not** add `security-headers.conf` here; this block serves no HTML.

```bash
nginx -t && systemctl reload nginx     # ⛔ reload, NEVER restart

# 3) VERIFY BEFORE FLIPPING ANY CLIENT VALUE — from the SERVER, not a filtered line.
for H in sip.loopcom.net sip.connectcomunications.com app.connectcomunications.com app.loopcom.net; do
  curl -s --http1.1 -o /dev/null -D - -H "Connection: Upgrade" -H "Upgrade: websocket" \
       -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
       -H "Sec-WebSocket-Protocol: sip" "https://$H/sip" | grep -iE "^HTTP/|websocket-protocol"
done
curl -sI http://sip.loopcom.net/sip | head -1          # expect 301
echo | openssl s_client -connect 127.0.0.1:443 -servername nomatch.example.com 2>/dev/null \
  | openssl x509 -noout -subject                        # MUST still be app.connectcomunications.com
```
⛔ Expect **101 + `Sec-WebSocket-Protocol: sip` on ALL FOUR**. A plain `curl` returns
**426 Upgrade Required** (nginx has HTTP/2 on) — that is the wrong test, not a fault.

```bash
# 4) FLIP THE HANDED-OUT URL. One variable, nothing else.
cp -a /opt/connectcomms/env/.env.platform \
      /opt/connectcomms/env/.env.platform.bak.$(date -u +%Y%m%dT%H%M%SZ)
sed -i 's|^SIP_PUBLIC_WS_URL=.*|SIP_PUBLIC_WS_URL=wss://sip.loopcom.net/sip|' \
      /opt/connectcomms/env/.env.platform
diff /opt/connectcomms/env/.env.platform.bak.* /opt/connectcomms/env/.env.platform  # ⛔ ONE line

curl -s http://127.0.0.1:3910/ops/deploy/status        # ⛔ require runningCount: 0
cd /opt/connectcomms/app && bash scripts/deploy-direct.sh api --branch feat/ivr-migration-takeover
docker exec app-api-1 sh -c 'echo [$SIP_PUBLIC_WS_URL]'   # ⛔ THIS is the proof, not the exit line
```
⛔ **Never `docker compose up` by hand** — api is blue/green (AGENTS.md rule 12).
⛔ **Step 4's deploy SKIPPED and still said `success`** — see the section above. The env
value is staged on disk and **not** in the container.

### ⛔ THE ONE STEP LEFT — and it needs the owner

**The api container must be recreated for the flip to reach clients**, and there is **no
sanctioned script that will do it for an env-only change.** Options, owner's call:

1. **Do nothing** — the next api deploy touching api code picks it up automatically.
   Simplest, but it ships unobserved during someone else's work.
2. **Piggyback deliberately** — let the next real api deploy carry it, with someone
   watching the `docker exec` check afterwards.
3. **Force a recreate now** — needs Izzy's explicit go-ahead, because it means stepping
   outside `deploy-direct.sh`.
4. **Back it out** — restore `.env.platform.bak.20260816T202641Z`. Costs nothing; the new
   hostname keeps working, just unused.

⛔ **Whichever is chosen, the acceptance test is the same and it is NOT the deploy's exit
line:** `docker exec app-api-1 sh -c 'echo $SIP_PUBLIC_WS_URL'` must read
`wss://sip.loopcom.net/sip`.

### What this does and does not change

- ✅ New sign-ins are handed `wss://sip.loopcom.net/sip`.
- ⛔ **NOBODY MOVES UNTIL THEY SIGN OUT AND BACK IN.** The apps never refresh a cached
  `sipWsUrl` — that is precisely why the flip is safe and why it is also inert. Live
  sessions keep registering against `sip.connectcomunications.com` indefinitely.
- ⛔ **Therefore `sip.connectcomunications.com` can NEVER be retired on a schedule.**
  Retiring it while a single client still holds it cached is the one and only way this
  work causes an outage. It stays live indefinitely, at zero cost.
- ⛔ **Still one global value.** `apps/api/src/sipPublicEndpoint.ts` is deliberately
  untouched: a portal user on `app.connectcomunications.com` would now be handed a
  **loopcom.net** SIP host. It works, but per-domain SIP remains an **OPEN DESIGN
  DECISION the owner has not made** — do not "fix" it unasked.

---

## 1. Why this document exists

Cloudflare is the DNS provider for `connectcomunications.com`, but `app.` resolves
straight to the origin. **Cloudflare served 1 request in 24 hours.** Until `app.` is
proxied, every WAF rule, rate limit and bot protection is inert — they only apply to
traffic that passes through the edge.

⛔ **But `app.` cannot simply be flipped to proxied, because the phone system rides
that hostname.** nginx serves `location /sip` on `app.`, proxying SIP-over-WebSocket
through to the PBX. Flipping the orange cloud puts every SIP registration for four
tenants through Cloudflare, which idles WebSockets out at ~100 seconds. A dropped
WebSocket is a phone that does not ring.

So the order is: **get SIP off `app.` first, prove it, then proxy `app.`**

---

## 2. Current state — proven, not assumed (2026-08-16)

**The four tenants on the 443 SIP route.** Read live from the database
(`webrtcRouteViaSbc = true`, 29 live tenants total):

| Tenant | viaSbc | sipWsUrl | sipDomain |
|---|---|---|---|
| Gesheft | true | `null` | m.connectcomunications.com |
| Displaydex | true | `null` | m.connectcomunications.com |
| Loopcom Demo | true | `null` | m.connectcomunications.com |
| inii mini | true | `null` | m.connectcomunications.com |

⛔ **`sipWsUrl` is NULL on all four — the URL is HARDCODED IN CODE, not stored per
tenant.** This is the single most important fact in this plan, and it changes the shape
of the work: there is no per-tenant DB edit to make. `apps/api/src/server.ts` carries
the literal `wss://app.connectcomunications.com/sip` in **two** places:

- **`server.ts:767`** — `fallbackSipWsUrl`, the value actually handed to clients
- **`server.ts:4634`** — `route.publicSipWsUrl`, reported by the readiness/diagnostics path

⛔ Both must change together. Changing one leaves diagnostics disagreeing with reality,
which is exactly how a future session wastes a day.

**Other facts that constrain the design:**

- Cloudflare plan is **Free**. No Spectrum (which is the paid product that would carry
  SIP properly), Bot Fight Mode rather than Super Bot Fight Mode, 1 rate-limiting rule.
- Proxying is **per hostname, not per path** — there is no way to proxy `/api` while
  leaving `/sip` direct on the same hostname.
- `m.connectcomunications.com` (the PBX) is DNS-only and ⛔ **must stay that way.**
- nginx `client_max_body_size` is 10m; Cloudflare Free caps uploads at 100 MB, so
  onboarding uploads are unaffected.
- The Android APK served from `/api/mobile/android/download` is ~147 MB. Downloads are
  not capped on Free, but it will be proxied traffic — worth watching.

---

## 3. The blockers that would bite on the day of the cutover

⛔ **Bot Fight Mode would break the mobile apps and the webhooks.** It challenges
non-browser traffic. The Connect mobile apps (`okhttp` / `Loopcom/NN` user agents) and
inbound webhooks from VoIP.ms, Twilio and Cardknox are all non-browser. **Bot Fight Mode
must stay OFF, or every webhook path must be skipped, before `app.` is proxied.**
This alone could take out SMS delivery and payment callbacks.

⛔ **Webhook paths need explicit WAF skip rules** regardless of bot mode:
`/api/webhooks/*`, `/api/internal/*`, and the Cardknox callback. A managed rule
false-positiving on a signed webhook body is a silent, hard-to-trace outage.

⛔ **`/ws/telephony` and `/ws/` are also WebSockets on `app.`** — the live call feed and
the realtime service. These have the same ~100 s idle exposure as SIP, though they are
far chattier so are less likely to idle out. They must be watched during the soak, not
assumed fine.

⛔ **The origin IP stays public and is already known.** Proxying `app.` hides it from
new discovery but does not retract it — `m.` still resolves to the PBX and the app's
history is in DNS aggregators. **An origin firewall restricting 80/443 to Cloudflare's
published ranges is what actually closes the bypass**, and that is a separate, riskier
change (get it wrong and the site is unreachable). Do not claim origin protection from
the orange cloud alone.

---

## 4. The plan

### Phase A — stand up a dedicated SIP hostname (no customer impact)

1. **DNS:** add `sip.connectcomunications.com` A → `45.14.194.179`, **DNS only (grey
   cloud)**. Rollback: delete the record.
2. **Certificate:** issue a cert for the new hostname
   (`certbot --nginx -d sip.connectcomunications.com`). Rollback: `certbot delete`.
3. **nginx:** new server block for `sip.` containing **only** the `/sip` location,
   copied verbatim from the current block — same `proxy_read_timeout 3600`, same
   upgrade headers. Back up the config first. Rollback: restore backup + reload.
4. **Verify before touching any client:**
   ```
   curl --http1.1 -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
        -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
        -H "Sec-WebSocket-Protocol: sip" https://sip.connectcomunications.com/sip
   ```
   ⛔ Expect **`101 Switching Protocols`** + `Sec-WebSocket-Protocol: sip`. A default
   `curl` returns **426 Upgrade Required** because nginx has HTTP/2 on — that is not a
   broken route, it is the wrong test. Use `--http1.1`.

At the end of Phase A both hostnames serve SIP. Nothing has moved. This is a safe
resting point and can sit here indefinitely.

### Phase B — CODE HALF IS DONE (2026-08-16). The flip itself is NOT done.

✅ **Landed and deployed as a no-op** (`95ab783d`, api container-verified: the new
module is present and `grep -c "app.connectcomunications.com/sip"` in the running
container is **0**). `SIP_PUBLIC_WS_URL` is **unset**, so clients still receive the
`app.` URL and nothing has changed for anyone. Proven after cutover: `/api/health`
200, login still 401 on bad credentials, and **both** `app./sip` and `sip./sip` still
answer **101**.

⛔ **The URL was hardcoded in THREE places, not the two this plan originally claimed.**
The third is the **SBC readiness probe** (`fetch("https://app.…/sip")`), which does not
look like a URL definition. Had only the client-facing one moved, the probe would have
kept asserting a hostname nobody registers against — so a broken new route would have
reported healthy. All three now come from `apps/api/src/sipPublicEndpoint.ts`, guarded
by two tests that read `server.ts`'s **source** and fail if any literal returns (a unit
test of the helper alone passes straight through that bug, because the defect is in a
caller).

✅ **THE ENV FLIP IS APPLIED (2026-08-16, owner-approved) — AND IT HAS MOVED NOBODY.**
`SIP_PUBLIC_WS_URL=wss://sip.connectcomunications.com/sip` appended to
`/opt/connectcomms/env/.env.platform` (backup
`/opt/connectcomms/env/.env.platform.bak.20260816T180855Z`; a `diff` against that backup
shows **exactly the 4 added lines and nothing else**). The api was recreated through the
deploy queue's normal blue/green path — job `success`, commit `f0e1a7a0`,
`app-api-1` healthy, upstream include back to `server 127.0.0.1:3001;`.

**Proven, not asserted:**
- `docker exec app-api-1 sh -c 'echo [$SIP_PUBLIC_WS_URL]'` →
  `[wss://sip.connectcomunications.com/sip]`.
- Evaluated **inside the running container** against the real module's own
  `LEGACY_SIP_WS_URL` constant: `publicSipWsUrl` and the readiness `probeUrl` both
  resolve to the **new** host. `grep -c "app.connectcomunications.com/sip"` on the
  container's `server.ts` is **0**.
- `/api/health` **200**, bad-credential `POST /api/auth/login` **401**,
  `/api/voice/sbc/status` **401** unauthenticated (route alive).
- All three hostnames still upgrade: `sip.` **101**, `app.` **101**,
  `app.loopcom.net` **101**.

⛔⛔ **NOT PROVEN AND DELIBERATELY NOT ATTEMPTED: no tenant has migrated.** Gesheft,
Displaydex, Loopcom Demo and inii mini are all still registered via `app.` because a live
session keeps its cached `sipWsUrl` forever. Nothing was done to force re-registration —
no tenant row touched, no telephony restart, nobody contacted. **Step 8 below is still
open and is the owner's scheduling call**, and step 9's `pjsip show endpoint` check has
not been run because there is nothing yet to check.

**Rollback:** delete the `SIP_PUBLIC_WS_URL` line (and its two comment lines) from
`.env.platform`, redeploy api. Under a minute, no code change.

### Phase B (remainder) — move the clients (the customer-visible step)

5. **Code:** replace the two hardcoded literals with an env-driven value
   (`SIP_PUBLIC_WS_URL`, defaulting to the current `app.` URL so the deploy itself is a
   no-op). Add a test asserting both sites read the same source — they have already
   drifted once in this codebase's history.
6. **Deploy the api**, with the env still pointing at `app.` Prove the no-op.
7. **Flip the env to `wss://sip.connectcomunications.com/sip` and restart.**
   Rollback: unset the env, restart. Under a minute.
8. ⛔ **Every affected user must sign out and back in.** The app **never refreshes a
   cached `sipWsUrl`** — this is documented behaviour and it cuts both ways: it is why
   the flip is inert on a live session and breaks nothing immediately, and it is why
   nobody moves until they re-authenticate. Four tenants, Gesheft being the largest.
   This needs Izzy's scheduling, not an agent's.
9. **Verify per tenant** from the PBX contact list, not the client's own opinion:
   `pjsip show endpoint T<t>_<ext>_1` must read `Avail`. ⛔ A client reporting
   "registered" is an opinion; the PBX contact list is the fact.

### Phase C — proxy `app.` (only after B is soaked)

> ## ✅ 2026-08-18 — PHASE C STAGING **COMPLETED** (C8 below). ⛔⛔ **`app.` IS STILL DNS-ONLY. THE PROXY FLIP HAS NOT HAPPENED AND IS NOT AN AGENT'S TO MAKE.**
>
> **Owner-approved second pass, 2026-08-18 (Izzy).** Four Cloudflare changes, all
> **Log / Skip / scoped-config only — nothing that blocks or challenges anything**, and
> every one of them is **inert today** because `app.` is not proxied. Read back from the
> API after each write and cross-checked in the dashboard UI. **No DNS record touched, no
> proxy toggle moved, no HSTS, no Browser Integrity Check / Security Level change, no
> server / nginx / env / PBX change.** Full detail, verbatim expressions and rollback in
> **§C8** at the end of Phase C.
>
> | # | what | id | state |
> |---|---|---|---|
> | 1 | **Configuration Rule** — SSL **Full (strict)** scoped to `http.host eq "app.connectcomunications.com"` ONLY | ruleset `f80c6f00fffc4da68c132f25342380ff` / rule `47b087a4a5e04d5a9d3f5cd703bf1322` | Active; **zone-wide SSL still `full`** (read back) so `portal.` cannot regress |
> | 2 | **WAF skip rule extended** to `app.loopcom.net` too — same rule id, action + products + logging byte-identical | ruleset `11891f351fa34a2d83c22d5d71d7a13f` now **v2** / rule `47d54f121d6945419a6483d20f2b887a` | Active |
> | 3 | **Rate limit, action `log`** on `/api/auth/login`, both hosts, 20 req / 10 s per `ip.src`+`cf.colo.id` | ruleset `e14af09b3fb44292a107cc9c02a3f05f` / rule `ab375c0db58b4f5da4938e098e298efb` | Active, **LOG ONLY** |
> | 4 | **Cloudflare Managed Ruleset deployed with `overrides.action = "log"`** (ruleset status Default) | ruleset `ab86f7288cfc4f35bd8f8f70153fdee3` / rule `0f255a07814948f08eb7559ed203056d` executing `efb7b8c949ac4650a09736fc376e9aee` | Active, **LOG ONLY** — UI reads *Ruleset action: Log* |
>
> DNS after: **11 records, `portal.` still the only Proxied one**, `app.` / apex / `m.` /
> `sip.` / `www` DNS only — identical to before. Settings after: `ssl=full`,
> `security_level=medium`, `browser_check=on`, HSTS off, `min_tls_version=1.2`,
> `always_use_https=on`, `sbfm_definitely_automated=allow`, `sbfm_verified_bots=allow`.
> Server-side (from loopcom): `/api/health` **200** on both app hostnames, all four SIP
> hostnames **101**, `portal.` **200**, bad-credential login **401** on both hosts.
>
> ### (the 2026-08-17 first pass, kept as history — everything below it is still true except that C3 and C4's "not changed" verdicts are now superseded by C8)
>
> **Exactly ONE thing was changed in Cloudflare: one WAF custom rule was created.**
> **No DNS record was touched. No proxy toggle was moved. No zone setting was changed.**
> Every item below is **inert today**, because nothing on this zone is proxied except
> `portal.` — and the rule created is scoped so it cannot even match `portal.`
>
> Zone: `connectcomunications.com` = **`18df003591a21edaf96e8f5e2a20fb58`**, plan
> **Pro Website**, DNS setup **Full**, Universal SSL **active** (Google CA, covers
> `connectcomunications.com` + `*.connectcomunications.com` — so `app.` gets an edge
> cert automatically the moment it is proxied; nothing to order).
>
> #### Proxy status — the check that matters, read back AFTER the change
>
> | record | | proxy |
> |---|---|---|
> | `A app.connectcomunications.com` | 45.14.194.179 | **DNS only** ✅ |
> | `A connectcomunications.com` (apex) | 31.220.77.60 | **DNS only** ✅ |
> | `A m.connectcomunications.com` (PBX) | 209.145.60.79 | **DNS only** ✅ |
> | `A sip.connectcomunications.com` | 45.14.194.179 | **DNS only** ✅ |
> | `CNAME www` | apex | **DNS only** ✅ |
> | `CNAME portal` | ui.zswitch.net | **Proxied** (unchanged, the only one) |
> | MX + 4 × TXT | | DNS only ✅ |
>
> 11 records before, 11 records after, identical proxy flags.
> (`app.loopcom.net` / `sip.loopcom.net` are on **Squarespace** DNS, not this zone —
> Cloudflare cannot proxy them and none of this reaches them.)

#### C1. ⛔⛔ CORRECTION — **"Bot Fight Mode" DOES NOT EXIST ON THIS ZONE.** The old step 11 was un-followable

The instruction "confirm Bot Fight Mode is OFF" is **stale and must not be repeated**.
The zone is on **Pro**, which replaces Bot Fight Mode with **Super Bot Fight Mode**, and
Cloudflare has since reorganised the whole area under **Security → Settings → filter
"Bot traffic"**. A previous session looked for a Bot Fight Mode row, correctly found
none, and had nothing to check against. **This is what actually exists, read from
`GET /zones/<id>/bot_management` — not from the screen:**

```json
{ "enable_js": true,
  "sbfm_definitely_automated": "allow",      // ✅ the one that would kill okhttp/webhooks
  "sbfm_verified_bots": "allow",             // ✅
  "sbfm_static_resource_protection": false,  // ✅
  "ai_bots_protection": "block",             // ⚠️ see C1b
  "content_bots_protection": "disabled", "crawler_protection": "disabled",
  "ai_training": "disabled", "ai_search": "disabled", "ai_user": "disabled",
  "is_robots_txt_managed": true }
```

✅ **So the bot layer was ALREADY in the safe state and NOTHING NEEDED TURNING OFF.**
Super Bot Fight Mode's three traffic classes are all **Allow**; there is no "likely
automated" class on Pro (that is Business+). **AI Labyrinth is OFF.** The new
"Configure AI bot policies" card (Search / Agent / Training) is **Allow (do not block)**
on all three.

⛔ **The replacement instruction for cutover day is: confirm
`sbfm_definitely_automated` and `sbfm_verified_bots` both read `allow`** — one API read,
not a hunt for a toggle that no longer exists. Anything other than `allow` there
challenges or blocks the mobile apps (`okhttp`, `Loopcom/NN`) and every inbound webhook.

⚠️ **`enable_js: true` (JS Detections) is ON and was LEFT ON.** It does not block
anything — it only injects a `/cdn-cgi/challenge-platform/` script into **HTML**
responses to compute a bot score. It cannot touch a JSON API or a webhook POST.
⛔ **But it is a CSP question, not a bot question:** the portal ships a real
Content-Security-Policy from `/etc/nginx/connectcomms/security-headers.conf`, and a
Cloudflare-injected inline script is exactly the thing a CSP blocks. **The same applies
to `email_obfuscation: on`, which also injects script into HTML.** Neither was changed —
both are on the soak list, and the symptom to watch for is CSP violations in the browser
console on `/login`, **not** a failed API call.

#### C1b. ⚠️ LEFT ALONE DELIBERATELY, and each needs the owner's eye on cutover day

Three settings *could* challenge non-browser traffic but are **ambiguous about whether
they actually would**, so the rule "if you cannot tell what it does to API/webhook
traffic, leave it and report rather than guess" was applied. **All three are neutralised
on the machine-to-machine paths by the skip rule in C2** — the residual exposure is the
*ordinary* mobile/desktop API surface.

| setting | value | why it was left |
|---|---|---|
| **Browser Integrity Check** (`browser_check`) | **on** | Documented to deny requests with "non standard user agents". `okhttp` is a normal UA and passes in practice — but that cannot be *proven* until `app.` is proxied. **This is the single highest-risk remaining item.** If mobile clients start getting **403** during the soak, this is the first toggle to flip, and it is one click. |
| **Security Level** (`security_level`) | **medium** | IP-reputation challenge. ⛔ The specific worry here is **T-Mobile CGNAT** — Create A Box's ext 102 roams 14 source IPs a day on carrier NAT, and a shared CGNAT address can carry someone else's threat score. "Essentially Off" would remove it; that is a posture decision, not an agent's. |
| **Block AI bots** (`ai_bots_protection`) | **block** | Deploys a Cloudflare-managed rule against AI **crawlers**. VoIP.ms / Twilio / Cardknox are not crawlers, so it should never match a webhook — but Cloudflare's own banner says **mixed-purpose crawlers get folded in on 2026-09-15**, and the zone is opted **in** to that (`ai_bots_migration_opt_out: false`). It runs in the managed phase, so the C2 skip rule covers the machine paths regardless. |

#### C2. ✅ WAF SKIP RULE — CREATED, ACTIVE, AND READ BACK FROM THE API

**This is the only change made to Cloudflare in this pass.** One custom rule, in the
`http_request_firewall_custom` entrypoint ruleset
`11891f351fa34a2d83c22d5d71d7a13f`, rule id **`47d54f121d6945419a6483d20f2b887a`**:

**Name:** `Skip security for machine-to-machine paths (webhooks + internal)`
**Order:** 1 of 20 · **Status:** Active · **Logging:** on

**Expression — verbatim, as stored:**

```
http.host eq "app.connectcomunications.com" and (starts_with(http.request.uri.path, "/api/webhooks/") or starts_with(http.request.uri.path, "/api/internal/"))
```

**Action `skip`, with everything the Pro plan can skip:**

```json
{ "phases":   ["http_ratelimit", "http_request_firewall_managed", "http_request_sbfm"],
  "products": ["zoneLockdown", "uaBlock", "bic", "hot", "securityLevel", "rateLimit", "waf"],
  "ruleset":  "current" }
```

i.e. all remaining custom rules · all rate limiting rules · all managed rules · all Super
Bot Fight Mode rules · Zone Lockdown · User Agent Blocking · **Browser Integrity Check** ·
Hotlink Protection · **Security Level** · both legacy (previous-version) engines.

⛔ **The Cardknox callback needs NO separate rule, and this was checked rather than
assumed.** `billingSolaCardknoxWebhookUrl()` is
`publicBillingApiBaseUrl() + "/webhooks/sola-cardknox"`, and
`PUBLIC_API_BASE_URL` / `PUBLIC_API_URL` / `PUBLIC_PORTAL_URL` are **all empty inside
`app-api-1`** (verified by `docker exec`), so it falls through to
`https://app.connectcomunications.com/api` — the callback is
**`/api/webhooks/sola-cardknox`**, already inside `/api/webhooks/`. The same is true of
every other machine caller: `/api/webhooks/voipms/sms`, `/api/webhooks/twilio/sms-status`,
`/api/webhooks/pbx`, `/api/webhooks/whatsapp/meta`, `/api/webhooks/whatsapp/twilio/status`.
⛔ **If anyone ever sets `PUBLIC_API_BASE_URL` to a different host, this rule stops
covering the Cardknox callback** — the host clause is `app.connectcomunications.com`.

⛔ **The host clause is deliberate and is also the rule's main limitation.** It makes the
rule provably inert while `app.` is DNS-only, and it stops the rule ever touching
`portal.` (the Telocall GUI, the only proxied hostname). **But a new proxied hostname —
including `app.loopcom.net` if loopcom.net is ever moved onto Cloudflare — gets NO
protection from it.** Add the hostname to this expression at the same time as you proxy it.

⛔ **"All remaining custom rules" is checked on purpose.** It means a future custom
block rule cannot accidentally take out a webhook — and equally, it means a future
deliberate block on those paths will not work. That trade was chosen the way Cloudflare's
own API-endpoint guidance chooses it: a silent webhook outage is worse.

⏳ **NOT PROVEN, and it cannot be:** the rule has matched **0 requests**, because
`app.` is not proxied so no traffic reaches the edge. It is proven as *stored
configuration read back from the API*, never as *a request that was skipped*.

#### C3. Managed ruleset — deliberately NOT deployed

`Security → Settings → Cloudflare managed ruleset` is **OFF**, and the
`http_request_firewall_managed` entrypoint **does not exist on this zone at all** —
there is no deployed managed ruleset, no OWASP ruleset, no exposed-credentials ruleset.
Likewise **0 custom rules before this pass, 0 rate-limiting rules, 0 page rules, 0 IP
access rules, 0 UA-blocking rules, 0 zone lockdowns, 0 configuration/transform/redirect
rules.** A genuinely clean slate.

⛔ **It was left off.** When it is eventually turned on it must go on in **log /
simulate only** first (Phase C step 14), never straight to block. The C2 skip rule
already exempts the machine paths from it in advance.

#### C4. SSL/TLS — INVESTIGATED, RECOMMENDATION MADE, **NOT CHANGED**

Zone mode is **`full`**, not Full (strict). It was **left at `full`.**

**What was measured** (from the server, so no workstation filter in the way):
`ui.zswitch.net` — the origin behind the only proxied record — presents a
**valid, publicly-trusted certificate**: `CN=*.zswitch.net`,
SAN `*.zswitch.net, zswitch.net`, issued by *Go Daddy Secure Certificate Authority - G2*,
`notBefore Sep 27 2025` / `notAfter Oct 29 2026`, and OpenSSL returns
**`Verify return code: 0 (ok)`**. It resolves to `161.38.209.152` / `161.38.213.152`.

⛔ **That is NOT the same as proving Full (strict) is safe for `portal.`, and the
difference is the whole reason nothing was changed.** The cert is valid for the CNAME
**target** (`ui.zswitch.net`); it does **not** cover `portal.connectcomunications.com`.
Cloudflare is documented to validate a CNAME origin against the record's target hostname,
which would pass — but "documented to" is not "verified on this zone", and the cost of
being wrong is a live third-party GUI going 526 for a customer.

**Recommendation, for the owner:**

1. **Preferred — do not touch the zone-wide mode at all.** Add a **Configuration Rule**
   scoped to `http.host eq "app.connectcomunications.com"` setting SSL to **Full
   (strict)**, and leave the zone on Full. `app.` holds a real Let's Encrypt cert, so
   strict is correct there; `portal.` keeps today's behaviour and cannot regress.
   Configuration Rules are available on Pro. **This was deliberately not created —
   it is still an SSL change and belongs to the owner.**
2. If the zone-wide flip is preferred anyway, flip it and **immediately load
   `https://portal.connectcomunications.com/` and confirm it is not 526**; roll back by
   setting the mode back to Full (seconds, one control).
3. Either way, do it **before** the orange cloud on `app.`, not after.

#### C5. HSTS — NOT ENABLED, and must stay that way for now

Confirmed off via the API: `security_header.strict_transport_security.enabled = false`,
`max_age 0`. ⛔ **Leave it.** Browsers cache the policy, so enabling it while something
is still broken can make the broken state unreachable. It is the *last* step, after the
soak, not part of the staging.

#### C6. The remaining steps — unchanged, and all still the owner's

10. **SSL/TLS → Full (strict)** per C4 (preferably scoped to `app.` via a Configuration
    Rule). Do this *before* the orange cloud.
11. ✅ **Done/superseded** — bot posture confirmed safe (C1), skip rule staged (C2).
    Re-confirm `sbfm_definitely_automated`/`sbfm_verified_bots` are still `allow` on the
    day.
12. ⛔ **Flip `app.` to Proxied — OWNER ONLY, AND NOT YET.** Four tenants (Gesheft,
    Displaydex, Loopcom Demo, inii mini) still register SIP through `app./sip` because
    clients cache `sipWsUrl` forever and nobody has re-authenticated. Cloudflare idles a
    WebSocket out at ~100 s; a dropped WSS is a phone that does not ring. **Phase B is
    not finished until the PBX contact list (`pjsip show endpoint T<t>_<ext>_1` reading
    `Avail`) shows those tenants registering somewhere other than `app.`** Rollback of
    the flip itself is one click back to DNS-only, effective in seconds.
13. Soak and watch, in this order: portal login (**and the browser console for CSP
    violations from Cloudflare's injected scripts — see C1**), mobile app API calls
    (**watch for 403s → Browser Integrity Check, C1b**), an inbound SMS (proves
    webhooks), a card payment callback, `/ws/telephony` staying up, and a real inbound
    call ringing a softphone.
14. Only then: managed WAF rules in **log mode first**, then rate limiting, then HSTS.

⛔ **Do not enable HSTS before step 14.** It is semi-permanent — browsers cache the
policy — so switching it on while something is still broken can make the broken state
unreachable.

#### C7. Rollback of everything staged in this pass

**One line:** delete the custom rule
`47d54f121d6945419a6483d20f2b887a` ("Skip security for machine-to-machine paths") from
**Security → Security rules → Custom rules**. That restores the zone to exactly the state
it was in before — because it is the only thing that changed.
*(2026-08-18: no longer the only thing — see C8 for the three further items and their
rollback.)*

#### C8. ✅ 2026-08-18 — the staging pass finished: SSL rule, skip rule on both hosts, LOG-only rate limit, LOG-only managed ruleset

Owner-approved. **All writes were made through the dashboard's own same-origin API**
(`https://dash.cloudflare.com/api/v4/zones/<zone>/…` with the logged-in browser
session — the frontend uses exactly this) and **read back with a fresh GET after every
write**, then cross-checked on the dashboard screens. ⛔ Every action created here is
`set_config` / `skip` / `log` — **nothing blocks, nothing challenges**. ⛔ **No DNS
record, no proxy toggle, no HSTS, no BIC, no Security Level, no server change.**

**Method note, so nobody re-derives it:** the browser tool's output redactor mangles
dotted hostnames and hex ids ("[BLOCKED: JWT token]" / "[BLOCKED: Base64]"), so read-backs
were rendered with `.` → `·` and ids space-separated. One deliberate no-op write was made
first to prove the session could write at all: `PATCH /settings/ssl {value:"full"}` — the
value it already had; it answered `200 full`. Nothing else was touched as a probe.

**C8.1 — Configuration Rule (`http_config_settings` entrypoint, created this pass)**
ruleset `f80c6f00fffc4da68c132f25342380ff` v1, rule `47b087a4a5e04d5a9d3f5cd703bf1322`,
enabled, action `set_config`, `action_parameters: { "ssl": "strict" }`.
Expression, verbatim as stored:
```
http.host eq "app.connectcomunications.com"
```
Description: *SSL Full (strict) for app.connectcomunications.com only (zone stays Full
because portal. CNAMEs to a third party)*. **Zone-wide `settings/ssl` read back
`full`, unchanged.** UI: Rules → Overview → Configuration Rules → "Hostname equals
app.connectcomunications.com · SSL · Active". Inert until `app.` is proxied; when it is,
`app.` (real Let's Encrypt cert on the origin) is validated strictly and `portal.` keeps
today's `full` behaviour. ⛔ It names **one** host on purpose — a broader expression
would flip `portal.` to strict and risk a 526 on the Telocall GUI.

**C8.2 — the WAF skip rule now covers both hostnames** (`http_request_firewall_custom`
ruleset `11891f351fa34a2d83c22d5d71d7a13f`, **v1 → v2**, same rule id
`47d54f121d6945419a6483d20f2b887a`, still order 1 of 1, Active, logging on).
Expression, verbatim as stored:
```
(http.host eq "app.connectcomunications.com" or http.host eq "app.loopcom.net") and (starts_with(http.request.uri.path, "/api/webhooks/") or starts_with(http.request.uri.path, "/api/internal/"))
```
Action `skip`, `phases` `http_ratelimit, http_request_firewall_managed,
http_request_sbfm`, `products` `zoneLockdown, uaBlock, bic, hot, securityLevel,
rateLimit, waf`, `ruleset: current` — **byte-identical to before; only the host clause
changed.** ⛔ Reminder: `app.loopcom.net` is on **Squarespace DNS**, not this zone, so
this clause is protective-only today — it matters the day loopcom.net moves onto
Cloudflare, and it means nobody has to remember to add it then.

**C8.3 — rate limiting, LOG ONLY** (`http_ratelimit` entrypoint, created this pass)
ruleset `e14af09b3fb44292a107cc9c02a3f05f` v1, rule `ab375c0db58b4f5da4938e098e298efb`,
enabled, **action `log`**,
`ratelimit: { characteristics: ["ip.src","cf.colo.id"], period: 10, requests_per_period: 20, mitigation_timeout: 10 }`.
Expression, verbatim as stored:
```
(http.host eq "app.connectcomunications.com" or http.host eq "app.loopcom.net") and http.request.uri.path eq "/api/auth/login"
```
Description: *LOG ONLY - login bursts on /api/auth/login (edge visibility; the api has
its own throttle - never Block here, one office NAT would be banned)*. UI: Security rules
→ Rate limiting rules → Action **Log**, Active. ⛔ **Never change this to Block or
Challenge on its own** — `apps/api/src/loginThrottle.ts` already limits per account,
and a Block at the edge keyed on `ip.src` would take out a whole office behind one NAT
(the exact 2026-08-17 blank-app failure shape). Its purpose is to accumulate what a
threshold *would* have caught, for tuning; only after a soak, and only by the owner.

**C8.4 — Cloudflare Managed Ruleset, deployed in LOG mode**
(`http_request_firewall_managed` entrypoint, created this pass) ruleset
`ab86f7288cfc4f35bd8f8f70153fdee3` v1, rule `0f255a07814948f08eb7559ed203056d`, enabled,
action `execute`, expression `true`,
`action_parameters: { id: "efb7b8c949ac4650a09736fc376e9aee", overrides: { action: "log" }, version: "latest" }`.
Description: *Cloudflare Managed Ruleset - LOG ONLY (review before any enforcement; do
not flip to block without the owner)*. **The dashboard's own screen reads "Ruleset
action: Log", "Ruleset status: Default"** (Security rules → Managed rules → Cloudflare
Managed Ruleset). Pro accepted the ruleset-level action override on the first PUT — no
plan refusal, so the "do not deploy if it can only block" branch was not needed.
⛔ **The scope is `true` (all incoming requests to the zone), on purpose:** today the only
proxied hostname is `portal.` (the third-party Telocall GUI), so until `app.` is proxied
the log will hold only portal. events — harmless, since Log never blocks; once `app.` is
proxied it covers it with no further change. The C2/C8.2 skip rule already exempts the
machine paths (`/api/webhooks/`, `/api/internal/`) from this phase in advance.
⛔ "Ruleset status: Default" means rules that Cloudflare ships **disabled** stay
disabled — the log covers the default-enabled set only. That was left deliberately: the
override that carries into eventual enforcement is the action, and it should be the only
one.
⛔ **The OWASP Core Ruleset and the Exposed Credentials Check ruleset were NOT deployed.**

**Left exactly as they were, and read back to prove it:** `browser_check = on`,
`security_level = medium`, HSTS `enabled: false, max_age 0`, `min_tls_version = 1.2`,
`always_use_https = on`, `email_obfuscation = on`, `enable_js = true`,
`sbfm_definitely_automated = allow`, `sbfm_verified_bots = allow`,
`sbfm_static_resource_protection = false`, `ai_bots_protection = block`. Everything C1b
says about BIC and Security Level still stands.

**DNS, before and after, from the API and from the Records screen:** 11 records both
times; `A app` / `A @` / `A m` / `A sip` / `CNAME www` all `proxied=false`,
`CNAME portal → ui.zswitch.net` `proxied=true` (the only one), MX + 4 × TXT unproxied.
`dig @1.1.1.1` from loopcom: `app.` and `sip.` → `45.14.194.179`; `portal.` → Cloudflare
addresses (104.26.x / 172.67.x). **Nothing moved.**

**Server-side after the changes (from loopcom, 2026-08-18 16:52Z, so no workstation
filter in the way):** `/api/health` **200** and `/` **200** on both
`app.connectcomunications.com` and `app.loopcom.net`; `/sip` **101** on all four SIP
hostnames (`app.connectcomunications.com`, `app.loopcom.net`,
`sip.connectcomunications.com`, `sip.loopcom.net`); `portal.` **200** through the edge;
the Cardknox webhook path answers **400** to an empty POST (reaches the app, refuses the
body); a well-formed bad-credential login answers **401 `invalid_credentials`** on both
hosts (⛔ `--data @file` — a 1-character password answers a **500 `internal_error`**;
that is a pre-existing api behaviour, `server.ts:5748` `.parse()` with `min(8)` throwing
into the global handler, not an edge effect — nothing here touches the origin path).

⏳ **NOT PROVEN, and it cannot be yet:** none of the four rules has matched a real
`app.` request, because `app.` is not proxied. They are proven as *stored configuration
read back from the API and displayed by the dashboard*, never as *a request that was
logged/skipped*. The managed ruleset and rate-limit logs will start filling from `portal.`
traffic (managed) and from nothing (rate limit — its hosts are unproxied) until the flip.

**Rollback of this pass (each independent, seconds, all in the dashboard):**
1. Rules → Overview → Configuration Rules → delete
   "SSL Full (strict) for app.connectcomunications.com only" (or
   `DELETE /rulesets/f80c6f00fffc4da68c132f25342380ff/rules/47b087a4a5e04d5a9d3f5cd703bf1322`).
2. Security rules → Custom rules → edit
   "Skip security for machine-to-machine paths" and remove
   ` or http.host eq "app.loopcom.net"` (or PATCH the rule back to the C2 expression;
   the ruleset then becomes v3).
3. Security rules → Rate limiting rules → delete "LOG ONLY - login bursts on
   /api/auth/login".
4. Security rules → Managed rules → Cloudflare Managed Ruleset → delete the deployment
   (or `DELETE /rulesets/ab86f7288cfc4f35bd8f8f70153fdee3/rules/0f255a07814948f08eb7559ed203056d`).
Together with C7 that restores the zone exactly.

**What is still the owner's, unchanged from C6:** the orange cloud on `app.` (⛔ only
after Phase B — the four tenants re-authenticate off `app./sip`), whether BIC comes off
pre-emptively, whether Security Level drops for the API, HSTS last of all, and — new —
**whether the rate limit ever leaves Log, and whether the managed ruleset ever leaves
Log**, both only after reading what they logged during a real soak.

---

## 4b. The OTHER three domains — loopcom.net / .org / .ai (2026-08-16)

Izzy is adding **loopcom.net** and wants both domains treated the same. Inventory
taken before any change; **nothing on these domains has been modified.**

The Squarespace account holds **four** domains: `connectcomunications.com` (already on
Cloudflare nameservers), plus **`loopcom.ai`** (exp. 2028-07-12), **`loopcom.net`** and
**`loopcom.org`** (both exp. 2027-07-12), all three still on
**`nsc1-4.squarespacedns.com`**.

⛔ **`loopcom.net` IS NOT A PARKED DOMAIN — it carries LIVE Google Workspace email**
(full `aspmx.l.google.com` MX set, priorities 1/5/5/10/10) **and a live Squarespace
site** (four A records to 198.49.23.144/145 + 198.185.159.144/145, `www` CNAME →
`ext-sq.squarespace.com`, plus an `HTTPS` service record). **Moving nameservers to
Cloudflare without replicating every one of those first takes down the website AND all
mail.** That is the whole risk of this task and it is not visible from the domain list.

⛔ **`loopcom.net` has NO DMARC** — same gap that was just closed on
connectcomunications.com, and it matters more here because Workspace mail is live.

### ⛔ OWNER'S DECISION, 2026-08-16 — both domains stand ALONE

Izzy, verbatim: *"both domains should have their own DNS records to the server. It
shouldn't go back to connectcomunications."* And on why the old domain stays put:
*"I don't want to take down the connectcomunications because they saw a lot of people
logged into it, so I don't want to change it overnight. For now, let's have them both."*

So the target is **Connect served on BOTH domains in parallel**, each self-contained,
with `connectcomunications.com` **left exactly as it is**.

**Two choices he made, both to be honoured:**

1. **`app.loopcom.net` → 45.14.194.179, and ONLY that.** ⛔ **Do NOT repoint the apex
   or `www`** — they serve the **live Squarespace marketing site**, and moving them
   takes it down the moment DNS propagates. The subdomain is purely additive: site up,
   mail up, nothing existing can break. It mirrors `app.connectcomunications.com`.
2. **DMARC reports go to `dmarc@loopcom.net`**, not to the other domain.

⛔ **A correction to undo:** loopcom.net's `rua` currently still points at
`support@connectcomunications.com`, and
`loopcom.net._report._dmarc.connectcomunications.com` was added in Cloudflare to
authorise that hop. **That is exactly the coupling the owner rejected.** Fix the `rua`
first, then delete the authorisation record — it is inert once the `rua` is
same-domain. Deliberately left in place rather than deleted early, so the domain is
never sitting in a half-migrated state.

### ⛔ THE BLOCKER: Squarespace demands a Google re-auth an agent cannot pass

Every DNS edit on these domains triggers **"Verify to continue as
support@connectcomunications.com — Login with Google to continue."** An agent must not
authenticate as the owner, so **all Squarespace DNS work needs Izzy at the keyboard.**
It reappears after a short idle, so it will interrupt a long session more than once.

### Remaining steps, in order

**At Squarespace** (loopcom.net → DNS → *Custom records*):
1. ✅ **DONE 2026-08-16** — `app.loopcom.net` A → `45.14.194.179`. Verified resolving,
   and verified **non-destructive**: apex still returns all four Squarespace A records,
   `https://loopcom.net/` still answers **200**, and the **5 Google MX records are
   untouched**. ✅ **It now SERVES Connect too** — cert + nginx block landed the same
   day, see the server section below.
2. Edit the existing `_dmarc` TXT → `v=DMARC1; p=none; rua=mailto:dmarc@loopcom.net`.
3. Create `dmarc@loopcom.net` as a Google Workspace alias. ⛔ Without the mailbox,
   reports bounce and are **silently** lost — the record will look perfect.

**In Cloudflare** (connectcomunications.com → DNS): delete
`loopcom.net._report._dmarc` once step 2 has landed.

**On the server** — ✅ **DONE AND VERIFIED FROM OUTSIDE, 2026-08-16.**
`app.loopcom.net` now serves Connect on its own Let's Encrypt certificate.

- **Certificate:** `certbot certonly --nginx -d app.loopcom.net --cert-name
  app.loopcom.net --deploy-hook 'systemctl reload nginx'`, expires **2026-11-14**,
  auto-renewing. ⛔ **`certbot --nginx` (the installer form) cannot be the first step** —
  it needs a server block already carrying that `server_name` or it has nothing to
  install into. A throwaway port-80 block was created first, then `certonly` was used so
  **certbot never rewrote the hand-written vhost** (it merged 80 and 443 into one block
  when it did own the `sip.` file — see Phase A).
- **nginx:** a NEW file, `/etc/nginx/sites-available/connectcomms-loopcom`, symlinked
  into `sites-enabled`. ⛔ **`/etc/nginx/sites-enabled/connectcomms` was NOT touched** —
  people are logged into that domain. Verified byte-identical to its pre-change backup.
- ⛔ **The filename matters.** `sites-enabled/*` is included in sorted order and the
  FIRST `listen 443` block is nginx's default server for unmatched hostnames. The name
  `connectcomms-loopcom` sorts **after** `connectcomms`, so the default stays the
  `app.connectcomunications.com` block. A name like `app-loopcom` would silently have
  become the default server for every unmatched TLS hostname.
- ⛔ **`security-headers.conf` is `include`d into `location /` and `location = /privacy`
  here too.** nginx does not inherit `add_header` into a block that defines its own, and
  both of those set `Cache-Control`. Without the include this domain would have shipped
  the same zero-security-header portal that was just fixed on the other one.
- **Proven from an external workstation, not from the box:** cert `CN=app.loopcom.net`;
  `/` **200**; `/api/health` **200 `{"ok":true}`**; `http://` → **301**; `/login` returns
  all five security headers **and** `Cache-Control: no-store, must-revalidate`;
  `POST /api/auth/login` with bad credentials → **401**; a real `/_next/static/*.css`
  → **200**; `/sip` → **101 Switching Protocols**. Path-by-path parity against
  `app.connectcomunications.com` on `/healthz`, `/api/health`, `/privacy`,
  `/desktop/latest.yml`, `/agent-api/health` — **identical status codes on every one**.
- **Non-destructive, re-verified after the change:** loopcom.net apex still returns all
  four Squarespace A records, `https://loopcom.net/` still **200**, and all **5 Google
  MX records are untouched**.
- **Backups:** `/root/nginx-connectcomms-backup-20260816-180406.conf`,
  `/root/nginx-connectcomms-sip-backup-20260816-180406.conf`,
  `/root/nginx-full-backup-20260816-180406.tar.gz` (whole `/etc/nginx`),
  `/root/nginx-connectcomms-loopcom-stage1-backup-20260816-180406.conf`.
  Rollback: `rm /etc/nginx/sites-enabled/connectcomms-loopcom && nginx -t &&
  systemctl reload nginx` — the new domain goes back to answering on the wrong cert and
  **nothing else changes**.

### ⛔⛔ A SECOND HOSTNAME MAKES EVERY HARDCODED ABSOLUTE API URL A BUG CLASS — the pay pages were already broken on it (FIXED + DEPLOYED 2026-08-16, `93a85d25`)

The line above ("budget a real test pass, do not assume it just works") was right, and
this is what that pass found on the very first page opened. **Portal only — no nginx,
no DNS, no Cloudflare, no env, no PBX.**

- ⛔⛔ **THE RULE, and it is now a CLASS, not an incident: the moment Connect is served
  on more than one hostname, any hardcoded absolute API URL in the portal is a live
  outage on every hostname that is not the hardcoded one.** `NEXT_PUBLIC_API_URL` is
  **empty** in `app-portal-1`, so four public pages fell through to a literal
  `|| "https://app.connectcomunications.com/api"`. On `app.loopcom.net` the browser
  then made a **cross-origin** request, the api sends no `Access-Control-Allow-Origin`,
  and the fetch was **blocked outright**:
  ```
  Access to fetch at 'https://app.connectcomunications.com/api/billing/platform/pay-links/PROBE000'
  from origin 'https://app.loopcom.net' has been blocked by CORS policy
  Uncaught (in promise) TypeError: Failed to fetch
  ```
  ⛔ **This is a DEAD PAY PAGE, not a cosmetic problem** — the customer sees a
  permanent loading state and cannot pay.
- ⛔ **It is invisible from the old host.** The identical URL on
  `app.connectcomunications.com` returns a clean 404. Any check run only against the
  original hostname passes and proves nothing. **Test new-host bugs on the new host.**
- ⛔⛔ **THE TRAP: ONE BLANKET "make it relative" FIX BREAKS MOBILE PAIRING.** These are
  **two different questions with different answers** and they must never be collapsed
  into one helper:
  1. **The three pay pages** (`app/p/[code]`, `app/pay/invoice/[token]`,
     `app/pay/invoices/[token]`) `fetch` from the page the customer is already on →
     the answer is a **same-origin RELATIVE base (`/api`)**, correct on every hostname
     nginx serves, present and future, with no CORS at all.
  2. **`components/QRPairingModal.tsx` is NOT that case.** It bakes the base into a **QR
     code scanned by a PHONE**. ⛔ A relative `/api` is meaningless off-device — mobile
     does `fetch(\`${apiBaseUrl}/...\`)` (`apps/mobile/src/api/client.ts:1210`) and React
     Native's `fetch` rejects a relative URL. It must stay **ABSOLUTE**, but derived
     from **`window.location.origin` at runtime**, never a hardcoded domain, so a phone
     paired from either host talks to the host it was paired from.
- **Both now live in `apps/portal/lib/publicApiBase.ts`**: `resolveSameOriginApiBase()`
  and `resolveAbsoluteApiBase()`, plus `currentBrowserOrigin()`.
  **`NEXT_PUBLIC_API_URL` still wins when set** (that is how local dev points at
  `:3001`) — only the fallback changed. A *relative* env override is made absolute for
  the QR rather than passed through, and with no origin at all (server render) the QR
  base falls back to the legacy absolute rather than ever emitting a relative path.
  This mirrors what **`services/apiClient.ts` already did for authenticated calls** —
  the public pages use bare `fetch` and never got it. ⛔ Prefer `apiClient` on any new
  page; if you must use bare `fetch`, use these helpers.
- ⛔ **The guard reads the CALL SITES' SOURCE, not just the helpers** — the defect was
  **four callers**, and a unit test of a resolver passes straight through that (same
  shape as `sipPublicEndpoint.test.ts` and `internalDoorBypass.test.ts`).
  `apps/portal/lib/publicApiBase.test.ts`, **14 tests**, registered in the portal `test`
  script. **Proven to be a real guard: all four pre-fix files fail it.** It also asserts
  the QR modal does **not** use the same-origin resolver.
- ✅ **PROVEN IN A REAL BROWSER ON BOTH HOSTS, after deploy.** All three pay routes,
  probe code `PROBE000`, signed out, no real payment data:

  | route | app.loopcom.net | app.connectcomunications.com |
  |---|---|---|
  | `/p/PROBE000` | 404 | 404 |
  | `/pay/invoice/PROBE000` | 410 | 410 |
  | `/pay/invoices/PROBE000` | 401 | 401 |

  **Identical status on every route on both hosts.** Every request went to
  `https://app.loopcom.net/api/...` — **zero requests to the other domain** — and the
  page renders its honest "this link is invalid" copy instead of hanging. Console
  filtered for `CORS|Failed to fetch|Content Security|Refused|Access-Control` on both
  hosts: **no matches.**
- ✅ **Container-verified, not log-verified:** `grep -c app.connectcomunications.com` on
  all three shipped pay-page chunks inside `app-portal-1` is **0**; the legacy literal
  now survives only inside the resolver module as the SSR-only fallback, and the QR
  chunk calls `LJ(env, AU())` — the absolute resolver with the live origin.
- ⏳ **NOT PROVEN: no phone has been paired from `app.loopcom.net`.** The QR half is
  proven by unit test and by reading the shipped bundle, **not by scanning a code with a
  real handset**. That is the acceptance test: open the QR modal on `app.loopcom.net`,
  scan it, and confirm the phone provisions. ⏳ **No real payment has been taken on
  either host since the change** — the pay pages are proven to *load and reach the api*,
  not to have completed a charge.
- ⏳ **STILL HARDCODED, deliberately out of scope** (each is the same bug class, none is
  a pay path): `components/AppDownloadCard.tsx:8` (the Android APK link — a customer on
  loopcom.net is sent to the other domain to download; it works, but it leaks the old
  brand), `navigation/navConfig.ts:88` (the desktop installer link, same), and
  `app/(platform)/billing/invoices/[id]/page.tsx:46` (already prefers
  `window.location.origin` and only falls back when there is no window — the mildest
  case). ⛔ **Treat the whole class as a sweep, not four one-offs**, and re-run
  `grep -rn "app\.connectcomunications\.com" apps/portal --include=*.ts --include=*.tsx`
  (exclude `.next`) before believing it is finished.

⛔ **STILL TRUE AND STILL UNRESOLVED: clients on `app.loopcom.net` are handed a SIP URL
on a DIFFERENT hostname.** `apps/api/src/sipPublicEndpoint.ts` holds **one global
value**, so a softphone signed in on loopcom.net registers against
`sip.connectcomunications.com`. It works, but it means the domains are not actually
independent. Making it per-domain (or per-tenant) is an **OPEN DESIGN DECISION the owner
has not made** — deliberately not "fixed" here.

⏳ **NOT PROVEN: nobody has signed into the portal on `app.loopcom.net` in a browser**,
and no softphone has registered from it. Sessions, cookies and CSP are host-scoped, so
that pass is real work, not a formality.

⛔ **Serving the portal on a SECOND hostname is not just DNS + nginx** — and this is no
longer a warning, it is a **proven, customer-facing outage**: the public pay pages were
dead on `app.loopcom.net` from the moment it started serving Connect. See the
hardcoded-API-URL section above. Sessions,
cookies and the CSP `connect-src` are host-scoped, and clients are still handed
`wss://app.connectcomunications.com/sip` for SIP (see `sipPublicEndpoint.ts` — it is a
single global value, **not per-domain**, so a second domain does NOT get its own SIP
host without further work). **Budget a real test pass on login and softphone
registration from the new domain; do not assume it just works.**

⛔ **"They're gonna do the same thing" is a FUTURE state, not the current one.**
`loopcom.net` today serves a Squarespace marketing site, not Connect.

✅ **DMARC IS DONE ON loopcom.net (2026-08-16)** — added as a Squarespace *custom
record*, `p=none` monitor mode. Verified resolving, and the **5 Google MX records are
untouched**.

⛔ **A cross-domain `rua` DOES NOTHING WITHOUT AN AUTHORIZATION RECORD, and this is the
part everyone forgets.** loopcom.net's reports go to `support@connectcomunications.com`
— a *different* domain — and RFC 7489 requires the **receiving** domain to publish
consent, or Google/Microsoft/Yahoo simply refuse to send. So this was also added, in
Cloudflare on connectcomunications.com:

```
loopcom.net._report._dmarc.connectcomunications.com   TXT   "v=DMARC1"
```

Verified live. **Without it the policy record still "works" — it just silently produces
no reports, which defeats the entire point of p=none.** Any future domain pointing its
`rua` at connectcomunications.com needs its own matching `<domain>._report._dmarc` entry.

⛔ Squarespace demands a **Google re-authentication** ("Verify to continue as
support@…") before DNS edits. An agent cannot pass that gate — it needs the owner.

**Order of work for the remaining domains (`loopcom.org`, `loopcom.ai`):**
1. ✅ Done for loopcom.net. Repeat the same two records for `.org` and `.ai` if they
   send mail — safe, no nameserver change needed.
2. Export the FULL record set for the domain, including the `HTTPS` record and any
   Google verification TXT.
3. Create the Cloudflare zone, **re-enter every record and verify each one**, and only
   then change nameservers at Squarespace. Keep MX and SPF/DKIM **DNS-only**.
4. ⛔ Verify mail flow (send + receive) and the website **before** proxying anything.

⛔ **UNRELATED BUT URGENT, found on the Squarespace domains page:** a banner reads
*"There was a problem with your email address — We couldn't reach the email address
support@connectcomunications.com."* An unverified ICANN registrant contact can get a
domain **SUSPENDED**, and it also means renewal notices are reaching nobody.
`connectcomunications.com` expires **2027-08-13**. This is plausibly downstream of the
known `support@` mail problems (the bounce-loop `discard:` transport and the shared
500/day Gmail cap). **Needs a human to fix the contact address.**

## 5. What I recommend

Phase A is genuinely safe and can be done any time — it changes nothing for any
customer and leaves a tested SIP hostname sitting ready.

Phase B is the real cost: it needs four customers' users to sign out and back in, and
Gesheft is the busiest queue tenant on the platform. That is a scheduling decision.

⛔ **Do not start Phase C until B has soaked for at least a few days.** If SIP is still
partly on `app.` when the orange cloud goes on, the failure mode is phones that stop
ringing for the tenants that did not migrate — and it will look like a Cloudflare
problem rather than a missed migration.

**Honest cost/benefit:** on the Free plan the edge buys DDoS absorption, a basic managed
ruleset, one rate-limiting rule, and origin concealment. That is real but it is not a
WAF programme. If the goal is serious edge security, **Pro ($20/mo) is what makes Phases
C+ worth the migration effort** — it unlocks the full managed ruleset and proper bot
management. Worth deciding before paying the Phase B cost in customer disruption.
