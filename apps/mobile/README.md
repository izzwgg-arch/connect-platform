# Connect Mobile Softphone (Expo)

This app is located at `apps/mobile` and provides mobile softphone capability for Connect Communications tenants.

## Features

- Login via existing API auth endpoint
- Fetch extension metadata via `GET /voice/me/extension`
- QR onboarding from portal provisioning payload
- Secure credential storage via Expo SecureStore
- SIP registration/dial/answer/hangup/mute/speaker/DTMF
- Call history via `GET /voice/calls`
- Simulated mode (`EXPO_PUBLIC_VOICE_SIMULATE=true`) for non-PBX testing

## Requirements

- Node 20+
- Expo CLI tooling
- PBX supports SIP over WebSocket (WSS)
- ICE servers configured (STUN/TURN)
- For real SIP in React Native: custom dev client build is typically required for `react-native-webrtc`

## Environment variables

Create `apps/mobile/.env` (local only):

```env
EXPO_PUBLIC_API_BASE_URL=https://app.connectcomunications.com/api
EXPO_PUBLIC_VOICE_SIMULATE=true
```

Set `EXPO_PUBLIC_VOICE_SIMULATE=false` for real PBX registration tests.

## Run

From monorepo root:

```bash
pnpm mobile:start
pnpm mobile:android
pnpm mobile:ios
```

## Onboarding flow

1. Sign in.
2. Open **Provision Phone (QR)**.
3. Scan portal QR bundle containing `sipUsername`, one-time `sipPassword`, `sipWsUrl`, `sipDomain`, `iceServers`, `dtmfMode`.
4. Credentials are written to SecureStore (`cc_mobile_provision`) and not written to AsyncStorage.
5. Register SIP and place test calls.

## Dev test plan

### Simulated

- Set `EXPO_PUBLIC_VOICE_SIMULATE=true`.
- Provision with QR or reset endpoint.
- Register, dial, answer, hangup transitions should move through states.

### PBX real

- Set `EXPO_PUBLIC_VOICE_SIMULATE=false`.
- Ensure PBX WSS endpoint reachable from mobile network.
- Verify ICE negotiation with configured TURN/STUN.
- Validate inbound/outbound calls and DTMF.

## Security notes

- SIP secrets are never persisted in AsyncStorage.
- Credentials are removed on logout.
- Avoid console logging provisioning payloads.
- Portal one-time QR payload should be treated as sensitive and short-lived.

## Known limitations

- No push notifications for incoming calls yet.
- Speaker route behavior may require extra native audio routing package tuning per platform.
- Background call reliability is limited until push/CallKit/ConnectionService integration phase.
