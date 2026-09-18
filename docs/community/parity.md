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
| Media lightbox | ✓ (full) | ✓ | ✓ | `src/ui/Lightbox.tsx`: pinch-to-zoom, double-tap-to-zoom, one-finger pan while zoomed, tap-to-close — built on `react-native-gesture-handler` gestures driving RN core `Animated` (no `react-native-reanimated`, kept out to avoid a native rebuild for one screen; unverified on a real touchscreen) |
| Impressions tracked | ✓ | ✓ | ✓ | `onViewableItemsChanged` → `POST /posts/:id/impression` |
| **Network** |
| Invitations (accept/ignore), sent requests (withdraw) | ✓ | ✓ | ✓ | |
| People you may know (connect/dismiss) | ✓ | ✓ | ✓ | |
| Connections list: search, filter, relationship tags, message, remove | ✓ | ✓ | ✓ | |
| Follow / unfollow people and companies | ✓ | ✓ | ✓ | |
| Mutual connections | ✓ | partial | partial | shown as a count on the profile; no dedicated "see mutuals" screen |
| Block / mute | ✓ | ✓ | ✓ | Person profile's "…" menu (Block / Mute / Report), and Settings → Privacy → "Blocked & muted" (`BlockedScreen`) lists + unblocks/unmutes people and muted companies. The profile menu doesn't know the CURRENT blocked/muted state going in (`/public/people/:username` doesn't return it), so its buttons are one-shot actions rather than toggles — the Blocked & muted list is the source of truth for current state |
| **Messaging** |
| Thread list: inbox / requests / archived | ✓ | ✓ | ✓ | |
| Conversation: send/reply/react/edit/delete | ✓ | ✓ | ✓ | |
| Attachments: image, file, voice note | ✓ | ✓ | ✓ | `expo-image-picker`, `expo-document-picker`, `expo-av` recording |
| Forward message | ✓ | ✓ | ✓ | via `NewMessageScreen` picking a recipient, then `POST /threads/:id/messages/:mid/forward` |
| Typing indicator (send + receive) | ✓ | ✓ | ✓ | app sends `POST /threads/:id/typing` on each keystroke; the open conversation now renders a live "Typing…" line from the realtime `typing` SSE event (see Realtime row) |
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
| Cover photo upload | ✓ | ✓ | ✓ | `EditProfileScreen`'s cover strip, tap to upload — a real multipart `POST /me/cover` (`expo-image-picker`, 3:1 crop) |
| Experiences / educations / services / certifications CRUD | ✓ | ✓ | ✓ | `EditProfileScreen`: add/edit/delete sheets for each section, wired to their real routes. Portfolio CRUD was left read-only in this pass (routes exist, no UI) |
| Skills + endorsements | ✓ | partial | partial | skills shown; endorsing someone else's skill isn't wired to a control |
| QR code (own profile) | ✓ (web) | ✓ | ✓ | `react-native-qrcode-svg`, encodes the same `/people/:username?via=qr` URL the web uses |
| Scan a QR code | — (N/A on web) | ✓ | ✓ | `expo-camera`'s `CameraView` barcode scanning → `/qr/resolve` → connect/follow/save contact/"we just met" |
| Save scanned contact to phone contacts | — (N/A) | ✓ | ✓ | `expo-contacts`; falls back to the OS share sheet with a vCard-style text if contacts permission is denied |
| **Companies** |
| Company page: About / Posts / Jobs / People | ✓ | ✓ | ✓ | |
| Follow / message / request quote | ✓ | ✓ | ✓ | Follow and Message are fully wired; "Request quote" now opens `RfqNewScreen` pre-addressed to that company (native, in-app — was a web-form fallback before this pass) |
| Create/manage a company, catalog, verification | ✓ | — | — | admin-side company management wasn't built for mobile in this pass |
| **Jobs** | ✓ | ✓ | ✓ | `JobsListScreen` (search, saved, work-mode filter), `JobDetailScreen` (apply sheet with section checklist + résumé document picker, save, ask-referral), `MyApplicationsScreen` (stage timeline) |
| **RFQ** | ✓ | ✓ | ✓ | `RfqHomeScreen` (my requests / vendor inbox / browse), `RfqNewScreen`, `RfqDetailScreen` (quotes table with accept/shortlist/decline for the buyer, submit/update-a-quote sheet with a per-unit suggestion for the vendor, questions with an answer box, "Message" opens the quote's thread) |
| **Events** | ✓ | ✓ | ✓ | `EventsListScreen` (upcoming/past/mine), `EventDetailScreen` (RSVP going/interested/cancel, attendees, add-to-calendar via `expo-calendar` with a share-the-`.ics` fallback on denied permission or any calendar-API error) |
| **Groups** | ✓ | ✓ | ✓ | `GroupsListScreen` (mine/discover + search), `GroupDetailScreen` (feed/members/files tabs, join/request-to-join/leave, group chat, file upload) |
| **Opportunities** | ✓ | ✓ | ✓ | `OpportunitiesListScreen` (type chips), `OpportunityDetailScreen` (renders the type's dynamic fields, "I'm interested" opens a thread with the poster, "Ask a question"), `PostOpportunityScreen` (fully dynamic form driven by `GET /opportunities/types`' field schema — `src/domain/dynamicFields.ts`) |
| **Marketplace** | ✓ | ✓ | ✓ | `MarketplaceListScreen` (category chips, 2-column grid), `ListingDetailScreen` (photo gallery + lightbox, message seller, save), `PostListingScreen` (multi-photo picker) |
| **CRM** | ✓ | ✓ | ✓ | `CrmScreen`: contacts (search, last-contact date), per-contact notes + a "set reminder" action, and a Reminders tab (due date, done toggle, delete) |
| **Concierge** | ✓ | ✓ | ✓ | `ConciergeScreen`: chat-style ask → intent + explanation → matched people/orgs/jobs/events/groups (tap to open) → proposed actions → confirm sheet → `POST /concierge/act`. Nothing is sent until the person confirms, matching the api's own design |
| **For you (recommendations)** | ✓ | ✓ | ✓ | `ForYouScreen`: horizontal rails for businesses/customers/jobs/groups/events, each card showing its `why`/`reason` and a Dismiss action (`POST /recommendations/:id/dismiss`) |
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
| Live updates (new message, notification, presence, typing) | ✓ (SSE) | ✓ | ✓ | Real SSE via `react-native-sse` (`src/api/realtime.ts`) against the same `GET /realtime/stream` the web uses — `react-native-sse` drives a plain `XMLHttpRequest` in streaming mode and re-reads its growing `responseText`, which both platforms' XHR support, sidestepping RN `fetch`'s unreliable `ReadableStream`. Exponential reconnect backoff (`src/api/backoff.ts`) on top of the library's own retry. **An open conversation now shows the other person's message and a live "Typing…" line immediately** (`ConversationScreen`), the thread list and notifications refresh on their respective live events, and `AuthProvider`'s badge counts update from the stream instead of only a 15s poll. Falls back to the original 15s-poll behavior if constructing the connection ever throws. Unverified against a live server without a device/emulator in this environment (see README) |

## Summary of the biggest gaps

1. **Realtime is unverified on a device.** The SSE client is real (not a
   dormant/documented-only path anymore) and typechecks, but nobody has
   watched an actual event arrive on a phone — see README's "What could not
   be verified" section.
2. **Portfolio CRUD, notification-preferences screen, saved-searches UI, and
   thread mute/pin/archive controls** still have no native screen — all have
   real, working api routes; only the screen wasn't built in this pass.
3. **Passkeys are not implemented anywhere** on mobile — there's no Expo API
   for it without a native module this app doesn't ship.
4. **The pinch-to-zoom lightbox, add-to-calendar, and every new Jobs/RFQ/
   Events/Groups/Opportunities/Marketplace/CRM/Concierge/For-you screen are
   wired to the real api and typecheck clean, but none has been tapped
   through on a device or emulator** — this environment has neither. Treat
   them as "should work" rather than "proven" until someone does.
