# WebRTC Live Repro Runbook — Relax Tires T25 / ext 101 / `T25_101_1`

> **Read-only diagnostics only.** No PBX config edits, no service restarts, no
> destructive commands. Companion to `WEBRTC_DIAGNOSTICS.md` and `TELEPHONY.md`.
>
> **Purpose:** During one controlled repro, capture the missing evidence that proves
> where registration traffic stops (client network vs PBX edge vs SIP auth vs Connect).
>
> **Status 2026-06-06:** ready for the next live repro. No Connect code/deploy change
> in the CRM rollout changes this WebRTC hypothesis; elevated PBX/root access is still
> required to prove fail2ban/firewall/log evidence.

---

## Root cause context (why this runbook exists)

Prior investigation **disproved** Connect-side drift:

| Hypothesis | Status |
|------------|--------|
| Tenant / extension / provisioning / credential drift | **Disproved** — no DB/audit changes before first failure |
| PBX endpoint misconfiguration | **Unlikely** — `T25_101_1` uses same WSS transport + WebRTC profile as working `T30_102_1` |
| DB password vs PBX auth | **Match confirmed** (`authT25_101_1`) |
| Shared WSS infra down | **Disproved** — Create A Box registered same day on same `sipWsUrl` |

**Still unproven (requires this repro):**

1. PBX security block — fail2ban / firewall / geo / rate-limit on client source IP
2. Client network path blocks outbound WSS to `:8089`
3. Client-specific TLS/WebSocket behavior (app vs browser)

**Earliest provable failure today:** no SIP REGISTER reaches Asterisk → traffic stops
**before** PJSIP Contact creation for `T25_101_1`.

---

## Scope and hard rules

### Do

- Collect timestamps in **UTC** (`date -u`) on every capture
- Use **elevated PBX/root SSH** for logs (not `pbx_audit@` — see `DEBUGGING.md`)
- Run **read-only** Asterisk CLI queries before and after repro
- Have the user perform repro on **Wi-Fi first**, then **cellular** if inconclusive
- Save raw command output to a dated file (paste into report template §7)

### Do not

- Edit `/etc/asterisk/*`, VitalPBX UI, nginx, firewall, or fail2ban rules
- `pm2 restart`, `docker compose restart`, `systemctl restart`, `asterisk -rx "core restart now"`
- `prisma migrate`, Connect deploys, or QR reprovision during the capture window
- Leave `pjsip set logger on` running after repro — **disable before closing session**
- Run unbounded `tcpdump` — only with human approval, filtered to user IP + port 8089, max 90 s

### Access tiers

| Account | Use for this runbook |
|---------|----------------------|
| `pbx_audit@209.145.60.79` | **Baseline only** — `pjsip show contacts`, `pjsip show endpoints` (no logs, no fail2ban) |
| **Elevated root/admin SSH** | **Required** — `/var/log/asterisk/full`, fail2ban, firewall, `ss`, optional tcpdump |

PBX host: `209.145.60.79` (port 22). WSS URL in app:
`wss://m.connectcomunications.com:8089/ws`

---

## 1. Pre-repro data to collect

Fill this table **before** starting PBX log tails. Operator confirms with user on a call
or chat.

| Field | Expected / known value |
|-------|------------------------|
| **User email** | `relaxtires@gmail.com` |
| **User ID** | `cmnmjhlu3004xp96hv4g49htg` |
| **Tenant** | Relax Tires |
| **Tenant ID** | `cmnlgryme000up9paz1w40fg0` |
| **PBX tenant code** | `T25` |
| **Extension** | `101` |
| **Extension ID** | `cmnmd7orq003tp9b023qj90vs` |
| **PbxExtensionLink ID** | `cmnmd7orv003vp9b0q1xx79bc` |
| **Expected endpoint** | `T25_101_1` |
| **Expected auth object** | `authT25_101_1` |
| **Expected SIP URI user** | `101_1` (JsSIP `uri`) |
| **Expected digest user** | `T25_101_1` (JsSIP `authorization_user`) |
| **Expected sipWsUrl** | `wss://m.connectcomunications.com:8089/ws` |
| **Expected sipDomain** | `m.connectcomunications.com` |
| **Device model** | _record at repro time_ (prior: Samsung SM-S938U) |
| **App version** | _record at repro time_ (prior: `1.0.0`) |
| **Network type** | `Wi-Fi` or `Cellular` (record carrier name if cellular) |
| **Public IP (phone)** | _user must supply — see §2_ |
| **Repro start (UTC)** | _fill at T0_ |
| **Operator timezone** | _fill_ |

**How user gets public IP (phone):**

