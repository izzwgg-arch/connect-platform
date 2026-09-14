# ⛔⛔ AGENT HANDOFF — Cloudflare Phase C staging is COMPLETE and `app.` IS STILL DNS-ONLY (2026-08-17 → 2026-08-18) — READ FIRST before touching ANY Cloudflare setting, before looking for "Bot Fight Mode", before adding a WAF rule, before changing SSL/TLS mode, before flipping ANY rule from Log to Block, and before anyone says "just turn the orange cloud on"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/PLAN_CLOUDFLARE_EDGE_SIP_SPLIT_2026-08-16.md` → Phase C**
(2026-08-17 first pass = the update box + C1–C7; **2026-08-18 second pass = §C8**.)
(**Cloudflare only, both passes. No DNS record touched, no proxy toggle moved, no
server config, no nginx, no env, no deploy, no PBX write, no tenant row.**)

- ✅✅ **2026-08-18, OWNER-APPROVED SECOND PASS — FOUR MORE THINGS EXIST, ALL LOG / SKIP /
  SCOPED-CONFIG ONLY, ALL INERT UNTIL `app.` IS PROXIED, EVERY ONE READ BACK FROM THE
  API AND SEEN ON THE DASHBOARD SCREEN AFTER THE WRITE.** (1) **Configuration Rule**
  `47b087a4a5e04d5a9d3f5cd703bf1322` (ruleset `f80c6f00…`): expression exactly
  `http.host eq "app.connectcomunications.com"` → SSL **Full (strict)**; ⛔ **the
  zone-wide mode is still `full`** (read back) so `portal.` (Telocall GUI, third-party
  CNAME) cannot regress — never widen that expression. (2) **The WAF skip rule
  `47d54f121d6945419a6483d20f2b887a` now reads
  `(http.host eq "app.connectcomunications.com" or http.host eq "app.loopcom.net") and (...same two paths...)`**
  — same rule id, ruleset `11891f35…` v1→v2, action/products/logging byte-identical.
  (3) **Rate limit `ab375c0db58b4f5da4938e098e298efb` (ruleset `e14af09b…`), action
  `log`**, `/api/auth/login` on both hosts, 20 req/10 s per `ip.src`+`cf.colo.id`.
  ⛔ **NEVER flip it to Block/Challenge on your own** — `loginThrottle.ts` already
  throttles per account, and an edge block keyed on IP bans a whole office behind one
  NAT (the 2026-08-17 blank-app shape). (4) **Cloudflare Managed Ruleset DEPLOYED with
  `overrides.action = "log"`** (entrypoint `ab86f728…`, rule `0f255a07…`, executes
  `efb7b8c949ac4650a09736fc376e9aee`, status Default, scope `true`) — the dashboard's
  own screen reads **"Ruleset action: Log"**. Pro accepted the ruleset-level override
  on the first PUT. ⛔ OWASP + Exposed-Credentials rulesets were **NOT** deployed.
  ⛔ Nothing here blocks or challenges anything; **the acceptance test is the soak after
  the flip — read what the two Log rules logged before anyone proposes enforcement.**
- ✅ **How the writes were made, so nobody re-derives it:** the dashboard's own
  same-origin API (`https://dash.cloudflare.com/api/v4/zones/<zone>/…`, browser session,
  `credentials:'include'`) — a no-op `PATCH /settings/ssl {value:"full"}` (its existing
  value) proved the session could write; then PUT the phase entrypoints / PATCH the one
  rule, and GET each back. ⛔ The browser tool's redactor mangles dotted hostnames and hex
  ids ("[BLOCKED: JWT token]") — render read-backs with `.`→`·` and ids space-split, or
  a correct expression reads like a leak.
- ✅ **Verified after the pass, from the server:** `/api/health` **200** + `/` **200** on
  both app hostnames, `/sip` **101** on all four SIP hostnames, `portal.` **200**,
  Cardknox webhook path **400** to an empty POST (reaches the app), bad-credential login
  **401** on both hosts. DNS: **11 records, `portal.` still the only Proxied one.**
  ⛔ Aside, pre-existing, not touched: a **1-character password** on `/api/auth/login`
  answers **500 `internal_error`** (`server.ts:5748` `.parse()` `min(8)` throwing into
  the global handler) — a well-formed bad credential is a clean 401; use `--data @file`.
- ⛔ **Rollback of the 2026-08-18 pass = four independent deletes/edits in the
  dashboard** (listed in §C8); with the C7 one-liner that restores the zone exactly.

