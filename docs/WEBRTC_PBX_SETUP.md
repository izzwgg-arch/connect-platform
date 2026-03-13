# WebRTC / PBX Setup Guide

This document covers everything required to make browser and mobile WebRTC calling work end-to-end with VitalPBX / Asterisk.

---

## 1. PJSIP WebSocket Transport

Add or verify this block in `/etc/asterisk/pjsip.conf` (VitalPBX stores PJSIP config there or in `/etc/asterisk/pjsip.d/`):

```ini
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0:8089
; TLS certificate — VitalPBX manages this automatically. If using a custom cert:
; cert_file=/etc/asterisk/keys/asterisk.crt
; privkey_file=/etc/asterisk/keys/asterisk.key
; ca_list_file=/etc/asterisk/keys/ca.crt

[transport-ws]
type=transport
protocol=ws
bind=0.0.0.0:8088
```

> **Default VitalPBX ports**: HTTP/WS on 8088, HTTPS/WSS on 8089.

The `sipWsUrl` to put in ConnectComms tenant settings:
```
wss://209.145.60.79:8089/ws
```
Replace `209.145.60.79` with your PBX IP or hostname (must have a valid TLS cert for production).

---

## 2. PJSIP Endpoint Template for WebRTC Clients

Each ConnectComms user extension needs WebRTC-compatible PJSIP settings. In VitalPBX this is configured via the GUI (Extensions → Edit → Advanced → WebRTC), but for reference the underlying PJSIP parameters are:

```ini
[6001]   ; replace with actual extension number
type=endpoint
transport=transport-wss
context=from-internal
disallow=all
allow=opus
allow=ulaw
allow=alaw
allow=g722
webrtc=yes                   ; enables DTLS-SRTP + ICE automatically
dtls_auto_generate_cert=yes  ; self-signed cert for DTLS media
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
ice_support=yes
auth=6001-auth
aors=6001-aor

[6001-auth]
type=auth
auth_type=userpass
username=6001
password=<sipPassword>       ; set by ConnectComms via VitalPBX API

[6001-aor]
type=aor
max_contacts=5               ; allow browser + mobile to both register
remove_existing=no
```

Enable ICE globally in `pjsip.conf`:

```ini
[global]
type=global
user_agent=VitalPBX
```

```ini
; In /etc/asterisk/rtp.conf
[general]
icesupport=yes
stunaddr=stun.l.google.com:19302
```

---

## 3. STUN Configuration

Edit `/etc/asterisk/rtp.conf`:

```ini
[general]
rtpstart=10000
rtpend=20000
icesupport=yes
stunaddr=stun.l.google.com:19302
```

Restart Asterisk to apply:
```bash
asterisk -rx "core restart now"
```

---

## 4. TURN Server (coturn) — Required for NAT traversal

Install coturn on the ConnectComms backend server (`45.14.194.179`):

```bash
apt-get update && apt-get install -y coturn

# Enable the coturn daemon
echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn
```

Edit `/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
external-ip=45.14.194.179    # public IP of this server
realm=connectcomunications.com
server-name=turn.connectcomunications.com
fingerprint
lt-cred-mech
user=connectcomms:YourStrongTurnPassword
log-file=/var/log/coturn/turnserver.log
simple-log
```

Start:
```bash
systemctl enable coturn && systemctl start coturn
```

Add to ConnectComms TURN config (Admin → Voice → TURN Settings):
```
TURN URL:      turn:45.14.194.179:3478
TURN Username: connectcomms
TURN Password: YourStrongTurnPassword
```

The provisioning bundle returned by `/voice/me/extension` and `/auth/mobile-qr-exchange` automatically includes the TURN server if configured.

---

## 5. Firewall Rules

On the **PBX server** (`209.145.60.79`):

```bash
# SIP WebSocket (browser/mobile signalling)
ufw allow 8088/tcp comment "Asterisk ARI + WS"
ufw allow 8089/tcp comment "Asterisk WSS"

# SIP/AMI
ufw allow 5060/udp comment "SIP"
ufw allow 5060/tcp comment "SIP"
ufw allow 5038/tcp comment "AMI (restrict to backend only)"

# RTP media
ufw allow 10000:20000/udp comment "RTP media"
```

On the **ConnectComms backend** (`45.14.194.179`) for coturn:

```bash
ufw allow 3478/tcp comment "TURN"
ufw allow 3478/udp comment "TURN"
ufw allow 5349/tcp comment "TURN TLS"
ufw allow 5349/udp comment "TURN TLS"
ufw allow 49152:65535/udp comment "coturn relay ports"
```

---

## 6. Codec Recommendations

| Codec  | Recommended? | Notes                            |
|--------|-------------|----------------------------------|
| opus   | ✅ First    | Best quality + bandwidth for WebRTC |
| ulaw   | ✅          | G.711 μ-law — US PSTN            |
| alaw   | ✅          | G.711 a-law — EU PSTN            |
| g722   | ✅          | HD voice for internal calls      |
| g729   | ❌          | License cost; not needed         |

---

## 7. ConnectComms Tenant Settings

In the Admin → PBX → Voice Config page, set:

| Setting          | Value                               |
|-----------------|-------------------------------------|
| SIP WS URL       | `wss://209.145.60.79:8089/ws`       |
| SIP Domain       | `209.145.60.79` (or FQDN)           |
| Outbound Proxy   | (leave blank unless using a SBC)    |
| STUN URL         | `stun:stun.l.google.com:19302`      |
| TURN URL         | `turn:45.14.194.179:3478`           |
| TURN Username    | `connectcomms`                      |
| TURN Password    | `YourStrongTurnPassword`            |

---

## 8. Verifying the Setup

```bash
# Confirm WSS port is open on PBX
curl -i --http1.1 -H "Upgrade: websocket" -H "Connection: Upgrade" \
  https://209.145.60.79:8089/ws --insecure

# Check Asterisk modules are loaded
asterisk -rx "module show like res_pjsip"
asterisk -rx "pjsip show transports"

# Confirm TURN server is reachable
turnutils_uclient -T 45.14.194.179 -u connectcomms -w YourStrongTurnPassword 45.14.194.179
```