- Wi-Fi/cellular browser → `https://ifconfig.me` or `https://ipinfo.io/ip`
- Or Settings → About phone → status (varies by OEM)

**Connect-side baseline (optional, from connect server):**

```bash
# Run inside app-api-1 — read-only DB snapshot
docker exec app-api-1 node /tmp/provisioning_audit.js   # if script present on server
```

Or query `VoiceClientSession` / `VoiceDiagEvent` for the new session after repro.

---

## 2. Phone-side reachability test

Perform **before** opening the Connect mobile app. Same network the app will use.

### Test A — HTTP (primary)

Open in the phone browser:

```
http://m.connectcomunications.com:8089/ws
```

| Result | Meaning |
|--------|---------|
| **`426 Upgrade Required`** (or page/body mentioning Upgrade Required) | TCP + HTTP to `:8089` **works** — port not blocked |
| **Connection timed out** | Likely **client/network/firewall blocks port 8089** |
| **Connection refused** | Nothing listening or wrong host/port (unlikely on prod) |
| **SSL/TLS error** | Expected on plain HTTP if server redirects — note exact message |

### Test B — HTTPS (optional)

```
https://m.connectcomunications.com:8089/ws
```

| Result | Meaning |
|--------|---------|
| **`426 Upgrade Required`** or cert warning then upgrade message | TLS to `:8089` **works** |
| **Certificate error** (user must not bypass unless instructed) | Record cert hostname mismatch — possible client trust issue |
| **Timeout** | TLS path blocked |

### Test C — DNS sanity (optional)

Note whether `m.connectcomunications.com` resolves to `209.145.60.79` from the phone
(use a DNS lookup app or `nslookup` on a laptop on same hotspot).

**Record:** screenshot or exact browser error text + public IP + network type.

---

## 3. PBX live logging commands (elevated access)

Open **three terminals** on the PBX (or one terminal + background jobs). Replace
`USER_IP` with the phone's public IP from §1.

### 3.1 Timestamps and listener state

```bash
date -u
ss -ltnp | grep 8089
ss -ltnp | grep 5060
```

Expected: Asterisk/http listening on `0.0.0.0:8089` (TLS/WSS).

### 3.2 Baseline — contacts and endpoint (before repro)

```bash
asterisk -rx 'pjsip show contacts' | grep -E 'T25_101|T30_102_1' || true
asterisk -rx 'pjsip show endpoints' | grep -A5 'T25_101_1' || true
asterisk -rx 'pjsip show endpoint T25_101_1'
asterisk -rx 'pjsip show aor T25_101_1'
asterisk -rx 'pjsip show auth authT25_101_1'
```

Save full output. **Expect:** `T25_101_1` with **no Contact** / Unavailable before repro.

### 3.3 Asterisk full log tail (primary evidence)

```bash
tail -f /var/log/asterisk/full
```

Look during repro for lines containing (case-insensitive):

- `USER_IP` (if known)
- `T25_101_1`, `101_1`, `authT25_101_1`
- `REGISTER`, `WS`, `WebSocket`, `8089`, `failed`, `ban`, `reject`, `401`, `403`, `408`

**Alternative if `tail -f` is too noisy:**

```bash
grep -E 'REGISTER|T25_101|101_1|WebSocket|8089|USER_IP' /var/log/asterisk/full | tail -200
```

(run again immediately after repro window)

### 3.4 PJSIP logger (temporary — disable after repro)

**Read-only effect on calls:** increases log volume only. **Must turn off after capture.**

```bash
# Enable (before user opens app)
asterisk -rx 'pjsip set logger on'

# ... run 60–90 s repro ...

# Disable (after capture — required)
asterisk -rx 'pjsip set logger off'
```

If your Asterisk build supports host-specific verbosity, prefer that over global logger —
only if documented on your build; otherwise use full logger briefly.

### 3.5 fail2ban

```bash
fail2ban-client status
fail2ban-client status asterisk
fail2ban-client status asterisk-iptables 2>/dev/null || true
```

Check if `USER_IP` appears in banned list:

```bash
fail2ban-client get asterisk banned 2>/dev/null || true
grep -r 'USER_IP' /var/log/fail2ban.log 2>/dev/null | tail -50
```

### 3.6 Firewall / drops

```bash
# iptables (if present)
iptables -L -n -v | head -80
iptables -L f2b-asterisk -n -v 2>/dev/null || true

# nftables (if present)
nft list ruleset 2>/dev/null | head -120

# recent kernel drops (may need root, read-only)
dmesg -T 2>/dev/null | grep -iE 'drop|reject|ban' | tail -30
journalctl -k --since '10 min ago' 2>/dev/null | grep -iE 'drop|reject' | tail -30
```

