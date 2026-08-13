# ConnectComms WebRTC Phone — Go-Live Checklist

Work through this list in order. Each section depends on the previous one working.

---

## 0. Confirmed facts (do not re-test these)

- [x] PBX host: 209.145.60.79
- [x] AMI on port 5038 — working
- [x] AMI username: `connectcommsgefenu`
- [x] ARI REST on port 8088 — working (`/ari/asterisk/info` returns JSON)
- [x] WSS transport active on port 8089 (confirmed in Asterisk HTTP status)
- [x] `/ws` path exists on port 8089
- [x] ARI WebSocket NOT available (res_ari_websockets.so absent — NOT REQUIRED)

---

## 1. Environment variables (do this first)

Set these on the ConnectComms **API server** (`apps/api/.env` or secrets manager):

```bash
PBX_WS_ENDPOINT=wss://209.145.60.79:8089/ws
# Already in .env.example — confirm it is set on the running server
```

Test it is applied:
```bash
curl -s http://45.14.194.179:3001/voice/webrtc/health \
  -H "Authorization: Bearer <your-jwt>" | python3 -m json.tool
```

Expected response includes:
```json
{
  "sipWssConfigured": true,
  "sipWssUrl": "wss://209.145.60.79:8089/ws",
  "sipDomainConfigured": true,
  ...
  "missingConfig": []
}
```

If `sipWssConfigured` is false, `PBX_WS_ENDPOINT` is not reaching the code.
If `sipDomainConfigured` is false, the tenant needs `sipDomain` set in the DB (Voice → Settings → WebRTC).

---

## 2. Tenant WebRTC settings in the portal

1. Log into the portal as admin
2. Go to **Voice → Settings → WebRTC**
3. Confirm:
   - **WebRTC enabled**: checked
   - **SIP WSS URL**: `wss://209.145.60.79:8089/ws` (or leave blank to use env fallback)
   - **SIP Domain**: `209.145.60.79`
4. Click Save
5. Re-run the `/voice/webrtc/health` check above — `missingConfig` should be empty

---

## 3. Firewall verification

From the **browser machine** (or use an online WebSocket tester):

```bash
# TCP reachability of WSS port
curl -sv --http1.1 \
  -H "Upgrade: websocket" -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://209.145.60.79:8089/ws 2>&1 | grep -E "101|< HTTP|error"
# Expect: "< HTTP/1.1 101 Switching Protocols" or a SIP response (not a timeout or connection refused)
```

Also confirm RTP ports are open on the PBX:
```bash
# On PBX server:
iptables -L -n | grep -E "1000[0-9]|2000[0-9]"
# Expect UDP 10000-20000 to be ACCEPT or unblocked
```

---

## 4. Extension assignment

1. In the portal admin, go to **Voice → Extensions**
2. Confirm your test user has an extension assigned
3. `GET /voice/me/extension` for that user should return `extensionNumber`, `sipUsername`, `sipWsUrl`, `sipDomain`
4. `hasSipPassword` may be `false` on first use — that is fine; the browser phone calls `POST /voice/me/reset-sip-password` automatically

---

## 5. Browser WebRTC registration test

1. Open the portal → **Voice → Phone Console**
2. Allow microphone permission when prompted
3. Watch the **Registration** status chip:
   - `Connecting…` → WS connection initiated
   - `Registering…` → SIP REGISTER sent
   - `Registered ✓` → success
4. Open the diagnostics panel ("Show details") and confirm:
   - `SIP WSS URL`: shows `wss://209.145.60.79:8089/ws`
   - `SIP Domain`: shows `209.145.60.79`
   - `WebRTC enabled`: Yes
   - `Microphone`: granted

### If registration fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connecting…` never advances | WSS port 8089 unreachable from browser | Firewall — open 8089 TCP to the internet |
| `Registration failed (401)` | Wrong SIP password | Try refreshing the page (resets the password) |
| `Registration failed (403)` | Extension suspended or SIP account locked | Check extension status in VitalPBX GUI |
| `Registration failed: Connection Error` | WSS cert not trusted | Use a valid TLS cert; for self-signed, add CA to browser trust store |
| `SIP WSS URL is not configured` | `PBX_WS_ENDPOINT` env var not set | Set it on the API server and restart |

