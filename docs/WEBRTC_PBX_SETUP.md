# WebRTC / SIP over WSS — PBX Setup Guide

This guide documents all PBX-side changes required so that the ConnectComms browser softphone
and mobile app can register and make calls over SIP/WebRTC.

## Architecture context

```
Browser/Mobile  ──SIP/WSS :8089──▶  PBX (Asterisk/PJSIP)   ← media + signaling
Backend         ──AMI :5038────────▶  PBX (Asterisk)         ← events (primary)
Backend         ──ARI REST :8088──▶  PBX (Asterisk)         ← call-control actions
```

**ARI WebSocket is NOT used.** `res_ari_websockets.so` is not available on this VitalPBX
build. AMI is the sole event source. See [`ARI_WEBSOCKET_ENABLE.md`](./ARI_WEBSOCKET_ENABLE.md).

> **All commands below are run on the PBX server (209.145.60.79) as root or asterisk.**

---

## 1. PJSIP WebSocket (WSS) Transport

VitalPBX uses PJSIP. You need a WebSocket transport on port 8089 with TLS.

### 1.1 Verify existing transports

```bash
asterisk -rx "pjsip show transports"
```

Look for a transport with protocol `wss` or `ws`. If none exists, add one.

### 1.2 Add WSS transport (if missing)

Edit `/etc/asterisk/pjsip_custom.conf` (VitalPBX custom file — never edit generated files):

```ini
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
cert_file=/etc/asterisk/keys/asterisk.pem
priv_key_file=/etc/asterisk/keys/asterisk.key
; Self-signed cert is fine for internal networks; use Let's Encrypt for production
```

Then reload PJSIP:

```bash
asterisk -rx "pjsip reload"
```

> **TLS certificate**: VitalPBX can generate a self-signed cert:
> ```bash
> /usr/lib/asterisk/scripts/astgenkey -n asterisk
> cp /etc/asterisk/keys/asterisk.pem /etc/asterisk/keys/asterisk.key /etc/asterisk/keys/
> ```
> For production, use Let's Encrypt and point `cert_file`/`priv_key_file` to the chain.

---

## 2. PJSIP Endpoint Template for WebRTC Clients

Add a WebRTC-compatible endpoint template in `/etc/asterisk/pjsip_custom.conf`.
VitalPBX manages individual extensions via its GUI — use the template approach so GUI-created
extensions inherit WebRTC settings automatically.

```ini
[webrtc-endpoint-defaults](!)
type=endpoint
transport=transport-wss
context=from-internal
disallow=all
allow=opus
allow=ulaw
allow=alaw
allow=g722
webrtc=yes
; webrtc=yes is a shortcut that sets:
;   use_avpf=yes, media_encryption=dtls, dtls_verify=fingerprint,
;   dtls_setup=actpass, ice_support=yes, media_use_received_transport=yes

; NAT/ICE settings
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes

; Session timers — disable for WebRTC compatibility
timers=no

; DTMF
dtmf_mode=rfc4733
```

> In the VitalPBX GUI: edit the extension → Advanced → set "Transport" to `transport-wss`
> and enable "Force rport", "Rewrite contact". The `webrtc=yes` shorthand may be set under
> "Media Encryption".

---

## 3. STUN Configuration

Add a global STUN server reference in `/etc/asterisk/rtp.conf`:

```ini
[general]
stunaddr=stun.l.google.com:19302
; or use your own TURN server (see section 4)
```

Reload RTP:

```bash
asterisk -rx "module reload res_rtp_asterisk.so"
```

---

## 4. TURN Server (coturn) — Required for NAT traversal

WebRTC ICE negotiation fails behind strict or symmetric NAT without TURN.
coturn is installed on the **ConnectComms backend server (45.14.194.179)** —
the same host as the API.

> **Quick install**: `bash scripts/install-turn.sh` — run on the backend server
> as root. It installs coturn, writes `/etc/turnserver.conf`, opens firewall
> ports, and prints the credentials to add to `.env`.

### 4.1 Automated install

```bash
# On 45.14.194.179 as root:
cd /opt/connectcomms/app
bash scripts/install-turn.sh
# Copy the printed TURN_PASSWORD into /opt/connectcomms/app/.env
```

### 4.2 Manual install