### 3.7 HTTP/TLS layer (optional)

```bash
journalctl -u asterisk --since '5 min ago' --no-pager 2>/dev/null | tail -100
# VitalPBX/nginx access logs if present (paths vary):
grep '8089' /var/log/nginx/access.log 2>/dev/null | tail -30
```

### 3.8 tcpdump (optional — human approval required)

Only if Tests A/B are inconclusive **and** operator approves. **Max 90 seconds.**

```bash
timeout 90 tcpdump -ni any host USER_IP and port 8089 -vv -c 200
```

Interpret: SYN → TLS ClientHello → no response = firewall drop; TLS completes but no
WebSocket upgrade = TLS/WSS issue; packets but no REGISTER in Asterisk log = app layer.

### 3.9 Connect server WSS probe (control — not the user's path)

From connect server (confirms infra, not client path):

```bash
docker exec app-api-1 node /tmp/test_ws.js   # if present; else curl/openssl s_client
curl -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  'https://m.connectcomunications.com:8089/ws' --max-time 10
```

Expect `101 Switching Protocols` or `426 Upgrade Required` from server-side.

---

## 4. Controlled repro procedure

**Roles:** Operator (PBX logs) + User (phone) + optional Connect admin (diag DB).

### Timeline

| Step | Who | Action |
|------|-----|--------|
| T−5 min | User | Complete §1 pre-repro table + §2 browser tests |
| T−2 min | Operator | Run §3.1–3.2 baseline; start `tail -f /var/log/asterisk/full` |
| T−1 min | Operator | `fail2ban-client status` + note banned IPs; optional `pjsip set logger on` |
| **T0** | User | **Force-close** Connect app (swipe away / Settings → force stop) |
| T0+5 s | User | **Reopen** Connect app; wait on home screen until SIP status shows (fail or register) |
| T0 → T+90 s | Operator | Capture logs continuously; note any new lines with USER_IP / REGISTER |
| T+90 s | Operator | `pjsip set logger off`; re-run §3.2 contact/endpoint snapshot |
| T+2 min | Operator | Re-run fail2ban + grep firewall logs for USER_IP |

### What to watch for in logs (in order)

1. **TCP connection** to `:8089` from USER_IP
2. **TLS handshake** complete
3. **WebSocket upgrade** (`Upgrade: websocket`, `101`)
4. **SIP REGISTER** for `101_1` or `T25_101_1`
5. **401 challenge** then **200 OK** (success) or **403/408/481** (failure)
6. **Contact** created — `pjsip show contacts` shows `T25_101_1/sip:...@USER_IP`

### Connect diag correlation (optional)

After repro, note new `VoiceClientSession.id` and first `SIP_REGISTER_FAILED` timestamp
from portal/admin diag if available. **Do not treat `WS_RECONNECT: failed` as a WebSocket
event** — it mirrors SIP registration failure (`WEBRTC_DIAGNOSTICS.md`).

---

## 5. Decision matrix

Use **phone browser result** + **PBX log evidence** together.

| Case | Phone browser `:8089` | PBX sees TCP/TLS to `:8089` | PBX sees WS upgrade | PBX sees SIP REGISTER | fail2ban / firewall | Conclusion |
|------|----------------------|----------------------------|--------------------|-----------------------|---------------------|------------|
| **A** | Timeout / refused | No | No | No | — | **Client/network blocks port 8089** (carrier, Wi-Fi, corporate firewall) |
| **B** | 426 OK | No connection from USER_IP during app repro | No | No | No ban | **App/client WSS stack or DNS/TLS differs from browser** — collect logcat / JsSIP close code |
| **C** | 426 OK | Yes | Yes | No | No ban | **WebSocket up but SIP REGISTER never sent or dropped** — JsSIP/config/timeout; check Asterisk for WS close |
| **D** | 426 OK | Yes | Yes | Yes, **401 then fail** or **403** | No ban | **Auth/credential mismatch at SIP layer** — compare digest username `T25_101_1` vs logged challenge |
| **E** | 426 or timeout | No or immediate reset | No | No | **USER_IP banned** or firewall drop | **PBX security block** — fail2ban / iptables / geo; root cause |
| **F** | 426 OK | Yes | Yes | Yes, **200 OK** + Contact created | No ban | **REGISTER succeeded on PBX** — if app still shows unregistered, **Connect/mobile state-sync bug** |

**Tie-breakers:**

