# Loopcom Community — web / iOS / Android parity

`✓` built and wired to the real api · `partial` some real functionality, gaps noted · `—` not built (mobile opens the web page instead, via `ExternalLinkScreen`, where a deep link exists for it).

Mobile app root: `apps/community-mobile`. iOS and Android share one React
Native codebase, so their column is almost always identical; where it isn't,
the gap is platform-specific native API availability and is noted.

| Capability | Web | iOS | Android | Notes |
|---|---|---|---|---|
| **Auth** |
| Email/password sign in, sign up | ✓ | ✓ | ✓ | |
| Sign in with Loopcom (SSO) | ✓ | ✓ | ✓ | `WebBrowser.openAuthSessionAsync` to the portal, same server verification as web |
| Sign in with Apple | ✓ | ✓ | — | `expo-apple-authentication` is iOS-only by definition |
| Sign in with Google | ✓ | partial | partial | button only renders when `EXPO_PUBLIC_GOOGLE_CLIENT_ID_*` are set; no client ID configured yet |
| Passkeys | ✓ | — | — | no Expo API exposes platform passkey ceremonies without a native module this app doesn't have; not faked |
| Email/phone verification codes | ✓ | ✓ | ✓ | |
| Forgot / reset password | ✓ | partial | partial | app sends the reset email/SMS; the reset link itself opens the **web** reset page (there's no reason to duplicate a one-time token form natively) |
| Change password | ✓ | ✓ | ✓ | |
| TOTP two-step verification | ✓ | ✓ | ✓ | setup/enable/disable; otpauth URL shown as text + tappable link (no in-app QR render of the *server's* secret, only of the person's own profile) |
| Biometric app-lock | — (N/A) | ✓ | ✓ | mobile-only concept; gated by `src/auth/policy.ts`'s `needsBiometricGate` |
| Sessions list + revoke, sign out everywhere | ✓ | ✓ | ✓ | |
| Deactivate / delete account | ✓ | ✓ | ✓ | |
| Data export | ✓ | ✓ | ✓ | downloads JSON via `expo-file-system/legacy`, shares via the OS share sheet |
| 5-step onboarding | ✓ | ✓ | ✓ | mirrors the web's steps and copy |
| **Feed / posts** |
| Feed modes (for you / following / latest / industry / local / opportunities / jobs) | ✓ | ✓ | ✓ | |
| Infinite scroll, pull to refresh | ✓ | ✓ | ✓ | |
| React, comment (+ replies), repost, save, hide, report | ✓ | ✓ | ✓ | |
| Poll vote | ✓ | ✓ | ✓ | |
| Photo/document composer | ✓ | ✓ | ✓ | `expo-image-picker` / `expo-document-picker` |
| Poll composer | ✓ | ✓ | ✓ | |
| Post visibility (anyone/connections/company) | ✓ | ✓ | ✓ | |
| Post-as-company | ✓ | ✓ | ✓ | shown when the person has `org.post` on a membership |
| Link preview card | ✓ | ✓ | ✓ | read-only render; app doesn't call `/posts/preview` itself before posting |
| Media lightbox | ✓ (full) | partial | partial | full-screen view exists; **no pinch-to-zoom** (would need `react-native-gesture-handler` + `react-native-reanimated` wiring not built here) |
| Impressions tracked | ✓ | ✓ | ✓ | `onViewableItemsChanged` → `POST /posts/:id/impression` |
| **Network** |
| Invitations (accept/ignore), sent requests (withdraw) | ✓ | ✓ | ✓ | |
| People you may know (connect/dismiss) | ✓ | ✓ | ✓ | |
| Connections list: search, filter, relationship tags, message, remove | ✓ | ✓ | ✓ | |
| Follow / unfollow people and companies | ✓ | ✓ | ✓ | |
| Mutual connections | ✓ | partial | partial | shown as a count on the profile; no dedicated "see mutuals" screen |
| Block / mute | ✓ | — | — | not built in this pass; no screen calls `POST /people/:id/block` or `/mute` |
| **Messaging** |
| Thread list: inbox / requests / archived | ✓ | ✓ | ✓ | |
| Conversation: send/reply/react/edit/delete | ✓ | ✓ | ✓ | |
| Attachments: image, file, voice note | ✓ | ✓ | ✓ | `expo-image-picker`, `expo-document-picker`, `expo-av` recording |
| Forward message | ✓ | ✓ | ✓ | via `NewMessageScreen` picking a recipient, then `POST /threads/:id/messages/:mid/forward` |
| Typing indicator (send) | ✓ | ✓ | ✓ | app sends `POST /threads/:id/typing` on each keystroke (debounced); **does not render others' typing state** — needs the realtime `typing` event, which the polling-only realtime layer doesn't carry (see Realtime row) |
| Read receipts | ✓ | ✓ | ✓ | marks read on open; no receipt display in the bubble UI |
| Accept / decline message requests | ✓ | ✓ | ✓ | |
| Mute / pin / archive thread | ✓ | — | — | api routes exist (`/threads/:id/mute|pin|archive`); no UI control wired yet |
| New message: pick from connections or search | ✓ | ✓ | ✓ | |
| **Notifications** |
| Grouped list (today/week/earlier), filters | ✓ | ✓ | ✓ | |
| Inline accept/ignore | ✓ | partial | partial | wired for `connection.request`; other decision kinds (`rfq.quote`, `org.invite`, `group.request`, `intro.request`, `recommendation.new`) open their href instead of an inline action — most of those targets aren't native screens yet either |
| Mark all read / mark one read | ✓ | ✓ | ✓ | |
| Push notifications | ✓ (browser) | ✓ | ✓ | `expo-notifications`; registers via `POST /me/devices`; tap opens the right screen via the deep-link table |
| Notification preferences (per-channel/class) | ✓ | — | — | `GET/PUT /me/notification-prefs` exists; no settings screen built for it (Settings only covers the privacy-preference matrix) |
| **Search** |
| Universal search with facets | ✓ | ✓ | ✓ | |
| Suggestions (people, orgs, recent queries) | ✓ | ✓ | ✓ | |
| Saved searches | ✓ | — | — | route exists; no UI |
| **Profile** |
| View own / others' profile | ✓ | ✓ | ✓ | |
| Edit basics (name, headline, about, location, industry) | ✓ | ✓ | ✓ | |
| Avatar upload | ✓ | ✓ | ✓ | camera roll only — no in-app crop beyond the OS picker's own `allowsEditing` |
| Cover photo upload | ✓ | — | — | `POST /me/cover` exists; no UI control (avatar-only in this pass) |
| Experiences / educations / services / certifications / portfolio CRUD | ✓ | partial | partial | **read-only** render on the profile screen; no add/edit forms built (routes exist server-side) |
| Skills + endorsements | ✓ | partial | partial | skills shown; endorsing someone else's skill isn't wired to a control |
| QR code (own profile) | ✓ (web) | ✓ | ✓ | `react-native-qrcode-svg`, encodes the same `/people/:username?via=qr` URL the web uses |
| Scan a QR code | — (N/A on web) | ✓ | ✓ | `expo-camera`'s `CameraView` barcode scanning → `/qr/resolve` → connect/follow/save contact/"we just met" |
| Save scanned contact to phone contacts | — (N/A) | ✓ | ✓ | `expo-contacts`; falls back to the OS share sheet with a vCard-style text if contacts permission is denied |
| **Companies** |
| Company page: About / Posts / Jobs / People | ✓ | ✓ | ✓ | |
| Follow / message / request quote | ✓ | ✓ | partial | Follow and Message are fully wired; "Request quote" **opens the web RFQ form** (`/rfq/new?to=`) rather than an in-app RFQ flow — the brief allowed this fallback explicitly when time didn't allow the full screen |
| Create/manage a company, catalog, verification | ✓ | — | — | admin-side company management wasn't built for mobile in this pass |
| **Jobs / Events / Groups / RFQ / Opportunities** | ✓ | — | — | no native screens; deep links to these paths open `ExternalLinkScreen`, which offers "Open on web" |
| **Settings / Privacy** |
| Privacy preference matrix | ✓ | ✓ | ✓ | search-engine visibility, findable by phone, read receipts, show online, message requests, analytics |
| Linked Loopcom account status | ✓ | partial | partial | shown read-only; no in-app link/unlink control (`POST/DELETE /auth/link/loopcom` not wired to a button) |
| **Offline** |
| Feed cache | — (N/A) | ✓ | ✓ | last feed page cached in AsyncStorage, shown with an "offline" banner via `@react-native-community/netinfo` |
| Thread list cache | — (N/A) | ✓ | ✓ | same pattern |
| Retry queue for sends | — (N/A) | partial | partial | idempotency keys are used on mutating calls throughout, so a retried send is safe, but there's **no persisted offline queue** that replays automatically when connectivity returns — a failed send today just shows the error toast |
| **Accessibility** |
| Labels/roles on controls, 44pt touch targets, dynamic type respected | ✓ (web equivalent) | ✓ | ✓ | no fixed `allowFontScaling={false}` anywhere; every interactive element has `accessibilityRole`/`accessibilityLabel` |
| **Realtime** |
| Live updates (new message, notification, presence, typing) | ✓ (SSE) | partial | partial | polling every 15s for unread counts while foregrounded (`src/api/realtime.ts`); **no live per-thread message push while a conversation is open** beyond re-fetching on your own actions — a message from the other person won't appear until you back out and back in, or the badge count changes prompt a manual refresh. A documented-but-dormant SSE-over-fetch path exists in `realtime.ts` for when RN's fetch reliably exposes `ReadableStream` on both platforms |

## Summary of the biggest gaps

1. **RFQ, Jobs, Events, Groups, Opportunities have no native screens.** Deep
   links and the company page's "Request quote" button open the web instead.
2. **Realtime is polling, not push-per-event**, so an open conversation
   doesn't show the other person's message live.
3. **No pinch-to-zoom lightbox**, no cover-photo upload, no
   experience/education/service/certification CRUD forms, no block/mute UI,
   no notification-preferences screen, no saved-searches UI, no thread
   mute/pin/archive controls. All of these have real, working api routes;
   only the screen wasn't built in this pass.
4. **Passkeys are not implemented anywhere** on mobile — there's no Expo API
   for it without a native module this app doesn't ship.
