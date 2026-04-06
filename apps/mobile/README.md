# Connect Mobile

Premium Android softphone app built with Expo SDK 51. Connects to the Connect Communications platform and VitalPBX telephony stack.

---

## Architecture

```
apps/mobile/
├── App.tsx                          # Root — provider stack
├── app.config.ts                    # Expo config (dynamic, EAS-aware)
├── eas.json                         # EAS Build profiles
├── src/
│   ├── api/client.ts                # All API calls (auth, provisioning, SIP, push, etc.)
│   ├── context/
│   │   ├── AuthContext.tsx          # JWT token + login/logout/QR session
│   │   ├── SipContext.tsx           # SIP registration + call state machine
│   │   ├── NotificationsContext.tsx # Push tokens + incoming call invites
│   │   ├── ThemeContext.tsx         # Dark/light/system theme with persistence
│   │   └── PresenceContext.tsx      # User presence/status management
│   ├── navigation/
│   │   ├── RootNavigator.tsx        # Auth vs App routing + call overlay logic
│   │   ├── TabNavigator.tsx         # Premium animated 7-tab bar
│   │   └── types.ts                 # Navigation param lists
│   ├── screens/
│   │   ├── auth/
│   │   │   ├── WelcomeScreen.tsx    # Animated onboarding splash
│   │   │   ├── LoginScreen.tsx      # Email/password sign-in
│   │   │   └── QrProvisionScreen.tsx# QR scanner + provisioning flow
│   │   ├── call/
│   │   │   ├── ActiveCallScreen.tsx # Premium in-call UI (mute/hold/DTMF/speaker)
│   │   │   └── IncomingCallScreen.tsx# Full-screen incoming call with pulse rings
│   │   ├── tabs/
│   │   │   ├── QuickActionTab.tsx   # Home hub: status, extension, quick actions
│   │   │   ├── TeamTab.tsx          # Team directory with live presence
│   │   │   ├── ContactTab.tsx       # Contact directory with favorites
│   │   │   ├── KeypadTab.tsx        # Premium DTMF dialpad
│   │   │   ├── RecentTab.tsx        # Call history with callbacks
│   │   │   ├── ChatTab.tsx          # Team chat thread list
│   │   │   └── VoicemailTab.tsx     # Voicemail player with waveform UI
│   │   ├── SettingsScreen.tsx       # Account, phone setup, preferences
│   │   └── DiagnosticsScreen.tsx    # SIP/WebRTC diagnostics + registration info
│   ├── components/
│   │   ├── ui/                      # Avatar, Badge, Button, Card, Chip, etc.
│   │   ├── call/                    # CallButton (animated), CallTimer
│   │   └── HeaderBar.tsx            # Consistent screen header
│   ├── sip/
│   │   ├── jssip.ts                 # JsSIP WebRTC SIP client
│   │   ├── simulated.ts             # Simulated SIP for dev/testing
│   │   ├── callkeep.ts              # react-native-callkeep integration
│   │   └── types.ts                 # SipClient interface
│   ├── theme/
│   │   ├── colors.ts                # Full dark + light color token system
│   │   ├── typography.ts            # Type scale (display → caption, mono, call timer)
│   │   └── spacing.ts               # Spacing scale, border radius, shadows
│   ├── hooks/
│   │   └── useCallTimer.ts          # Live call duration timer
│   └── types/index.ts               # Shared types (AuthResponse, VoiceExtension, etc.)
```

---

## Provisioning Flow

1. User scans QR code shown in the Connect portal (`QRPairingModal`)
2. QR payload: `{ type: "MOBILE_PROVISIONING", token, apiBaseUrl }`
3. **Not logged in:** `POST /auth/mobile-qr-exchange` → returns `sessionToken` + SIP bundle
4. **Logged in:** `POST /voice/mobile-provisioning/redeem` → returns SIP bundle
5. App saves `ProvisioningBundle` to `expo-secure-store` and registers with JsSIP
6. Token expires in 2 minutes — user can regenerate in portal

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EXPO_PUBLIC_API_BASE_URL` | Connect API base URL | `https://app.connectcomunications.com/api` |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | EAS project ID for push tokens | — |
| `EXPO_PUBLIC_VOICE_SIMULATE` | Use simulated SIP (no real calls) | `false` |
| `EXPO_PUBLIC_LOG_LEVEL` | Log verbosity (`debug`/`info`/`warn`) | `debug` |

---

## Development Build

### Prerequisites

```bash
# Install EAS CLI globally
npm install -g eas-cli

# Login to Expo
eas login
```

### First-time setup

```bash
cd apps/mobile
pnpm install
```

### Run on Android device/emulator

```bash
# Development build (requires Android Studio or physical device with USB debugging)
pnpm android

# Or via Expo Go (limited — no CallKeep or WebRTC)
pnpm start
```

---

## Building APK

### Dev APK (simulated SIP, debugging enabled)

```bash
eas build --platform android --profile dev
```

Output: APK downloadable from [expo.dev](https://expo.dev) dashboard or direct URL from CLI output.

### Preview APK (real SIP, internal distribution)

```bash
eas build --platform android --profile preview
```

### Production APK

```bash
eas build --platform android --profile production
```

> **EAS Project ID:** You will be prompted to provide your EAS project ID on first build. Run `eas init` to create one, then set `EXPO_PUBLIC_EAS_PROJECT_ID` in `.env` or EAS secrets.

### Local APK build (no EAS account needed)

```bash
# Requires Android Studio + NDK
npx expo run:android --variant release
```

APK output path: `android/app/build/outputs/apk/release/app-release.apk`

---

## Expo Limitations & How We Handle Them

| Limitation | Handling |
|------------|----------|
| No true VoIP background on Android | `react-native-callkeep` + foreground service for incoming calls |
| Push notifications require device (not simulator) | Graceful skip on non-device (`expo-device` check) |
| WebRTC requires native build (no Expo Go) | `expo-dev-client` for development builds |
| No simultaneous calls in JsSIP | Architecture ready for multi-call; first call wins |
| Background SIP registration dropped by OS | Re-register on `AppState` → `active` |
| QR token is 2-minute TTL | UI shows countdown; user can re-scan from portal |

---

## Production-Ready vs Placeholder

| Feature | Status |
|---------|--------|
| Auth (email/password) | ✅ Production |
| QR provisioning | ✅ Production |
| SIP registration | ✅ Production (JsSIP) |
| Outbound calls | ✅ Production |
| Inbound calls | ✅ Production (via push invite + CallKeep) |
| Mute / Hold / Speaker | ✅ Production |
| DTMF | ✅ Production |
| Dark mode / Light mode | ✅ Production |
| Call timer | ✅ Production |
| Push notifications | ✅ Production |
| Call history (via API) | ✅ Production |
| Team directory | 🔶 Demo data (API integration ready) |
| Contacts | 🔶 Demo data (wire to `/customers` API) |
| Chat | 🔶 UI shell (wire to messaging API) |
| Voicemail | 🔶 UI shell (wire to voicemail API/AMI) |
| Bluetooth audio routing | 🔶 Partial (CallKeep handles routing) |
| Transfer | 🔶 Placeholder buttons (architecture ready) |
| Call quality indicator | 🔶 Placeholder |
| Voicemail transcripts | 🔶 Placeholder UI |
