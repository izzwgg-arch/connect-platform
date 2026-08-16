# PLAN — put Connect behind Cloudflare, and the SIP split-out that has to happen first

Status (2026-08-16): **PHASE A DONE AND VERIFIED. PHASE B'S SERVER SIDE IS DONE —
BUT NOT ONE TENANT HAS MOVED. PHASE C NOT STARTED.**
⛔ **Read that middle clause literally.** `SIP_PUBLIC_WS_URL` is set and the api serves
`wss://sip.connectcomunications.com/sip`, but **the apps never refresh a cached
`sipWsUrl`**, so every phone signed in today is still registering against `app.` and
will keep doing so until its user signs out and back in. **Phase B is NOT complete and
`app.` MUST NOT be proxied yet.** Migrating the four tenants is the owner's to schedule.
Also new this day: **`app.loopcom.net` now serves Connect** (§4b).
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

⛔ **STILL TRUE AND STILL UNRESOLVED: clients on `app.loopcom.net` are handed a SIP URL
on a DIFFERENT hostname.** `apps/api/src/sipPublicEndpoint.ts` holds **one global
value**, so a softphone signed in on loopcom.net registers against
`sip.connectcomunications.com`. It works, but it means the domains are not actually
independent. Making it per-domain (or per-tenant) is an **OPEN DESIGN DECISION the owner
has not made** — deliberately not "fixed" here.

⏳ **NOT PROVEN: nobody has signed into the portal on `app.loopcom.net` in a browser**,
and no softphone has registered from it. Sessions, cookies and CSP are host-scoped, so
that pass is real work, not a formality.

⛔ **Serving the portal on a SECOND hostname is not just DNS + nginx.** Sessions,
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
