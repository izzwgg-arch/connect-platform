# loopcom.net → Cloudflare: configured, NOT activated (2026-08-24)

Zone `889e21bf6dcf463ec185882776fff6b0`, account
`c52b8cceadcd2b113e74350b72365765`, **Free plan**, status **pending** (the
nameservers have NOT been changed).

## ⛔⛔ THE BLOCKER — READ THIS BEFORE TOUCHING NAMESERVERS

**loopcom.net is DNSSEC-signed.** Measured 2026-08-24:

    dig +short DS loopcom.net @a.gtld-servers.net
    659 8 2 DB562134F99F53036F2829273ACA5421A65FE8EA5F4DD8F19121AE07 17AD5DE2   (TTL 86400)

and `dig @1.1.1.1 / @8.8.8.8 / @9.9.9.9 loopcom.net A +dnssec` all return the
**`ad` flag** — three major resolvers are actively validating this domain.

Changing the nameservers while that DS is published = **SERVFAIL everywhere**,
taking down not only the website but **the Google Workspace MX for the whole
company** and **`app.loopcom.net` / `sip.loopcom.net`**, Connect's production
SIP-over-443 route.

**Safe sequence (the wait is mandatory, not advisory):**

1. Squarespace → Domains → loopcom.net → DNS → **DNSSEC** → disable.
   (Safe on its own. Resolvers just stop validating; nothing breaks.)
2. **Wait ≥ 24 h** for the 86400 s DS TTL. Confirm BOTH:
   - `dig +short DS loopcom.net @a.gtld-servers.net` → empty
   - the `ad` flag is gone from all three resolvers above
3. Squarespace → DNS → **Domain Nameservers** → Use custom nameservers →
   `jake.ns.cloudflare.com`, `nola.ns.cloudflare.com`
4. Re-enable DNSSEC at Cloudflare and publish its new DS at the registrar.

**Rollback at any point:** put the four Squarespace nameservers back —
`nsc1.squarespacedns.com` … `nsc4.squarespacedns.com`.

## What is already configured in Cloudflare (inert until step 3)

| Setting | Value | vs connectcomunications.com |
|---|---|---|
| SSL/TLS mode | **Full (Strict)** | same |
| Minimum TLS version | **1.2** | same |
| TLS 1.3 | on | same |
| Always Use HTTPS | **on** | same |
| Automatic HTTPS Rewrites | on | cc is off — loopcom is stricter, kept |
| HTTP/3 | on | cc is off — kept |
| Security level | medium | same |
| Browser Integrity Check | on | same |
| HSTS | **off** | same (deliberate — semi-permanent, do last) |
| Challenge passage | 1800 s | same |
| Managed WAF ruleset | free ruleset auto-applied | ⛔ cc is **Pro** and deploys the ruleset in LOG mode. Free cannot deploy/override one. This item genuinely cannot be mirrored. |
| Super Bot Fight Mode | **not available on Free** | cc (Pro) has sbfm_* = allow |
| Bot Fight Mode | not offered while the zone is pending — **re-check after activation** | n/a |
| AI bot policies | Search = **Allow** | ⛔ cc is `block`; deliberately NOT mirrored — see below |

### DNS — all 15 records verified byte-identical to Squarespace

Every A record and the CNAME hash identically. All four TXT records match once
the quoting/chunking representation is normalised, **including the full
2048-bit DKIM key** (410 chars, sha256[0:16] `e025f1a7d3e5b04f` on both sides).

Proxy status is correct and load-bearing:

- **Proxied (orange):** `loopcom.net`, `www.loopcom.net` only
- **DNS only (grey):** `app`, `sip`, `turn`, `_domainconnect`, 5× MX, 4× TXT

⛔ `app` and `sip` MUST stay DNS-only. Cloudflare idles a WebSocket out at
~100 s; proxying them is phones that stop ringing. Cloudflare's own scan had
defaulted both to Proxied and had **missed `turn` entirely** — both corrected
before activation.

### Security rules deployed (verified via the API, not the UI)

1. **Custom rule** — "Block probes for software this site does not run",
   ACTIVE, action `block`, 974-char expression covering `/wp-admin`,
   `/wp-login`, `/wp-content`, `/wp-includes`, `/xmlrpc.php`, `/.env`,
   `/.git`, `/.aws`, `/phpmyadmin`, `/phpunit`, `/cgi-bin`, `/.ssh`,
   `/vendor/phpunit`, and any path ending `.php`, `.asp`, `.aspx`, `.jsp`,
   `.cgi`. None of these exist on a static site, so false positives are
   structurally impossible.
2. **Rate limiting rule** (Free allows exactly one) — "Shed form-endpoint
   floods at the edge", ACTIVE, `starts_with(http.request.uri.path, "/api/")`,
   **30 requests / 10 s per IP+colo, block 10 s**.
   ⛔ Deliberately ~15× looser than the origin's nginx `12r/m burst=5`. nginx
   stays the precise limiter; the edge only sheds genuine floods before they
   reach the VPS. `/api/` is the only path that is never cached and always
   costs the origin real work.

### ⛔ One setting deliberately NOT mirrored, and why

`ai_bots_protection` is `block` on connectcomunications.com and was left
permissive here. That zone is an **app host**, where AI crawlers have no
legitimate business. This is a **marketing site whose whole job is to be
found** — blocking AI crawlers stops ChatGPT, Claude and Perplexity citing
Loopcom when someone asks who does business phone systems in the Hudson Valley.
That is free distribution for a B2B service. Mirroring the letter here would
have failed the intent. One toggle if Izzy wants it blocked:
Security → Settings → filter "Bot traffic" → Block AI bots.

## Turnstile

Widget **"Loopcom website forms"**, site key `0x4AAAAAAEamM79uqjq_a-aY`,
Managed mode, hostnames `www.loopcom.net` + `loopcom.net`, no pre-clearance.

⛔ **Works WITHOUT the zone being proxied** — Cloudflare's own words: "Turnstile
can be embedded into any website without sending traffic through Cloudflare."
That is why the robot check is already live and proven while the zone is still
pending.