- Browser fails but Create A Box user on same Wi-Fi works → still Case A for **this** device/network path
- Browser OK, no PBX traffic during app repro → Case B (compare app vs browser TLS/SNI/IPv6)
- REGISTER in log but no Contact → capture full REGISTER response code and `pjsip show endpoint`

---

## 6. Output template (paste results here)

```markdown
## WebRTC live repro report — Relax Tires T25 / 101 / T25_101_1

### Metadata
- Report date (UTC):
- Operator:
- User email: relaxtires@gmail.com
- Device model:
- App version:
- Network: Wi-Fi / Cellular (carrier: )
- Public IP (phone):
- Repro window UTC: T0 = ______ → T+90s = ______

### Phone browser tests
- http://m.connectcomunications.com:8089/ws → result:
- https://m.connectcomunications.com:8089/ws → result (optional):
- DNS m.connectcomunications.com → IP:

### PBX listener (ss -ltnp | grep 8089)
```
(paste)
```

### fail2ban
- `fail2ban-client status`:
- USER_IP in banned list? yes / no
```
(paste relevant lines)
```

### Firewall
```
(paste iptables/nft/dmesg if relevant)
```

### Asterisk contacts BEFORE
```
(paste pjsip show contacts | grep T25)
```

### Asterisk contacts AFTER
```
(paste pjsip show contacts | grep T25)
```

### Asterisk REGISTER / WSS log lines (proof)
```
(paste timestamped lines from /var/log/asterisk/full — include USER_IP, REGISTER, 401/200, WebSocket)
```

### Endpoint snapshot AFTER
```
(paste pjsip show endpoint T25_101_1)
```

### Connect VoiceDiag (optional)
- sessionId:
- First SIP_REGISTER_FAILED UTC:
- WS_CONNECTED seen? yes / no

### Decision matrix case: A / B / C / D / E / F

### Conclusion (one sentence)

### Recommended next step (no prod changes in this doc)
```

---

## 7. Hardening recommendations (documentation only — not implemented)

These close the gap so the next incident does not require a multi-hour forensic session:

| Priority | Recommendation | Rationale |
|----------|----------------|-----------|
| P0 | **Capture client IP** on `POST /voice/diag/session/start` and `/voice/diag/event` | Cannot correlate fail2ban without USER_IP today |
| P0 | **Separate diag events:** `SIP_SOCKET_CONNECTED`, `SIP_SOCKET_DISCONNECTED` (with WS close code), `SIP_REGISTER_FAILED` (with SIP status + cause) | Current `WS_RECONNECT: failed` mislabels SIP failure |
| P0 | **Fix `WS_RECONNECT` mislabel** in `NotificationsContext.tsx` | Stops false "WebSocket reconnect" narrative |
| P1 | **Admin "Why not registered?" panel** per extension | Last PBX contact, last diag REGISTER, last IP, last error code |
| P1 | **External WSS probe** (synthetic REGISTER from known IP) | Detect infra vs per-client failures |
| P2 | **PBX security-block summary** in Connect diagnostics (read-only job: fail2ban banned count + last ban time, no rule changes) | Surfaces Case E without SSH |

See `WEBRTC_DIAGNOSTICS.md` § Hardening for file references.

---

## Related docs and scripts

| Resource | Purpose |
|----------|---------|
| `docs/ai-context/WEBRTC_DIAGNOSTICS.md` | Incident forensics, entity IDs, prior evidence |
| `docs/ai-context/TELEPHONY.md` | Relax Tires incident summary |
| `docs/ai-context/DEBUGGING.md` | `pbx_audit@` limitations |
| `_tmp_diag/ami_getconfig_compare.js` | AMI endpoint diff T25 vs T30 (connect server) |
| `_tmp_diag/tenant_isolation_ip_hunt.js` | VoiceDiag tenant isolation queries |
| `_tmp_diag/ami_http_transport_audit.js` | WSS transport + http.conf snapshot |

---

## Quick reference — expected healthy vs failing

| Check | Healthy (e.g. T30_102_1) | T25 during incident |
|-------|---------------------------|---------------------|
| `pjsip show contacts` | `T30_102_1/sip:...@<ip>` Avail | **No `T25_*` WebRTC contact** |
| `pjsip show endpoint T25_101_1` | Contact line present after repro | Unavailable, 0 contacts |
| Mobile diag | `SIP_REGISTER` + `WS_CONNECTED` | `SIP_REGISTER_FAILED` only (~14 s after session start) |
| Browser `:8089/ws` | 426 Upgrade Required | _unknown until repro_ |

**Success criteria for this runbook:** One repro produces enough proof to assign Case A–F
with pasted log lines — not another round of provisioning checks.
