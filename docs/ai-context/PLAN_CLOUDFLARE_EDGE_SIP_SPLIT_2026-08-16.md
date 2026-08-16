# PLAN — put Connect behind Cloudflare, and the SIP split-out that has to happen first

Status: **PLAN ONLY. Nothing in here has been executed.** Written 2026-08-16 at Izzy's
request. Every step below is reversible and each carries its own rollback.

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

### Phase B — move the clients (the customer-visible step)

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
