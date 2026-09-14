# ⛔ AGENT HANDOFF — the supermarket DELIVERY TRACKING system: server side complete and LIVE-BUT-INERT in prod; the DRIVER APP FLOW IS UNREACHABLE (2026-08-25) — READ FIRST before answering "where is the tracking system at", before touching apps/api/src/delivery, or before restoring the driver launcher

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Read-only status investigation 2026-08-25 — no code, no deploy, no data change.**
Built 2026-07-23 in one day by Ezra as `feature/supermarket-delivery-tracking`,
merged to main as `5419bdd2`; feature docs live BESIDE the code —
`apps/api/src/delivery/DELIVERY_PR.md` / `DELIVERY_RUNBOOK.md` /
`DELIVERY_DEPLOY.md`, `apps/mobile/DELIVERY_APK_HANDOFF.md` — there was no
ai-context handoff until this section. Customer = Gesheft (the supermarket);
their IVR ext 898 "Order Tracking" is the manual process this replaces.)

- ✅ **THE DOCS' "not migrated / not deployed" IS STALE — verified live 2026-08-25:
  all 21 Delivery*/Driver*/TrackingToken tables EXIST in the prod DB, the routes
  are in `app-api-1` (`registerDeliveryRoutes`, `server.ts:42319`), the public
  page answers** (`GET /api/track/bad-token` → `{"state":"invalid"}`), **and the
  worker container runs both delivery jobs** (`deliveryEtaJob` 30s /
  `deliveryRetentionJob` 6h — silent no-ops at zero rows). The runbook's
  "remaining wiring" list is also done in code: worker crons registered, driver
  screens + `DeliveryNavigator` registered (`RootNavigator.tsx:419`),
  `expo-battery` installed (came with the SDK 54 upgrade; the old tsc error is
  gone — mobile typecheck is 0).
- ⛔ **INERT BY CONFIGURATION, not by absence: 0 `DeliveryTenantSettings` rows,
  0 orders, 0 drivers, and ALL FOUR env vars unset in prod**
  (`DELIVERY_ORDER_SOURCE_SECRET` — so all five `/internal/delivery/*` doors
  refuse; `PUBLIC_TRACKING_BASE_URL`; `DELIVERY_SMS_LIVE`;
  `DELIVERY_GEOCODER_URL`). No human has ever exercised any of it.
  ✅ **UPDATE 2026-08-26: `DELIVERY_GEOCODER_URL` + `DELIVERY_GEOCODER_FORMAT=google`
  are now IN `.env.platform`** (backup `.bak.*.geocoder`) — a Google Geocoding
  API key on the Connect Firebase project `connect-app-23d4f` (billing account
  "loopcom" created + linked by Izzy live; key "Loopcom tracking geocoder"
  restricted to the Geocoding API AND server IP 45.14.194.179 — proven working
  from loopcom, proven REFUSED from elsewhere; 10k lookups/mo free then $5/1k).
  ⛔ No compose override exists, so it reaches the api container at its NEXT
  deploy — an env-only change has no deploy path of its own. The other three
  vars stay unset.
