# Loopcom Community — mobile (Expo)

The iPhone/iPad + Android app for Loopcom Community, the professional social
network. Talks only to `apps/community-api` (port 3101). Does not touch
`apps/mobile`, `apps/portal`, `apps/api`, or any other app in this monorepo.

## Run it locally

1. Start the api and Postgres per `docs/community/CONVENTIONS.md`:
   `pnpm --filter @loopcom/community-api dev` (listens on `:3101`).
2. From the repo root: `pnpm install` (the workspace already includes `apps/*`).
3. From `apps/community-mobile`:
   - **Android emulator**: `pnpm start` then press `a`, or `pnpm android`. The
     app's default api base URL is `http://10.0.2.2:3101` — the emulator's
     alias for the host machine's `localhost`.
   - **iOS simulator**: `pnpm start` then press `i`, or `pnpm ios`. Default api
     base URL is `http://localhost:3101` (the simulator shares the host's
     network namespace).
   - **A physical device**: set `EXPO_PUBLIC_API_BASE_URL` to your machine's
     LAN IP (e.g. `http://192.168.1.20:3101`) before starting Metro, since
     neither `10.0.2.2` nor `localhost` reaches your dev machine from a real
     phone.

The api base URL is read from `app.config.ts`'s `extra.apiUrl`, which comes
from `EXPO_PUBLIC_API_BASE_URL` (see `eas.json` for the preview/production
values). See `src/api/client.ts`.

## Deep links

Scheme: `loopcomcommunity://`. Universal/app links: `https://community.loopcom.net/...`.
Both resolve through the single table in `src/navigation/linking.ts` /
`src/navigation/deepLink.ts`:

| Path | Screen |
|---|---|
| `/people/:username` | Person profile |
| `/companies/:slug` | Company page |
| `/posts/:id` | Post detail |
| `/messages`, `/messages/:threadId` | Thread list / conversation |
| `/notifications` | Notifications |
| `/search` | Search |
| `/jobs/:id`, `/rfq/:id`, `/events/:slug`, `/groups/:slug`, `/opportunities/:id`, `/marketplace/:id` | Native detail screens (Jobs / RFQ / Events / Groups / Opportunities / Marketplace) |
| any other `/:kind/:id` | "Open on web" fallback (`ExternalLinkScreen`) |

A push notification's `href` field is resolved through the same table (see
`RootNavigator.tsx`'s notification-tap listener).

## Push notifications

`src/notifications/push.ts` requests permission, gets an Expo push token via
`expo-notifications`, and registers it with `POST /me/devices`. This needs an
EAS project ID (`app.config.ts`'s `extra.eas.projectId`, currently a
placeholder — set `EAS_PROJECT_ID_COMMUNITY` or update the file once a real
EAS project exists) and, for a **production build**, Apple Push
credentials (via `eas credentials`) and a Firebase project's
`google-services.json` for Android FCM. Until those exist, push registration
silently no-ops (denied permission and missing EAS config are both handled
without crashing — no feature assumes a token exists).

## What needs EAS credentials before a store build

- **iOS**: an Apple Developer Program membership + EAS-managed distribution
  certificate/provisioning profile (`eas build --platform ios`), and a real
  Sign in with Apple capability (already coded against
  `expo-apple-authentication`, but the entitlement needs the Apple account).
- **Android**: a Firebase project + `google-services.json` for push (FCM),
  and an EAS-managed (or your own) upload keystore.
- **Both**: real Google OAuth client IDs (`EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS` /
  `_ANDROID`) — the Google sign-in button only renders when these are set
  (see `src/auth/oauth.ts`'s `googleClientIdsConfigured()`).

## Tests

`pnpm test` (`node --import tsx --test "src/**/*.test.ts"`). Every suite is a
pure-logic test with **zero react-native/expo imports** — the same discipline
`apps/mobile` uses — because `react-native`'s own package cannot be
`require()`'d outside of Metro/Node's ESM loader used here only for
TypeScript transpilation, not RN's Flow-typed source:

- `src/api/client.test.ts` — the api core's refresh-and-retry-once-on-401
  behavior and `serializeRefresh`'s single-in-flight-refresh guarantee
  (against `src/api/apiCore.ts`, a native-import-free module `src/api/client.ts`
  wires up to the real fetch + SecureStore).
- `src/api/realtime.test.ts` — the reconnect backoff schedule (`src/api/backoff.ts`).
- `src/api/sse.test.ts` — the SSE wire-format frame parser (`src/api/sse.ts`):
  frame splitting across chunks, multi-line `data:`, comment/ping lines,
  CRLF normalization, and safe JSON decoding.
- `src/navigation/linking.test.ts` — every deep-link path (including the six
  "Find & sell" domains added in this pass) resolves to the right screen
  (`src/navigation/deepLink.ts`).
- `src/auth/policy.test.ts` — the biometric-lock gate and the
  access-token-never-persisted / refresh-token-only storage rule.
- `src/domain/quoteMath.test.ts` — the RFQ quote form's per-unit/total
  suggestion math (`src/domain/quoteMath.ts`).
- `src/domain/dynamicFields.test.ts` — the opportunity-type dynamic form
  engine (`src/domain/dynamicFields.ts`), whose `validateFields` mirrors
  `apps/community-api/src/opportunities/types.ts` sentence-for-sentence.

`npx tsc -p tsconfig.json --noEmit` is clean (0 errors).

## What could not be verified without a device/emulator

- The actual camera QR scan (`ScanScreen`), voice-note recording
  (`ConversationScreen`), and biometric prompt (`AuthProvider`'s `unlock()`)
  are written against real Expo APIs but unexercised — there's no
  device/emulator in this environment to drive them.
- Passkeys: there's no Expo API exposing platform passkey/WebAuthn ceremonies
  without a native module the app doesn't have, so no passkey UI was built
  (the web has one; the brief said not to fake it).
- Realtime now uses a real SSE connection (`react-native-sse`, see
  `src/api/realtime.ts`) instead of only polling, but it is unexercised
  against a live server here — there's no device/emulator/simulator in this
  environment to open a socket and watch events arrive. Falls back to the
  original polling if the library ever fails to construct a connection.
- The pinch-to-zoom/double-tap lightbox (`src/ui/Lightbox.tsx`, used by the
  feed's photo viewer and the marketplace listing gallery) is built on
  `react-native-gesture-handler` gestures driving plain RN `Animated` values
  (`react-native-reanimated` isn't installed — see the file's doc comment)
  but the gesture feel is unverified without a touchscreen.
- `expo-calendar`'s add-to-calendar flow (`EventDetailScreen`) is written
  against its documented API but unexercised — no device calendar to write
  to here; it falls back to sharing the event's `.ics` file when calendar
  permission is denied or the call throws.
- The new Jobs/RFQ/Events/Groups/Opportunities/Marketplace/CRM/Concierge/For
  you screens (`src/screens/{jobs,rfq,events,groups,opportunities,marketplace,crm,concierge,recommendations}`)
  are wired against the real api routes and typecheck cleanly, but no screen
  has been tapped through on a device/emulator — see
  `docs/community/parity.md` for exactly what's proven vs. not.