```bash
apt-get update && apt-get install -y coturn openssl ssl-cert
# Enable the service
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

### 4.3 `/etc/turnserver.conf`

```ini
# ── Network ──────────────────────────────────────────────────────────────
listening-port=3478
tls-listening-port=5349
listening-ip=45.14.194.179
relay-ip=45.14.194.179
external-ip=45.14.194.179

# ── Authentication ────────────────────────────────────────────────────────
fingerprint
lt-cred-mech
realm=connectcomms.local
user=connectcomms:REPLACE_WITH_STRONG_PASSWORD

# ── Quotas ────────────────────────────────────────────────────────────────
total-quota=200
stale-nonce=600

# ── Security ─────────────────────────────────────────────────────────────
no-loopback-peers
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255

# ── Relay ports ───────────────────────────────────────────────────────────
min-port=49152
max-port=65535

# ── TLS (use Let's Encrypt in production) ─────────────────────────────────
cert=/etc/ssl/certs/ssl-cert-snakeoil.pem
pkey=/etc/ssl/private/ssl-cert-snakeoil.key

log-file=/var/log/turnserver.log
```

Generate a strong password:

```bash
openssl rand -hex 24
```

### 4.4 Start and enable

```bash
systemctl enable coturn
systemctl restart coturn
systemctl status coturn
```

### 4.5 Store credentials in ConnectComms API env

Add to `/opt/connectcomms/app/.env`:

```dotenv
TURN_SERVER=45.14.194.179
TURN_USERNAME=connectcomms
TURN_PASSWORD=<your-strong-password>
```

Then restart the API and worker containers:

```bash
cd /opt/connectcomms/app
docker compose -f docker-compose.app.yml up -d api worker
```

The provisioning endpoint (`GET /voice/me/extension`) will now return:

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:stun2.l.google.com:19302" },
    {
      "urls": "turn:45.14.194.179:3478",
      "username": "connectcomms",
      "credential": "<TURN_PASSWORD>"
    }
  ]
}
```

### 4.6 Verify TURN is working

Run the diagnostic script on the backend server:

```bash
bash scripts/test-turn.sh
```

Or test manually in a browser using the Google ICE Trickle test tool:
https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

Add your TURN server `turn:45.14.194.179:3478` with the credentials and confirm
**relay candidates** appear in the output.

### 4.7 TLS certificate for TURNS (port 5349)

For production, use Let's Encrypt:

```bash
certbot certonly --standalone -d app.connectcomunications.com
```

Then update `/etc/turnserver.conf`:

```ini
cert=/etc/letsencrypt/live/app.connectcomunications.com/fullchain.pem
pkey=/etc/letsencrypt/live/app.connectcomunications.com/privkey.pem
```

Add a cron job to restart coturn after renewal:

```bash
echo "0 3 * * 1 root systemctl restart coturn" > /etc/cron.d/coturn-certrenew
```

---

## 5. Firewall Rules

On the **PBX server** (209.145.60.79):

```bash
# SIP WebSocket (WSS)
ufw allow 8089/tcp comment "PJSIP WSS"

# SIP over UDP/TCP (standard)
ufw allow 5060/udp
ufw allow 5060/tcp

# RTP media (WebRTC uses this range)
ufw allow 10000:20000/udp comment "RTP media"
```

On the **coturn server** (45.14.194.179):

```bash
ufw allow 3478/udp   comment "TURN UDP"
ufw allow 3478/tcp   comment "TURN TCP"
ufw allow 5349/tcp   comment "TURN TLS"
ufw allow 49152:65535/udp comment "TURN relay ports"
```

---

## 6. Codec Notes

| Codec | Browser | Mobile | Quality  | Notes                              |
|-------|---------|--------|----------|------------------------------------|
| Opus  | Yes     | Yes    | Best     | Variable bit-rate, preferred       |
| G.722 | Yes     | Yes    | High     | HD voice fallback                  |
| ULAW  | Yes     | Yes    | Standard | G.711 µ-law, universally supported |
| ALAW  | Yes     | Yes    | Standard | G.711 A-law                        |

Set `disallow=all` then `allow=` in priority order in the PJSIP endpoint.

---

## 7. ConnectComms env values

Once the above is done, set these in `apps/api/.env` (or the secrets store):

```dotenv
SIP_WSS_URL=wss://209.145.60.79:8089/ws
SIP_DOMAIN=209.145.60.79
SIP_REALM=209.145.60.79
STUN_SERVER_URL=stun:stun.l.google.com:19302
TURN_SERVER_URL=turn:45.14.194.179:3478
TURN_USERNAME=connectcomms
TURN_PASSWORD=<your-turn-secret>
```