*(The bullets below are the 2026-08-17 first pass and are all still true, except that C3
"managed ruleset deliberately NOT deployed" and C4 "SSL rule deliberately not created"
are now superseded by the pass above.)*

- ⛔⛔ **THE ORANGE CLOUD HAS NOT BEEN TURNED ON AND MUST NOT BE.** Read back from the
  Cloudflare API **after** the change: `app.` **DNS only**, apex **DNS only**, `m.` (the
  PBX) **DNS only**, `sip.` **DNS only**, `www` **DNS only**, and **`portal.` is the only
  proxied record** — 11 records before, 11 after, identical flags. Confirmed
  independently by `dig @1.1.1.1`: `app.` and `sip.` still answer **45.14.194.179**, not
  a Cloudflare address. **Four tenants (Gesheft, Displaydex, Loopcom Demo, inii mini)
  still register SIP through `app./sip`** because clients cache `sipWsUrl` forever;
  Cloudflare idles a WebSocket out at ~100 s, so proxying `app.` today is phones that
  stop ringing. **That flip is Izzy's, after Phase B is actually finished.**
- ⛔⛔ **"CONFIRM BOT FIGHT MODE IS OFF" IS A DEAD INSTRUCTION — THERE IS NO SUCH ROW ON
  THIS ZONE.** The zone is **Pro** (`18df003591a21edaf96e8f5e2a20fb58`), which replaces
  Bot Fight Mode with **Super Bot Fight Mode**, and the whole area has been reorganised
  under *Security → Settings → filter "Bot traffic"*. A previous session hunted for the
  old row, found nothing, and had nothing to check against. ✅ **The bot layer was
  ALREADY safe and nothing needed turning off**: `sbfm_definitely_automated: allow`,
  `sbfm_verified_bots: allow`, `sbfm_static_resource_protection: false`, AI Labyrinth
  **off**, and the new "Configure AI bot policies" card (Search / Agent / Training) all
  **Allow (do not block)**. ⛔ **The replacement check is one API read —
  `GET /zones/<id>/bot_management` → both `sbfm_*` fields must read `allow`.** Anything
  else there challenges the mobile apps (`okhttp`, `Loopcom/NN`) and every inbound
  webhook. **Do not judge this from the screen; the dashboard shows cards, the API shows
  values.**
- ⚠️ **THREE THINGS WERE LEFT ON DELIBERATELY, because "I cannot tell what it does to
  API traffic" means leave it and report, not guess.** All three are neutralised on the
  machine paths by the skip rule below; the residual exposure is the *ordinary* mobile
  API surface. **(1) Browser Integrity Check (`browser_check: on`)** — documented to deny
  "non standard user agents"; `okhttp` passes in practice but that is unprovable until
  `app.` is proxied. **This is the highest-risk remaining item: if mobile clients start
  getting 403 during the soak, this is the first toggle to flip, and it is one click.**
  **(2) `security_level: medium`** — IP-reputation challenge; ⛔ the real worry is
  **T-Mobile CGNAT** (Create A Box ext 102 roams 14 source IPs a day), where a shared
  address can carry someone else's threat score. **(3) `ai_bots_protection: block`** —
  scoped to AI *crawlers*, so it should never match a webhook, but Cloudflare folds
  **mixed-purpose crawlers in on 2026-09-15** and this zone is opted **in**.
- ⚠️ **`enable_js: true` and `email_obfuscation: on` are a CSP question, not a bot
  question.** Neither blocks anything — they inject script into **HTML** responses, and
  cannot touch a JSON API or a webhook POST. But the portal ships a real CSP from
  `security-headers.conf`, and an injected inline script is exactly what a CSP blocks.
  ⛔ **On soak day, the symptom to look for is CSP violations in the browser console on
  `/login`, NOT a failed API call.** Nobody has seen this either way.
- ✅ **THE ONE CHANGE: a WAF skip rule, created, Active, and read back from the API.**
  Rule `47d54f121d6945419a6483d20f2b887a` in ruleset `11891f351fa34a2d83c22d5d71d7a13f`,
  order 1 of 20, logging on. Expression, verbatim:
  ```
  http.host eq "app.connectcomunications.com" and (starts_with(http.request.uri.path, "/api/webhooks/") or starts_with(http.request.uri.path, "/api/internal/"))
  ```
  Action `skip` with `phases: [http_ratelimit, http_request_firewall_managed,
  http_request_sbfm]` and `products: [zoneLockdown, uaBlock, bic, hot, securityLevel,
  rateLimit, waf]` — i.e. **everything Pro can skip**, including Browser Integrity Check
  and Security Level.
