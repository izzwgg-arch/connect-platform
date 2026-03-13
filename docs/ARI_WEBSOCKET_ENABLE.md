# Enable ARI WebSocket on VitalPBX

The ConnectComms telephony service uses the Asterisk REST Interface (ARI) WebSocket for real-time call events and call control. This document shows exactly how to activate it.

---

## 1. Check current module status

```bash
asterisk -rx "module show like res_ari"
```

Expected output includes:
```
res_ari.so           ... Running
res_ari_applications.so
res_ari_asterisk.so
res_ari_bridges.so
res_ari_channels.so
res_ari_endpoints.so
res_ari_events.so         ← WebSocket events module
res_ari_recordings.so
res_ari_sounds.so
```

If `res_ari_events.so` is absent or `res_ari_websockets.so` is needed (older Asterisk builds), load it:

```bash
asterisk -rx "module load res_ari_websockets.so"
```

---

## 2. Permanent activation

Edit `/etc/asterisk/modules.conf`. Find the `[modules]` section and ensure:

```ini
[modules]
autoload=yes
; Add this line if the module is not auto-loading:
load => res_ari_websockets.so
```

On VitalPBX you can also use:
```bash
# VitalPBX stores custom Asterisk config in /etc/asterisk/
echo "load => res_ari_websockets.so" >> /etc/asterisk/modules.conf
asterisk -rx "module reload"
```

---

## 3. ARI HTTP configuration

Verify `/etc/asterisk/ari.conf`:

```ini
[general]
enabled = yes
pretty = no
allowed_origins = *

[connectcomms]
type = user
read_only = no
password = 8457823075Tty@
password_format = plain
```

> The ConnectComms backend uses `ARI_USERNAME=connectcomms` and `ARI_PASSWORD=<value>`.
> These are set in `/opt/connectcomms/env/.env.platform`.

---

## 4. Verify ARI is accessible

From the ConnectComms backend server:

```bash
# Basic health check
curl -u connectcomms:8457823075Tty@ http://209.145.60.79:8088/ari/asterisk/info

# WebSocket test (should upgrade to 101 Switching Protocols)
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" \
  "http://connectcomms:8457823075Tty@@209.145.60.79:8088/ari/events?app=connectcomms&subscribeAll=true"
```

Expected: `HTTP/1.1 101 Switching Protocols`

---

## 5. Telephony service env vars

Ensure these are set in `/opt/connectcomms/env/.env.platform`:

```env
ARI_BASE_URL=http://209.145.60.79:8088
ARI_USERNAME=connectcomms
ARI_PASSWORD=8457823075Tty@
ARI_APP_NAME=connectcomms
```

The telephony service (`app-telephony-1`) subscribes to the `connectcomms` Stasis application. Calls do **not** need to go through Stasis to be monitored — the AMI event feed handles live monitoring independently of ARI.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `404 Not Found` on `/ari/events` | `res_ari_events` not loaded | `asterisk -rx "module load res_ari_events.so"` |
| `401 Unauthorized` | Wrong credentials | Check `ari.conf` and `ARI_PASSWORD` env var |
| WebSocket closes immediately | ARI app name mismatch | Ensure `ARI_APP_NAME=connectcomms` matches `[connectcomms]` in `ari.conf` |
| `res_ari_websockets.so not found` | Asterisk version < 13.5 | Upgrade Asterisk; VitalPBX 4 ships a compatible version |