These are served to the browser and mobile via the `/voice/me/extension` endpoint inside the
`provisioning.iceServers` array and `provisioning.sipWsUrl`.

---

## 8. Verifying the setup

```bash
# From the ConnectComms backend server, check WSS port is reachable:
curl -sk https://209.145.60.79:8089/ws -o /dev/null -w "%{http_code}\n"
# Expect 400 or 101 (WebSocket upgrade attempted)

# Check STUN is answering:
# install stun-client: apt-get install -y stun-client
stunclient stun.l.google.com 19302

# Check TURN:
# use https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
# Add your TURN server and confirm relay candidates are gathered
```

---

## 9. Multiple devices per extension

ConnectComms supports one SIP username per user with multiple registered contacts
(one per device). The PJSIP `max_contacts` setting controls this:

```ini
; In the extension's AOR section (or global default):
[ext-1001](!)
type=aor
max_contacts=5
remove_existing=no
```

With `remove_existing=no`, the browser and mobile app can both be registered simultaneously,
and both will ring on incoming calls.

---

---

## 10. Troubleshooting

### No audio (call connects but silent)

| Symptom | Cause | Fix |
|---|---|---|
| ICE state stays `checking` | Strict NAT, no TURN | Install coturn, set `TURN_SERVER` env var |
| ICE state `failed` | TURN unreachable or wrong credentials | Run `scripts/test-turn.sh` |
| One-way audio | Asymmetric NAT or RTP port blocked | Ensure `rtp_symmetric=yes` on PBX endpoint; open RTP range `10000–20000/udp` on PBX firewall |
| Audio cuts after 30 s | PJSIP session timer mismatch | Set `timers=no` on WebRTC endpoint |

### One-way audio

1. Check Asterisk logs: `asterisk -rx "core show channels verbose"`
2. Confirm `rtp_symmetric=yes` and `force_rport=yes` on the PJSIP endpoint
3. Verify the PBX firewall allows UDP `10000–20000` from the backend server

### ICE failure

Check the browser console for ICE errors. Common causes:

- **No relay candidates gathered** — TURN is not configured or unreachable
  - Verify `TURN_SERVER`, `TURN_USERNAME`, `TURN_PASSWORD` are set in API env
  - Verify coturn is running: `systemctl status coturn`
  - Verify port 3478 UDP/TCP is open: `nc -zuv 45.14.194.179 3478`

- **Authentication failure** — wrong TURN username/password
  - The password in `/etc/turnserver.conf` `user=` line must match `TURN_PASSWORD` env var exactly

- **`certificate is not valid` in coturn logs** — TLS cert issue
  - For dev: use `no-tls` flag or snakeoil cert
  - For prod: use Let's Encrypt cert (see section 4.7)

- **Relay candidates gathered but audio still fails** — coturn relay port range blocked
  - Ensure UDP `49152–65535` is open on the backend server firewall

### Registration fails (SIP 403 or timeout)

1. Check the WSS URL in the browser diagnostics panel — must be `wss://209.145.60.79:8089/ws`
2. Verify the extension exists in VitalPBX and has a SIP password set
3. Check `PJSIP_WSS` transport: `asterisk -rx "pjsip show transport transport-wss"`
4. Check TLS cert on PBX: the browser will reject a self-signed cert unless the user has accepted it
   - Workaround: visit `https://209.145.60.79:8089` in browser first and click "Accept certificate"

### SIP 488 / codec negotiation failure

- Ensure the PBX endpoint has `allow=opus` — WebRTC mandates Opus
- Set `disallow=all` before `allow=` lines in PJSIP endpoint config

### TURN server consuming too much CPU/memory

- Reduce `total-quota` in `/etc/turnserver.conf`
- Monitor: `journalctl -u coturn -f`
- Check active allocations: coturn does not have a built-in dashboard; check logs

---

## See also

- [`ARI_WEBSOCKET_ENABLE.md`](./ARI_WEBSOCKET_ENABLE.md) — ARI REST-only integration details (WebSocket not available)
- [`GO_LIVE_CHECKLIST.md`](./GO_LIVE_CHECKLIST.md) — full pre-launch verification checklist
- VitalPBX PJSIP documentation: https://wiki.vitalpbx.org
- coturn documentation: https://github.com/coturn/coturn/wiki/turnserver