- ⛔ **THE CARDKNOX CALLBACK NEEDS NO SEPARATE RULE, AND THAT WAS CHECKED, NOT ASSUMED.**
  `PUBLIC_API_BASE_URL`, `PUBLIC_API_URL` and `PUBLIC_PORTAL_URL` are **all empty inside
  `app-api-1`** (`docker exec`), so `billingSolaCardknoxWebhookUrl()` falls through to
  `https://app.connectcomunications.com/api/webhooks/sola-cardknox` — already inside
  `/api/webhooks/`, along with `voipms/sms`, `twilio/sms-status`, `pbx`, `whatsapp/meta`
  and `whatsapp/twilio/status`. ⛔ **Set `PUBLIC_API_BASE_URL` to a different host and
  this rule stops covering Cardknox**, because the expression pins the hostname.
- ⛔ **THE HOST CLAUSE IS THE RULE'S POINT *AND* ITS LIMITATION.** It makes the rule
  provably inert while `app.` is DNS-only and stops it ever touching `portal.` — **but a
  new proxied hostname gets NO protection from it.** Add the hostname to the expression
  in the same change that proxies it. ⛔ "All remaining custom rules" is checked on
  purpose: a future block rule can never take out a webhook, and equally a future
  deliberate block on those paths will not work.
- ⛔ **SSL/TLS WAS INVESTIGATED AND DELIBERATELY NOT CHANGED — it is still `full`, not
  Full (strict).** Measured from the server: `ui.zswitch.net` (the origin behind
  `portal.`, the only proxied record) presents a **valid publicly-trusted GoDaddy cert**,
  `CN=*.zswitch.net`, SAN `*.zswitch.net, zswitch.net`, expiring **2026-10-29**,
  `Verify return code: 0 (ok)`. ⛔ **That proves the cert is valid for the CNAME TARGET,
  not for `portal.connectcomunications.com` — which is exactly why it was not flipped.**
  **Recommendation: never flip the zone at all — add a Configuration Rule scoped to
  `http.host eq "app.connectcomunications.com"` setting SSL to Full (strict)** (`app.`
  holds a real Let's Encrypt cert), leaving `portal.` on Full so it cannot regress.
  Not created — it is still an SSL change and belongs to Izzy.
- ✅ **HSTS is OFF and stays off** (`strict_transport_security.enabled: false`,
  `max_age 0`). It is semi-permanent — browsers cache it — so it is the *last* step,
  after the soak.
- ✅ **The zone is otherwise a genuinely clean slate**, verified by API: **no** managed
  ruleset deployed at all (the `http_request_firewall_managed` entrypoint does not
  exist), 0 rate-limiting rules, 0 page rules, 0 IP access rules, 0 UA-blocking rules,
  0 zone lockdowns, 0 configuration/transform/redirect rules. Universal SSL is **active**
  and covers `*.connectcomunications.com`, so `app.` gets an edge cert automatically the
  moment it is proxied — nothing to order.
- ✅ **Verified healthy from the SERVER after the change** (⛔ never from Izzy's
  workstation — his content filter 403s the `app.` hostnames and fakes a regression):
  `/api/health` **200** on both `app.connectcomunications.com` and `app.loopcom.net`,
  portal `/` **200**, `portal.connectcomunications.com` **200**, and **all four SIP
  hostnames still `101 Switching Protocols` + `Sec-WebSocket-Protocol: sip`**. The
  Cardknox path answers **400** to an empty POST — i.e. it reaches the application and
  is refusing the body, which is the correct proof it is not blocked at an edge.
- ⏳ **NOT PROVEN, and it cannot be yet: the skip rule has matched ZERO requests**,
  because nothing is proxied so no traffic reaches the edge. It is proven as stored
  configuration read back from the API, never as a request that was actually skipped.
  ⏳ Nobody has soaked anything, and no CSP/403 behaviour has been observed.
- ⛔ **ROLLBACK IS ONE LINE:** delete custom rule `47d54f121d6945419a6483d20f2b887a`
  under *Security → Security rules → Custom rules*. That restores the zone exactly,
  because it is the only thing that changed.
- ⛔ **Open, needs Izzy:** the proxy flip itself (after Phase B), the SSL Configuration
  Rule, whether to pre-emptively turn Browser Integrity Check off, whether
  `security_level` should drop to "Essentially Off" for the API, and whether
  `/agent-api/*` deserves its own skip rule (it was **not** added — only the three paths
  in scope were).
