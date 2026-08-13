# ARI Integration — REST-Only Architecture

> **CONFIRMED:** `res_ari_websockets.so` does **not** exist on this VitalPBX/Asterisk build.
> ARI WebSocket is therefore **not used**. This is a deliberate architectural decision.
> Do not attempt to enable it unless you rebuild Asterisk with the websockets module.

## How the system actually works

```
PBX (Asterisk 209.145.60.79)
  ├── AMI  :5038  ──TCP──▶  ConnectComms backend  (events, state, monitoring)
  ├── ARI  :8088  ──HTTP──▶  ConnectComms backend  (REST call-control actions only)
  └── PJSIP :8089 ──WSS──▶  Browser / Mobile       (SIP registration + media)
```

**AMI is the canonical live-event source.** All call state, extension presence, and queue
state arrives via AMI. The `TelephonyService` parses AMI frames and updates in-memory stores
which are broadcast over WebSocket to connected dashboard clients.

**ARI REST** is used only for call-control actions:
- `DELETE /ari/channels/{id}` — hang up a channel
- `POST /ari/channels` — originate a call
- `POST /ari/bridges` — create a mixing bridge
- `POST /ari/bridges/{id}/addChannel` / `removeChannel`

**ARI WebSocket (`/ari/events`)** is NOT used. The `AriClient` performs a periodic REST
health probe against `/ari/asterisk/info` to confirm ARI is reachable, but does not open
a WebSocket connection.

---

## Verifying ARI REST works

From the ConnectComms backend server (45.14.194.179):

```bash
# Should return JSON with asterisk info
curl -su connectcomms:8457823075Tty@ http://209.145.60.79:8088/ari/asterisk/info | python3 -m json.tool

# List active channels
curl -su connectcomms:8457823075Tty@ http://209.145.60.79:8088/ari/channels | python3 -m json.tool
```

---

## Health endpoint

```bash
curl http://45.14.194.179:3003/health
```

Expected shape:

```json
{
  "status": "ok",
  "ami": {
    "connected": true,
    "lastEventAt": "2026-03-09T...",
    "lastError": null
  },
  "ari": {
    "restHealthy": true,
    "webSocketSupported": false,
    "lastCheckAt": "2026-03-09T...",
    "lastError": null
  },
  "activeCalls": 0,
  "pbxHost": "209.145.60.79"
}
```

`ari.webSocketSupported` is always `false` by design. This is not an error.

---

## If you ever need ARI WebSocket in the future

ARI WebSocket would require Asterisk to be built with `--with-httpd` and the
`res_ari_websockets` module compiled in. On VitalPBX this is not available without
rebuilding Asterisk from source or switching to a full-featured Asterisk package.

Since AMI provides all necessary event data, there is no functional reason to add ARI
WebSocket support at this time.

---

## See also

- [`WEBRTC_PBX_SETUP.md`](./WEBRTC_PBX_SETUP.md) — SIP/WebRTC transport and STUN/TURN setup