- ⛔⛔ **THE DRIVER FLOW IS UNREACHABLE IN THE SHIPPED APP.** Nothing navigates
  to the `"Delivery"` route — the Settings → "Delivery driver" launcher added by
  `5c95f86c` was **deliberately removed** in `d42cd0bf` (2026-07-28; that
  session's own notes record *"Removed the unrequested 'Delivery driver' row
  from Settings"* — it showed for EVERY user, driver or not).
  `DELIVERY_APK_HANDOFF.md:13` still documents the removed path. Restoring it
  should gate on the user having a `DriverProfile`, not go back for everyone.
- ⛔⛔ **LIVE GPS TRACKING IS DEAD CODE — the headline feature has no data
  source.** `startTracking`/`stopTracking` (`trackingService.ts:70/:90`) are
  called by NOTHING: `deliveryClient.ts` has no tracking start/end functions,
  `RunsScreen` has no "start run" action, so `/mobile/delivery/tracking/*` and
  `/location` are never hit and the dispatcher live map + every ETA stay empty.
  ⛔ And `ACCESS_FINE_LOCATION` + `FOREGROUND_SERVICE_LOCATION` were never added
  to `app.config.ts`/the manifest — the foreground location service would fail
  at runtime on Android 14+ even once wired.
- ⛔ **SMS never sends even with `DELIVERY_SMS_LIVE=1`** — `smsService.ts` only
  stamps rows QUEUED; the BullMQ enqueue was never written (deliberate: needs
  carrier/compliance sign-off). Inbound STATUS/STOP/START parsing works but only
  via the secret-gated test door, not the live VoIP.ms path. **Order intake is a
  `MockOrderSourceAdapter`** — Phase 10 (Gesheft's real order API) is blocked on
  the supermarket's docs. ETA is a haversine stub; geocoding is a noop without
  `DELIVERY_GEOCODER_URL`; proof-of-delivery PIN is recorded but **never
  validated server-side**; voice/IVR status is resolve-only (a PBX write it
  never got). Dashboard `delayed`/`staleGps`/`notificationFailures` tiles
  hardcode 0.
- ✅ **What IS solid:** 44 api routes in `apps/api/src/delivery/` (61 files), 22
  tenant-scoped Prisma models, 14 portal pages under `/tracking/*` + the public
  `/track/[token]` page (JWT-bypassed, leak-free on bad tokens), full RBAC keys
  in `portalPermissions.ts`, offline-queue driver client, 117 unit tests green
  (re-run 2026-08-25). The 2026-08-17 audit's three delivery findings (scan
  idempotency, tracking-session scoping, createDriver validation) are all fixed
  in code. ⛔ The 9.22M-iteration stress harness `DELIVERY_PR.md` cites was
  never committed — the claim is unreproducible.
- ⏳ **Path to production (in order):** restore a gated driver launcher + wire
  start/stop tracking + location permissions (= an APK build); set the two env
  vars; enable a pilot tenant + store + driver per `DELIVERY_RUNBOOK.md` §4 and
  smoke ingest → scan → `/track/<token>`; then the real decisions — Gesheft's
  order-source integration (blocked on them), SMS go-live (compliance), a real
  routing/geocoding provider, and PIN validation.
- ✅✅ **UPDATE 2026-08-25 NIGHT — THE LOOPCOM DRIVER APK EXISTS (`3544f2fa`),
  so the mobile half of the path-to-production is DONE as code.** A separate
  app (`com.loopcom.driver`, env-gated `CONNECT_DRIVER_APP=1` in
  build.gradle — ⛔ not productFlavors, the ship scripts pin the output
  paths), slim driver manifest (location+camera in, mic/telecom/FCM stripped),
  own entry `index.driver.js` (SIP never bundled — grep-proven in the APK).
  Start/End run now really drives `/mobile/delivery/tracking/start|end` +
  the foreground location task (`runTracking.ts`); map is a driver setting
  (in-app Leaflet/WebView map or Waze/Google/Apple handoff — `navPrefs.ts`).
  Artifact-verified build at `apps/mobile/dist/loopcom-driver-1.0.0+20260825-driver1.apk`,
  debug-signed like every sideload. ⏳ Never launched on a device; server env
  + pilot tenant + DriverProfile still unset. Full detail:
  `AGENT_HANDOFF_GESHEFT_POS_API_2026-08-25.md` §13–§13e.
- ✅✅ **UPDATE 2026-08-25 EVENING — GESHEFT'S POS API DOCS ARRIVED, so Phase 10 is
  no longer blocked on them.** Emailed by Gesheft Kosher; base
  `api.poswithlogic.dev` ("POS with Logic"), `x-api-key` auth, metered credits.
  Full intake: **`docs/ai-context/AGENT_HANDOFF_GESHEFT_POS_API_2026-08-25.md`**
  (⛔ the source file `C:\Users\izzyw\Documents\AD_Port` is an XPS printout with
  ZERO extractable text — PyMuPDF-render + read the pages; the printout is also
  incomplete, missing the auth/PIN/rate-limit sections). Beyond delivery ingest it
  offers phone-number→customer lookup, product catalog sync (`lastMod`), house
  balances + stored-card charges behind an `X-Customer-Pin` header, and a checkout
  payment webhook (their POS calls US to process payment — money, Izzy's call).
  ⛔ **The API only shows orders created with OUR key** — in-store orders are
  invisible; that question gates the delivery-ingest design. ⏳ No key exists and
  no request has ever been made. Possibilities report for Izzy:
  <https://claude.ai/code/artifact/f46069de-22fa-4b91-8f5d-a7709809e5f3>