---

## 6. Browser outbound call test

1. Confirm registration shows `Registered ✓`
2. Enter a known extension number (e.g., a desk phone or another browser tab registered as a different extension)
3. Click **Call**
4. Watch **ICE status** in the diagnostics panel:
   - `checking` → ICE negotiation in progress
   - `connected` → media path established ✓
5. Confirm two-way audio

### If audio is one-way or absent

| Symptom | Likely cause | Fix |
|---|---|---|
| ICE state: `failed` | No TURN server, strict NAT | Install coturn on 45.14.194.179 (see `WEBRTC_PBX_SETUP.md` §4) |
| ICE state: `connected` but no audio | Codec mismatch | Check Asterisk endpoint allows opus/ulaw; check RTP port range is open (10000-20000 UDP) |
| Call connects (ICE ok) but one-way audio | NAT/RTP asymmetry | Set `rtp_symmetric=yes` and `force_rport=yes` in PJSIP endpoint |

---

## 7. Browser inbound call test

1. Ensure browser phone is `Registered ✓`
2. From a desk phone or the PBX CLI, call the extension number assigned to the browser user:
   ```bash
   # From Asterisk CLI:
   asterisk -rx "channel originate SIP/your-extension application Playback demo-congrats"
   ```
3. The browser phone should show `Ringing…` and an **Answer** button
4. Click Answer → confirm two-way audio

---

## 8. QR mobile link test

1. Log into the portal as the user
2. Go to **Voice → Provisioning**
3. Click **Pair Mobile App** — a QR code should appear with a 2-minute countdown
4. Open the ConnectComms mobile app on a phone
5. If not logged in, tap **Scan QR Code to Link Device** on the login screen
6. Point the camera at the QR code
7. The app should:
   - Exchange the token with the backend
   - Store a session JWT
   - Store the SIP provisioning bundle
   - Navigate to the Home screen
8. On the Home screen tap **Diagnostics** and verify:
   - Session linked: Yes
   - SIP WSS URL: correct
   - SIP Domain: correct

---

## 9. Mobile registration test

1. On the mobile Home screen, tap **Register** (or it auto-registers if provisioned)
2. Check **Diagnostics** → Registration State: `registered`
3. If registration fails, check the same checklist as browser registration (§5 above)

---

## 10. Mobile outbound call test

1. Confirm mobile registration is `registered`
2. Navigate to **Dialpad**
3. Enter an extension and tap **Dial**
4. Confirm the call connects and audio is two-way

---

## 11. Mobile inbound call test (foreground only)

1. Ensure mobile app is in the foreground and `registered`
2. Call the mobile user's extension from another phone/browser
3. The app should navigate to or show the **Incoming Call** screen
4. Tap **Accept** → confirm two-way audio

> **Background calling limitation**: Background/lock-screen incoming calls require native
> platform work not yet completed (iOS CallKit + PushKit VoIP push, Android ConnectionService
> + FCM data push). See `apps/mobile/src/screens/DiagnosticsScreen.tsx` for exact steps.

---

## 12. Dashboard event verification

1. While a call is active, open the portal **Telephony Status** page
   (`/dashboard/admin/pbx/telephony-status`)
2. Confirm:
   - AMI: Connected
   - Active Calls: count > 0
   - The call appears in the Active Calls table

---

## Remaining blockers (if any)

After completing the checklist, the only remaining open items should be:

1. **TLS certificate**: If using a self-signed cert on port 8089, browsers will refuse the WSS
   connection. Use Let's Encrypt or add the CA to the browser trust store.
2. **TURN server**: If behind strict NAT, audio will fail. Install coturn (see
   `docs/WEBRTC_PBX_SETUP.md` §4).
3. **Mobile background calling**: Requires ejecting to bare React Native + CallKit + PushKit.
   Foreground calling works now.
