# Connect Mobile Softphone (Expo + EAS Dev Client)

Location: pps/mobile

This app adds mobile softphone support with QR provisioning, secure credentials, push token registration, and incoming call scaffolding with native call UI integration hooks.

## Capabilities in v1.3.1

- Auth with existing API (POST /auth/login)
- Device push token registration (POST /mobile/devices/register)
- QR onboarding from portal one-time provisioning payload
- Secure SIP credential storage via expo-secure-store only
- SIP registration and call controls (dial/answer/hangup/mute/speaker toggle/DTMF)
- Incoming call handling scaffold:
  - Push payload consume (	ype: INCOMING_CALL)
  - Native incoming UI bridge via eact-native-callkeep (CallKit/ConnectionService abstraction)
  - Fallback in-app IncomingCall screen
- Call history (GET /voice/calls)

## Required environment variables

Create local file pps/mobile/.env:

`env
EXPO_PUBLIC_API_BASE_URL=https://app.connectcomunications.com/api
EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_ID
EXPO_PUBLIC_VOICE_SIMULATE=true
`

Set EXPO_PUBLIC_VOICE_SIMULATE=false for real SIP tests.

## EAS dev client setup

From monorepo root:

`ash
pnpm mobile:start
`

Create EAS project once:

`ash
cd apps/mobile
npx eas login
npx eas init
`

Build dev client:

`ash
npx eas build --profile development --platform ios
npx eas build --profile development --platform android
`

Install dev client on device, then run:

`ash
pnpm mobile:start
`

## PBX requirements

- SIP over WebSocket (WSS)
- SIP domain/realm
- ICE servers (STUN/TURN) reachable from device
- Credentials provisioned from backend one-time reset payload

## Security

- SIP password is never written to AsyncStorage
- Provisioning secrets are stored in SecureStore only
- Credentials are removed on logout flow
- Push payload contains invite metadata only (no SIP secrets)

## Simulated vs production-ready

### Simulated

- EXPO_PUBLIC_VOICE_SIMULATE=true enables simulated call state transitions.
- API can generate simulated incoming invites via POST /mobile/call-invites/test.
- API push send can run in simulated mode using MOBILE_PUSH_SIMULATE=true.

### Production-ready scaffolding

- Device push token registration endpoints
- Invite lifecycle with expiry and response APIs
- Native call UI abstraction points via CallKeep

### Remaining hardening

- VoIP push token path for iOS APNs VoIP channel
- Android foreground service tuning + OEM behavior testing
- Push-to-answer deep link to in-call state transitions on all device states
- PBX real event source wiring to create invites from live inbound calls

## Known limitations

- No push-notification-backed background media session reliability guarantees yet
- CallKeep integration is scaffolded; platform-specific entitlements/config still required for full store release
- No push notifications for voicemail/chat yet
