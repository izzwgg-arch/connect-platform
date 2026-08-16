# PLAN — put Connect behind Cloudflare, and the SIP split-out that has to happen first

Status (2026-08-16): **PHASE A DONE AND VERIFIED. PHASE B'S SERVER SIDE IS DONE —
BUT NOT ONE TENANT HAS MOVED. PHASE C NOT STARTED.**
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
⛔ **Also 2026-08-16: `sip.loopcom.net` IS LIVE AND SERVING SIP (101) — but the flip to
it is STAGED, NOT APPLIED. See Phase A2.** DNS, cert and nginx are done and proven, and
all three pre-existing SIP hostnames still return 101. **However `.env.platform` says
`wss://sip.loopcom.net/sip` while the running `app-api-1` still says
`wss://sip.connectcomunications.com/sip`** — `deploy-direct.sh` **skipped the restart and
still printed `success`**, because an env var is not a code path. ⛔ **There is no
sanctioned deploy path for an env-only change**; the next api deploy touching api code
will ship this flip unobserved. Read Phase A2 before deploying api.
Every step is reversible and each carries its own rollback.

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

## Phase A2 — `sip.loopcom.net` — ✅ SERVING SIP. ⛔ THE ENV FLIP IS STAGED BUT THE CONTAINER HAS NOT PICKED IT UP

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

10. Set SSL/TLS to **Full (strict)** — safe because the origin holds a valid Let's
    Encrypt cert. Do this *before* the orange cloud, not after.
11. Confirm **Bot Fight Mode is OFF**; add WAF skip rules for `/api/webhooks/*` and
    `/api/internal/*`.
12. **Flip `app.` to Proxied.** Rollback is one click back to DNS-only, effective in
    seconds — this is genuinely the easiest step to undo in the whole plan.
13. Soak and watch, in this order: portal login, mobile app API calls, an inbound SMS
    (proves webhooks), a card payment callback, `/ws/telephony` staying up, and a real
    inbound call ringing a softphone.
14. Only then: managed WAF rules in **log mode first**, then rate limiting, then HSTS.

⛔ **Do not enable HSTS before step 14.** It is semi-permanent — browsers cache the
policy — so switching it on while something is still broken can make the broken state
unreachable.

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
