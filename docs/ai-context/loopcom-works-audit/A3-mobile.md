# A3 — TrimPro Field mobile app audit (pre-rebrand to "LoopCom Works")

Read-only audit. No files were modified, created, moved or deleted inside the repository
during this audit (this report file is the sole write, and it is outside the repo).

Root inspected: `C:\dev\projects\Connect 2\Loopcom works\`

## Which path is the real mobile project

**`apps/mobile/` is the real, actively-built mobile app.** `mobile-app/` at the repo root
is an untouched `npx create-expo-app` scaffold (default `App.tsx` text "Open up App.tsx to
start working on your app!", `name`/`slug` = `"mobile-app"`, only 4 dependencies: `expo`,
`expo-status-bar`, `react`, `react-native`). It is dead weight, not a second product.

Evidence `apps/mobile` is canonical:
- Root `.easignore` explicitly whitelists it: `!apps/mobile/**` (and nothing whitelists
  `mobile-app/`).
- Root `app.json` is a stub: `{ "expo": {} }`. Root `eas.json` has generic build profiles
  with no project identity (no `extra.eas.projectId`, no app name/bundle id) — it is not
  wired to any registered EAS project.
- `apps/mobile/app.json` carries the real identity: name "TrimPro Field", slug
  `trimpro-field`, a live `extra.eas.projectId`, real bundle/package ids, permissions,
  plugins, a `google-services.json`, three `.jks` keystores, `credentials.json`,
  `BUILDING.md` / `DEPLOYING.md` / `ENVIRONMENT.md` / `BACKEND_ENDPOINT_AUDIT.md`, a
  36-file `src/` tree, and a `dist/` folder from a real EAS Update export.
- The current git branch (`loopcom`, remote `origin` = `https://github.com/izzwgg-arch/Trimpro.git`)
  and this "Loopcom works" tree's own `CLAUDE.md` independently describe the product as
  "Loopcom App (formerly Trim Pro)" being reskinned to match the Loopcom Customer Portal —
  consistent with `apps/mobile` being the one real app.

**All findings below are about `apps/mobile/`.** `mobile-app/` is noted once more under
"Out of scope, noticed" and otherwise ignored.

---

## 1. Framework & config

- **Expo SDK**: `~54.0.33` (package.json `"expo"`).
- **React Native**: `0.81.5`. **React**: `19.1.0`. **New Architecture**: enabled
  (`newArchEnabled: true` in app.json).
- **TypeScript**: yes, `~5.9.2` (devDependency), `tsconfig.json` present (extends Expo's
  base config, 85 bytes).
- **Config file**: `app.json` only (no `app.config.js`/`.ts` — static config, no
  environment-branching config logic).
- **Navigation**: `@react-navigation` (native-stack, bottom-tabs, drawer) — NOT
  `expo-router`. Structure: one `Drawer.Navigator` (`RootDrawerParamList`) wrapping one
  `MainTabs` bottom-tab navigator (`RootMainTabParamList`, 5 tabs), each tab wrapping its
  own native-stack (`JobsStackParamList`, `ScheduleStackParamList`, `TasksStackParamList`,
  `MessagesStackParamList`, `IssuesStackParamList`). Plus a separate un-nested
  `AuthStack` for the logged-out state. Defined in
  `apps/mobile/src/navigation/RootNavigator.tsx`.
- **State management**: no Redux/Zustand/MobX. Server state via `@tanstack/react-query`
  (`^5.90.21`); app state via plain React Context (`AuthContext`, `BrandingContext`).
- **Storage**: `expo-secure-store` (`~15.0.8`) for auth tokens/user/device id
  (`apps/mobile/src/auth/secure-storage.ts`); `@react-native-async-storage/async-storage`
  (`2.2.0`) for the cached branding config and (presumably) other local caches
  (`apps/mobile/src/branding/BrandingContext.tsx`, `apps/mobile/src/offline/outbox.ts`,
  `apps/mobile/src/drafts/storage.ts`).
- **Push**: `expo-notifications` (`~0.32.16`) + Firebase Cloud Messaging via
  `google-services.json` (Android). Registration logic in
  `apps/mobile/src/notifications/registerPush.ts`; deep-link-on-tap handling in
  `apps/mobile/src/notifications/openFromNotification.ts`.
- **Maps**: none. No `react-native-maps` or similar in `package.json`.
- **Camera**: `expo-camera` (`~17.0.10`), `expo-image-picker` (`~17.0.10`),
  `expo-video-thumbnails` (`~10.0.8`).
- **Location**: `expo-location` (`~19.0.8`) — used for an "optional location ping"
  (`POST /api/mobile/location` per `BACKEND_ENDPOINT_AUDIT.md`).
- **Deep links**: `expo-linking` + custom schemes `trimprofield://` and `trimpro://`
  (both declared, see §3/§4), wired through React Navigation's `linking` prop in
  `RootNavigator.tsx` (`baseLinking`, lines ~70–125). Also Android Share-Sheet ingestion
  via `expo-share-intent` (configured in `app.json` plugins) plus a custom config plugin
  `plugins/withAndroidViewerQueries.js` (VIEW/SEND intent queries for opening files in
  other apps). A second, now-superseded custom plugin `plugins/withAndroidShareIntent.js`
  exists on disk but is **not** referenced in `app.json`'s `plugins` array — dead code,
  its own header comment says it was superseded by `expo-share-intent`.

### `app.json` (apps/mobile/app.json) — key fields

| Field | Value |
|---|---|
| `expo.name` | `TrimPro Field` |
| `expo.slug` | `trimpro-field` |
| `expo.scheme` | `["trimprofield", "trimpro"]` |
| `expo.version` | `1.0.18` |
| `expo.runtimeVersion.policy` | `appVersion` |
| `expo.updates.url` | `https://u.expo.dev/5d6344e3-86ce-4e96-93e8-13893313d47f` |
| `expo.updates.enabled` | `false` (OTA disabled at the app-level flag, though `scripts/publish-ota.mjs` still publishes updates — see §7/risk notes) |
| `expo.icon` | `./assets/icon.png` (1024×1024) |
| `expo.splash.image` | `./assets/splash-icon.png` (1024×1024), `backgroundColor: #2E4A59` |
| `expo.ios.bundleIdentifier` | `com.trimpro.field` |
| `expo.ios.buildNumber` | `3` |
| `expo.ios.infoPlist.*UsageDescription` | 4 strings, all say **"TrimPro Field"** (camera, photo library, microphone, location — see §4) |
| `expo.android.package` | `com.trimpro.field` |
| `expo.android.versionCode` | `34` |
| `expo.android.googleServicesFile` | `./google-services.json` (Firebase project `trimpro-83596`) |
| `expo.android.adaptiveIcon.foregroundImage` | `./assets/adaptive-icon.png` (1024×1024), `backgroundColor: #2E4A59` |
| `expo.android.permissions` | `CAMERA, RECORD_AUDIO, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_EXTERNAL_STORAGE, WRITE_EXTERNAL_STORAGE` |
| `expo.plugins` | `expo-secure-store`, `expo-notifications`, `expo-font`, `./plugins/withAndroidViewerQueries.js`, `expo-share-intent` (with MIME/intent config) |
| `expo.extra.eas.projectId` | `5d6344e3-86ce-4e96-93e8-13893313d47f` |
| `expo.owner` | `izz8457s-organization` (EAS/Expo account — not itself "trimpro"-branded) |

### `eas.json` (apps/mobile/eas.json) build profiles

```
cli.appVersionSource: local
build.preview:    distribution=internal, android.buildType=apk,        credentialsSource=local, channel=preview
build.production: distribution=store,    android.buildType=app-bundle, credentialsSource=local, channel=production
```
No `development` profile (root `eas.json` has one, but the root file is unused — see
above). No `submit` block (Play Store submission not yet configured in the real project).

### `package.json` (apps/mobile) scripts
`dev`/`start` → `expo start`; `android`/`ios`/`web` → `expo run:*`/`expo start --web`;
`build:apk` → `eas build -p android --profile preview --non-interactive`; `build:aab` →
`eas build -p android --profile production --non-interactive`; `ota:preview` /`ota:prod`
→ `node ./scripts/publish-ota.mjs preview|production` (a guarded wrapper around
`eas update`, see §6 notes).

---

## 2. Every screen (36 files under `apps/mobile/src/screens/`, 33 are actual screen
components; 3 are non-screen helpers)

Grouped by navigator/tab, using the routes actually wired in
`apps/mobile/src/navigation/RootNavigator.tsx`:

### Auth stack (shown when logged out)
- `screens/auth/LoginScreen.tsx` — email/password sign-in; renders the brand
  logo/wordmark, Terms/Privacy links.

### Drawer → Jobs tab (`JobsStackParamList`, initial route `JobsList`)
- `screens/jobs/JobsScreen.tsx` (route `JobsList`, header "Production Line") — field
  worker's own job list.
- `screens/dashboard/DashboardScreen.tsx` (`DashboardHome`) — home/dashboard summary.
- `screens/jobs/JobDetailScreen.tsx` (`JobDetail`) — single job detail for a field user.
- `screens/jobs/AllJobsScreen.tsx` (`AllJobsList`, header "All Jobs") — admin/office view
  of every job (gated by `canViewAllJobs()` permission).
- `screens/jobs/ProductionScreen.tsx` (`Production`) — production-board view (gated by
  `hasWebPermission('production.view')`).
- `screens/jobs/AdminJobDetailScreen.tsx` (`AdminJobDetail`) — admin variant of job
  detail, reached from All Jobs.
- `screens/jobs/CreateJobScreen.tsx` (`CreateJob`) — new job form.
- `screens/jobs/EditJobScreen.tsx` (`EditJob`) — edit existing job.
- `screens/notifications/NotificationsScreen.tsx` (`NotificationsHome`) — notification feed.
- `screens/notifications/NotificationSettingsScreen.tsx` (`NotificationSettings`) —
  per-user notification preferences.
- `screens/requests/RequestsListScreen.tsx` (`RequestsHome`) — sales/lead "Requests" list
  (gated by `canViewRequests()`).
- `screens/requests/MeasuringRequestsScreen.tsx` (`MeasuringRequestsHome`) — list of
  measuring/estimate requests.
- `screens/requests/MeasuringRequestDetailScreen.tsx` (`MeasuringRequestDetail`) — single
  measuring request.
- `screens/requests/CreateRequestScreen.tsx` (`RequestCreate`) — new request/lead form
  (supports resuming a local draft via `draftId`).
- `screens/requests/RequestDetailScreen.tsx` (`RequestDetail`) — single request detail.
- `screens/calls/CallsScreen.tsx` (`CallsHome`) — recent calls list.
- `screens/outbox/OutboxScreen.tsx` (`OutboxHome`) — queued offline writes awaiting sync.
- `screens/profile/ProfileScreen.tsx` (`ProfileHome`) — user profile / settings / sharing
  test entry point.
- `screens/share/ShareIngressScreen.tsx` (`ShareIngress`, header "Share to TrimPro") —
  landing screen when a file is shared into the app from another app.

### Drawer → Schedule tab (`ScheduleStackParamList`)
- `screens/schedule/ScheduleScreen.tsx` (`ScheduleHome`) — calendar/week schedule view.
- `screens/schedule/ScheduleDetailScreen.tsx` (`ScheduleDetail`) — single schedule entry.
- `screens/schedule/ScheduleCreateScreen.tsx` (`ScheduleCreate`) — new/edit schedule entry.

### Drawer → Tasks tab (`TasksStackParamList`)
- `screens/tasks/TasksScreen.tsx` (`TasksList`) — assigned tasks list.
- `screens/tasks/TaskDetailScreen.tsx` (`TaskDetail`) — single task detail.

### Drawer → Messages tab (`MessagesStackParamList`)
- `screens/messages/MessagesScreen.tsx` (`MessagesList`) — conversation list.
- `screens/messages/TeamChatScreen.tsx` (`TeamChat`) — internal team-chat thread.
- `screens/messages/MessageThreadScreen.tsx` (`MessageThread`) — single conversation
  thread (media, voice notes, job-linked messages).

### Drawer → Issues tab (`IssuesStackParamList`)
- `screens/issues/IssuesScreen.tsx` (`IssuesList`) — open issues list.
- `screens/issues/IssueDetailScreen.tsx` (`IssueDetail`) — single issue detail.

### Non-screen helper files (not routes)
- `screens/jobs/jobDetailSections.tsx`, `screens/messages/message-thread-utils.ts`,
  `screens/requests/request-utils.ts` — shared render/section/utility helpers imported by
  the screens above.

### Orphaned/dead screens (present on disk, not reachable from any navigator)
- **`screens/more/MoreScreen.tsx`** — a "More" hub screen (outbox count, nav list) typed
  against `MoreStackParamList` (defined in `src/types/navigation.ts`), but no
  `MoreStack`/`createNativeStackNavigator` for it exists anywhere in
  `RootNavigator.tsx`. Unreachable in the current app.
- **`screens/jobs/FullJobsScreen.tsx`** — a full jobs-list screen, not imported by
  `RootNavigator.tsx` or any other file in `src/`. Unreachable dead code.
  (Confirmed via `grep -rn "FullJobsScreen"` across `src/` — zero references outside its
  own file.)

---

## 3. Auth flow

- **API base URL** — `apps/mobile/src/config/env.ts:1-31`.
  - Reads `process.env.EXPO_PUBLIC_API_URL` (an Expo public env var, so it must be baked
    in at build time, not runtime-configurable without a rebuild/OTA that changes the JS
    bundle).
  - **Hard-coded production fallback, `env.ts:4`**: `const PROD_FALLBACK_URL =
    'https://app.trimprony.com'`. If `EXPO_PUBLIC_API_URL` is unset, or set to something
    that resolves to a local/IP host, production builds silently fall back to this
    trimprony.com URL (`resolveApiBaseUrl()`, `env.ts:18-29`).
  - Dev fallback (`env.ts:5`): `http://10.0.2.2:3000` (Android emulator loopback).
  - `ENVIRONMENT.md` documents the intended override: `EXPO_PUBLIC_API_URL=https://app.trimprony.com`.
  - This same `https://app.trimprony.com` literal is **also hard-coded independently** in
    two other files (not derived from `env.ts`): `src/services/open-attachment.ts:9`
    (media base URL fallback) and `src/components/attachments/ImageMarkupWebView.tsx:552`
    (WebView `baseUrl`). A rebrand of the API domain must update all three, not just
    `env.ts`.
  - The Terms/Privacy links in `LoginScreen.tsx:106,110` are hard-coded to
    `https://app.trimprony.com/terms` and `/privacy`.

- **Login call** — `apps/mobile/src/auth/AuthContext.tsx:160-171` (`signIn`), calling
  `apiRequest<LoginResponse>('/api/auth/login', 'POST', { email, password, deviceId,
  clientType: 'mobile' })` via `apps/mobile/src/api/client.ts:94-131` (`apiRequest`).
  **`clientType: 'mobile'`** is sent on login (`AuthContext.tsx:165`) and again on token
  refresh (`api/client.ts:47` inside `refreshAccessTokenSilently`, body includes
  `clientType: 'mobile'`) — this is how the backend distinguishes mobile sessions.

- **Token storage** — `apps/mobile/src/auth/secure-storage.ts`, via `expo-secure-store`.
  Keys (all string literals, all namespaced `trimpro.mobile.*`, `secure-storage.ts:4-7`):
  `trimpro.mobile.accessToken`, `trimpro.mobile.refreshToken`, `trimpro.mobile.user`,
  `trimpro.mobile.deviceId`.

- **Refresh logic** — `apps/mobile/src/api/client.ts:38-92`
  (`refreshAccessTokenSilently`), a single in-flight promise guard (`refreshInFlight`) so
  concurrent 401s don't trigger duplicate refreshes. Calls `POST
  ${API_BASE_URL}/api/auth/refresh` with `{ refreshToken, deviceId, clientType: 'mobile'
  }`. `apiRequest` (`client.ts:94-131`) auto-retries a request once on a 401 after a
  successful refresh (`hasRetried` flag).

- **Logout** — `AuthContext.tsx:66-83` (`signOut`): reads the refresh token + device id,
  fire-and-forgets `POST /api/auth/logout`, unregisters the push token
  (`unregisterPushToken()`), clears in-memory state, then `clearAuth()`
  (`secure-storage.ts:37-43`, deletes the three SecureStore keys — device id key is
  intentionally kept).

- **Session restore on cold start** — `AuthContext.tsx:99-152`: reads stored user +
  refresh token, hits `/api/me` to force a token refresh if needed, with a hard 4s
  timeout per step and a 6s absolute failsafe (`SESSION_RESTORE_TIMEOUT_MS`,
  `AuthContext.tsx:24`) so a hung SecureStore/network call can never leave the user stuck
  on a splash screen.

- **Deep-link login**: none found. No screen or route handles a login/auth deep link;
  `trimprofield://`/`trimpro://` links only route to already-authenticated screens
  (jobs/tasks/issues/messages/schedule — see §4 deep-link list). If the app isn't logged
  in, `RootNavigator` simply shows `AuthStack` regardless of the incoming link target.

- **User-Agent header**: every hand-rolled `fetch`/`apiRequest` call sends a hard-coded
  `'User-Agent': 'TrimProMobile'` string — 5 occurrences: `api/client.ts:52`,
  `api/client.ts:103`, `auth/AuthContext.tsx:81`, `services/open-attachment.ts:135`,
  `services/publish-request-draft.ts:79`. If the backend does any User-Agent sniffing
  (analytics, feature-flagging, force-update logic) this string must be renamed in all 5
  places together.

---

## 4. Branding surface — every `trimpro`/`trim pro`/`trimprony` occurrence

Search was case-insensitive, scoped to `apps/mobile/` (real project), excluding
`node_modules`, `dist/`, `.expo/`, and `*.log`. No occurrences of `"trim pro"` (with a
space) were found anywhere. All hits are `trimpro`/`TrimPro`/`trimprofield`/`trimprony`.
**29 files** contain at least one hit. Full inventory, classified:

### User-visible strings (customer sees these on screen or in Alerts)
| File:line | String | Notes |
|---|---|---|
| `src/navigation/RootNavigator.tsx:430` | `<Text style={styles.brandTitle}>TrimPro</Text>` | Drawer header wordmark |
| `src/navigation/RootNavigator.tsx:518` | `<Drawer.Screen name="MainTabs" ... options={{ title: 'TrimPro' }} />` | Drawer screen title |
| `src/navigation/RootNavigator.tsx:178` | `options={detailsHeaderOptions('Share to TrimPro')}` | Share-ingress screen header |
| `src/screens/auth/LoginScreen.tsx:14` | `const displayName = branding.appDisplayName || 'TrimPro'` | Fallback login logo text — see runtime-branding note below |
| `src/screens/profile/ProfileScreen.tsx:227` | `"Share photos, videos, and documents into TrimPro from other apps."` | Profile → Sharing help text |
| `src/branding/BrandingContext.tsx:48` | `appDisplayName: 'TrimPro Field'` | Default/fallback branding object |
| `src/notifications/registerPush.ts:60` | `name: 'TrimPro'` | Android push notification **channel name**, user-visible in system notification settings |

### Asset / identifier names (not literally rendered text, but named after the brand)
| Item | Notes |
|---|---|
| `assets/tp.png` (1024×1024 PNG) | Orphaned — grepped across all of `src/` and `app.json`, **zero references**. Not used by icon/splash/adaptiveIcon config. Likely a leftover "TP" logo draft. Safe to replace/delete but confirm with Izzy first (read-only audit, not touched). |
| `assets/icon.png`, `assets/adaptive-icon.png`, `assets/splash-icon.png` | All exactly **1024×1024**, all **byte-identical file size (11,537 bytes)** to each other and to `tp.png` — strong signal all four are the same source image reused for every slot. `assets/favicon.png` is **48×48** (web favicon, distinct file, smaller). |
| `credentials/com-trimpro-field-upload.jks` | Android upload keystore, name embeds `com.trimpro.field`. |
| `credentials/android-keystore.jks`, `credentials/android-upload-keystore.jks` | Generically named, no brand string in the filename itself. |
| Firebase project `trimpro-83596` | `google-services.json:4-5` — `project_id: "trimpro-83596"`, `storage_bucket: "trimpro-83596.firebasestorage.app"`. |

### Identifiers (code-level constants, storage keys, schemes — invisible to the user but must change together)
| File:line | Identifier |
|---|---|
| `app.json` → `expo.ios.bundleIdentifier`, `expo.android.package` | `com.trimpro.field` (both platforms) |
| `app.json` → `expo.scheme` | `["trimprofield", "trimpro"]` |
| `app.json` → `expo.slug`, `package.json` → `name` | `trimpro-field` |
| `app.json` → `expo.ios.infoPlist.NSCameraUsageDescription` etc. (4 strings) | All read "TrimPro Field uses camera/photo library/microphone/location to..." — these ARE user-visible (shown in the iOS permission prompt) |
| `src/auth/secure-storage.ts:4-7` | SecureStore keys `trimpro.mobile.accessToken`, `.refreshToken`, `.user`, `.deviceId` |
| `src/offline/outbox.ts:5` | AsyncStorage key `trimpro.mobile.outbox` |
| `src/drafts/storage.ts:3` | AsyncStorage key `trimpro.mobile.local-drafts.v1` |
| `src/notifications/registerPush.ts:9-11` | Storage keys `trimpro.push.token`, `trimpro.push.deviceId`, `trimpro.push.lastReceivedAt` |
| `src/notifications/registerPush.ts:59` | Android notification channel id `'trimpro-default'` |
| `src/api/client.ts:52,103`; `src/auth/AuthContext.tsx:81`; `src/services/open-attachment.ts:135`; `src/services/publish-request-draft.ts:79` | `User-Agent: 'TrimProMobile'` (5 places) |
| `src/share/shareIntentLinking.ts:11,25,29` | `SHARE_INGRESS_URL = 'trimprofield://share-ingress'`, fallback scheme `'trimprofield'`, package check `'com.trimpro.field'` |
| `src/navigation/RootNavigator.tsx:72` | `linking.prefixes = ['trimprofield://', 'trimpro://']` |
| `src/notifications/openFromNotification.ts:10,17-24` | Builds `trimpro://messages/:id`, `trimpro://jobs/:id`, `trimpro://tasks/:id`, `trimpro://issues/:id`, `trimpro://requests/:id`, `trimpro://measuring-requests/:id`, `trimpro://schedule` deep links from push-notification payloads |
| `src/screens/jobs/jobDetailSections.tsx:613,637` | `Linking.openURL('trimpro://tasks/${id}')`, `'trimpro://issues/${id}'` |
| `src/screens/messages/MessageThreadScreen.tsx:1356`, `src/components/chat/MessageBubble.tsx:318` | `Linking.openURL('trimpro://jobs/${jobId}')` |

### Config (build/deploy tooling, not shipped in the app itself)
`plugins/withAndroidShareIntent.js` (comments only, dead file), `package.json`,
`package-lock.json`, `BUILDING.md`, `DEPLOYING.md`, `BACKEND_ENDPOINT_AUDIT.md`,
`credentials.json` (keystore alias `trimproupload`, plus a **plaintext keystore password**
present in that file — value withheld from this report per instructions; flagged as a
pre-existing security exposure, not something this audit is fixing).

### Important cross-cutting finding: a live runtime-branding system already exists
`src/branding/BrandingContext.tsx` fetches `GET {API_BASE_URL}/api/public/branding` at
launch and on foreground, and can change **`appDisplayName`, `loginLogoUrl`,
`headerLogoUrl`, `primaryColor`, `secondaryColor`, `accentColor`, `buttonColor`,
`buttonTextColor`, `sidebarColor`, `menuColor`, `backgroundColor`,
`splashScreenRuntimeImageUrl`** without a new app build (cached to AsyncStorage, applied
immediately, refreshed on foreground). The file's own header comment is explicit about the
split: **RUNTIME (OTA-updatable): colors, in-app logos, display name, dynamic splash
image. BUILD-TIME ONLY (needs a new native build): app icon, native splash screen, app
store name.** This means a large share of the rebrand (in-app colors/logo/display name)
can potentially be driven from the backend's branding admin panel rather than a code
change — but the **hard-coded `'TrimPro'`/`'TrimPro Field'` fallback strings above only
render if that API call fails or hasn't completed yet**, so they still need updating as
the safety-net default, and the native-only items (icon, splash, store listing name,
bundle/package id, scheme, Firebase project) always require code + rebuild regardless of
this system.

---

## 5. Theme

- **Theme file**: `apps/mobile/src/theme/tokens.ts` — single source of truth exporting
  `colors`, `spacing`, `radius`, `typography`, `shadows`. `colors.brandPrimary =
  '#2E4A59'` is the one theme-level "primary color" constant; it and the rest of
  `colors` are plain static objects imported directly (no ThemeProvider/context, no
  hook) — every screen imports `{ colors, ... } from '../../theme/tokens'` directly.
- **Today's primary color**: `#2E4A59` (a dark teal/slate), used as
  `colors.brandPrimary` and duplicated as the splash/adaptive-icon `backgroundColor` in
  `app.json`, and as the default `sidebarColor`/`buttonColor`/`accentColor` fallback
  (`#E6C98B`, a tan/gold) throughout `BrandingContext.tsx` and `LoginScreen.tsx`.
- **Dark mode**: **does not exist**. `app.json` sets `userInterfaceStyle: "automatic"`
  (so iOS/Android *could* signal dark mode to the app), but there is zero use of
  `useColorScheme`, `Appearance`, or any `dark`/`isDark` branching anywhere in `src/`
  (confirmed via grep — no matches). The app is a fixed light theme regardless of OS
  setting.
- **Hard-coded hex colors outside the theme file** — despite `theme/tokens.ts` existing,
  screens and components extensively inline their own hex literals rather than using the
  shared tokens. Top 20 files by raw `#RRGGBB`/`#RGB` occurrence count (excludes
  `theme/tokens.ts` itself, which has 12 — those are the legitimate token definitions):

  | Count | File |
  |---|---|
  | 30 | `screens/schedule/ScheduleScreen.tsx` |
  | 26 | `screens/jobs/JobDetailScreen.tsx` |
  | 23 | `screens/tasks/TasksScreen.tsx` |
  | 22 | `components/chat/MessageBubble.tsx` |
  | 20 | `components/attachments/ImageMarkupWebView.tsx` |
  | 18 | `screens/requests/RequestDetailScreen.tsx` |
  | 18 | `screens/requests/CreateRequestScreen.tsx` |
  | 18 | `components/chat/Composer.tsx` |
  | 17 | `screens/messages/MessageThreadScreen.tsx` |
  | 14 | `screens/requests/RequestsListScreen.tsx` |
  | 14 | `screens/issues/IssuesScreen.tsx` |
  | 14 | `components/attachments/AttachmentGalleryModal.tsx` |
  | 10 | `components/schedule/FilterSheet.tsx` |
  | 10 | `components/attachments/PdfJsWebView.tsx` |
  | 8 | `screens/issues/IssueDetailScreen.tsx` |
  | 8 | `screens/auth/LoginScreen.tsx` |
  | 8 | `components/StatusChip.tsx` |
  | 6 | `screens/jobs/ProductionScreen.tsx` |
  | 6 | `components/chat/ConversationRow.tsx` |
  | 6 | `components/attachments/JobDocumentPdfModal.tsx` |

  This means a pure "change the theme file" rebrand will **not** be visually complete —
  the highest-traffic screens (Schedule, Job Detail, Tasks, chat/messaging) carry their
  own inline color literals that a token-only edit will miss.
- **Fonts**: no custom font family is loaded (`expo-font` is a listed plugin/dependency
  but no `useFonts`/font-loading call or custom typeface file was found in `src/`).
  `typography` in `tokens.ts` only sets `fontSize`/`fontWeight`, and `LoginScreen.tsx`'s
  logo text explicitly uses `fontFamily: 'System'`. System font throughout.

---

## 6. Native folders

**No `android/` or `ios/` directories exist under `apps/mobile/`.** This is a fully
**managed Expo project** (no `expo prebuild` has been run and committed). Consequences for
rebranding:
- There is **no `strings.xml`**, **no `build.gradle` `applicationId`**, **no
  `Info.plist` `CFBundleDisplayName`/`PRODUCT_BUNDLE_IDENTIFIER`** to hand-edit — all of
  those are generated from `app.json` (`expo.name`, `expo.android.package`,
  `expo.ios.bundleIdentifier`) at build time by EAS Build / `expo prebuild`. Rebranding
  the name/bundle id is a single-source-of-truth edit in `app.json`, not a multi-file
  native edit — **provided no one prebuild-ejects this project** before the rebrand lands.
- **Google Services / Firebase**: `google-services.json` at `apps/mobile/` root, tied to
  Firebase project `trimpro-83596` and Android package `com.trimpro.field` (confirmed:
  `google-services.json:12` `"package_name": "com.trimpro.field"`). **Changing
  `android.package` in `app.json` without also updating/replacing this file will break
  push notifications** — Firebase's config is keyed to the exact package name; a changed
  package name needs either a new Android app registered inside the same Firebase project
  (yielding a new `google-services.json`) or a full new Firebase project if the Firebase
  project itself is being renamed off "trimpro".
- **Keystores present** (contents/secrets not read beyond confirming file type and the
  keystore alias/password fields' *existence* — no key material or password values are
  reproduced in this report): `credentials/android-keystore.jks`,
  `credentials/android-upload-keystore.jks`,
  `credentials/com-trimpro-field-upload.jks`. `credentials.json` (root of `apps/mobile/`)
  references a keystore path, keystore alias `trimproupload`, and **a plaintext
  keystore password checked into git** — a real risk independent of rebranding, flagged
  under §7/risk but not something this audit will fix.
  - **Rebranding risk note**: if `apps/mobile/app.json`'s `android.package` changes,
    whichever of these keystores was used for any **already-published** build cannot
    sign a build under the new package name/identity in the way Play Store expects for
    updates to an existing listing — this matters only if the app has already shipped to
    real users under `com.trimpro.field` (build artifacts exist locally — see §7 — but no
    Play Store / App Store listing evidence was found in this repo).

---

## 7. Existing build artifacts

**Only APKs, at the Works root (not inside `apps/mobile/`), all named after the old
brand:**

| File | Size | Date |
|---|---|---|
| `trimpro-preview-v7-keyboard.apk` | 115,945,627 bytes (~110.6 MB) | Mar 30 09:46 |
| `trimpro-preview-v8.apk` | 115,946,895 bytes (~110.6 MB) | Mar 30 11:58 |
| `trimpro-preview-v9.apk` | 115,945,867 bytes (~110.6 MB) | Mar 30 12:54 |
| `trimpro-preview-build.apk` | 115,955,091 bytes (~110.6 MB) | Apr 4 23:20 |
| `trimpro-preview-latest.apk` | 115,957,751 bytes (~110.6 MB) | Apr 5 00:12 |

No `.aab` and no `.ipa` files exist anywhere under the Works root (confirmed via a
recursive glob for `*.apk`/`*.aab`/`*.ipa`) — i.e. no store-ready Android bundle and no
iOS build artifact exists locally; only internal-testing APKs. `apps/mobile/dist/`
contains a **JS-only EAS Update export** (hashed asset files, `index.html`,
`_expo/static/`, `metadata.json`, `assetmap.json`) — this is an OTA update bundle, not an
installable app artifact, and wasn't opened/inspected beyond directory listing.

---

## Out of scope, noticed

- `mobile-app/` (repo root) is an unused default Expo scaffold — not touched, not part of
  this audit's real-project findings, listed above only to explain why it's not the
  subject.
- The repo root also contains ~9 huge, unrelated files that happen to have "trimpro" in
  their names and were **not** opened/inspected (out of the mobile-app config/screen
  scope of this audit): `trimpro-deploy-*.tgz` (5 files, up to 1.47 GB),
  `trimpro-hotfix-deploy.tgz`, `trimpro-job-attach-hotfix.tgz`, `trimpro-gap.png`, plus
  three very large log files (`mobile-crash-live.log` ~13 MB, `mobile-live-logcat.txt`
  ~97 MB, `mobile-logcat.txt` ~68 MB) that are device logs, not app source/config.
- This "Loopcom works" tree carries its **own** `CLAUDE.md`/git setup, independent of the
  Connect 2 repo's `CLAUDE.md` shown in this session's system context (different
  standing rules, different remote — `izzwgg-arch/Trimpro.git` — different branch
  strategy). It states the current branch (`loopcom`, confirmed via `git branch`/`git
  rev-parse` — read-only) is where Loopcom-facing work should live, and that
  `izzwgg-arch/Trimpro` must never receive Loopcom-branded pushes. Noted for awareness
  only; this audit made no commits and changed no branch.
- Per this task's explicit read-only/single-file-output mandate, no other project file
  (including this tree's own `CLAUDE.md`/`MEMORY.md`/handoff docs, which that repo's own
  rules would normally require updating at the end of a task) was created, edited, or
  updated — the task's own instructions ("Your ONLY write is one report file... Do NOT
  edit, create, move or delete any file inside the repository") take precedence for this
  specific, explicitly-scoped audit run.
