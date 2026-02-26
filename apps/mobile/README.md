# Connect Mobile Softphone (Expo)

Location: `apps/mobile`

This app supports QR onboarding, secure SIP credential storage, incoming call actions, and production EAS build profiles.

## EAS Build Profiles

Configured in `apps/mobile/eas.json`:

- `dev` - development client/internal distribution
- `preview` - internal testing build
- `production` - production release build

### Commands

From repo root:

```bash
pnpm mobile:start
```

From `apps/mobile`:

```bash
npx eas login
npx eas init
npx eas build --profile dev --platform ios
npx eas build --profile dev --platform android
npx eas build --profile preview --platform ios
npx eas build --profile preview --platform android
npx eas build --profile production --platform ios
npx eas build --profile production --platform android
```

## Environment

Required mobile env variables:

```bash
EXPO_PUBLIC_API_BASE_URL=https://app.connectcomunications.com/api
EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_ID
EXPO_PUBLIC_VOICE_SIMULATE=false
EXPO_PUBLIC_LOG_LEVEL=info
```

### Production safety locks

- `EXPO_PUBLIC_VOICE_SIMULATE` is forcibly disabled for `production` profile.
- Logging defaults to reduced level (`warn`) in production profile.

## QR Provisioning Security

Default flow is tokenized (no SIP secret inside QR):

1. Portal requests `POST /voice/mobile-provisioning/token`
2. QR contains `{ type: "MOBILE_PROVISIONING", token, apiBaseUrl }`
3. Mobile redeems token via `POST /voice/mobile-provisioning/redeem`
4. API returns one-time SIP password once and token becomes used

### Legacy compatibility (grace release)

Legacy QR payloads containing plaintext `sipPassword` are still accepted for one release, but mobile shows a warning to migrate.

## Security notes

- SIP passwords are not stored in AsyncStorage
- Provisioning secrets are stored in SecureStore only
- Provisioning tokens are short-lived and single-use
- No SIP passwords are logged
