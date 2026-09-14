# ⛔⛔ AGENT HANDOFF — Relax Tires 101 "vibrating, not ringing, no incoming-call screen" (2026-09-07): the ring reaches the phone in 0.5 s; the SCREEN stopped taking over on 08-31, and the handset's full-screen-notification permission is the only thing that launches it — READ FIRST for ANY "the app vibrates but shows no call screen", before blaming push delivery again, and before reading `UI_SHOWN.pushReceivedAt` as a push-receipt time

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_RELAX_TIRES_RING_SCREEN_2026-09-07.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**)
Memory: [[relax-tires-app-ring-is-a-client-side-question]] (round 5 appended).

- ⛔⛔ **THE VIRTUAL EXTENSION WAS NEVER IT.** The PBX dial key reads
  `PJSIP/T25_101&Local/T25_101_1@connect-mobile-wake-dial/n` (cell leg gone); on every call
  today the app leg was dialled `after 0s`, answered `180 Ringing` in the same second, and
  Google accepted the ring push **~0.9 s** after the invite row. **On the handset the native
  ringtone + vibration start ~0.5 s after the call** — proven by the app's own native-stamped
  `RINGTONE_START` in `CallFlightSession` (`IncomingCallUi.getRingtoneTimings()`). The
  vibration he feels IS Connect ringing him — on the phone's own default ringtone via
  `RingtoneManager` on `STREAM_RING` (his preference is "classic"); vibrate mode / ring
  volume is the phone's own ringer setting, exactly as for a carrier call.
- ⛔⛔ **WHAT STOPPED IS THE SCREEN TAKEOVER, AND IT STOPPED ON A DATE.** Ring-start →
  Connect-screen: **08-28: 2.9 / 3.5 / 3.5 / 5.5 s on 4 of 4 calls** (answers arrived via
  `onNewIntent` = the activity already existed = the full-screen launch had fired). **From
  08-31: 5–26 s, auto-launched on 0 of 21** — every screen followed a human action (tap the
  notification pill or open the app; `intent_answer:onCreate` = his tap CREATED the
  activity), then Answer ~1 s after the screen. Same APK, same device row, same dial string,
  same api ring path across that boundary — **the change is on the handset.**
- ⛔⛔ **THE ONLY CODE PATH THAT TAKES THE SCREEN IS ANDROID'S FULL-SCREEN INTENT**
  (`launchIncomingCallUi` → `setFullScreenIntent(...)`; `triggerFullScreenIntent()`'s own
  `PendingIntent.send()` from a service is a background activity start Android 14+ refuses),
  **and the OS honours it only when "Allow full screen notifications" (USE_FULL_SCREEN_INTENT
  special access) is ON for Loopcom and the phone is locked/screen-off.** Android's own doc:
  when it is OFF the notification is *"a persistent heads-up with pill buttons for 60 s in
  every device state"* — exactly the post-08-31 pattern. Sideloaded apps get it ON by default
  and **the user can switch it off**; the app nudges for it ONCE per install
  (`useFullScreenCallPermissionPrompt.ts`, `cc_fsi_onboard_prompted_v1`) and the Diagnostics
  screen shows it — ⛔ but **no screen in the shipped app navigates to `Diagnostics`**, and
  ⛔ **`canUseFullScreenIntent` / `lastIncomingUiPresentation` are NEVER uploaded** (the
  register payload sends only the keep-alive block). That toggle is the ONE fact this
  investigation cannot read from the server; the 30-second check is Settings →
  Notifications → Loopcom → *Allow full screen notifications* (expected OFF; turn ON), plus
  Battery = Unrestricted.
- ⛔⛔ **`UI_SHOWN.pushReceivedAt` IS A JS LAUNCH STAMP, NOT PUSH RECEIPT** —
  `NotificationsContext.tsx:501` sets `_pushReceivedAt: Date.now()` when the incoming-call
  URL is parsed at app boot. The 09-01 "Android delays the ring push 7.5–29 s" conclusion was
  built on that field and is **wrong for the ordinary call**; the honest device-side receipt
  times are the native cache `_storedAt` (`INCOMING_INVITE source: native_cache` →
  `nativeAge`) and `RINGTONE_START`, which read ~0.5–2 s.
- ⛔ **A SECOND, RARER MECHANISM IS REAL AND SEPARATE: the ring push itself held on-device
  for minutes.** 20:46Z today: the WAKE 15 s earlier was acked in **727 ms**, the SIP INVITE
  reached JS at +0.6 s (socket alive), Google accepted INCOMING_CALL at +0.9 s, **no native
  ring ever started**, and the push landed **165 s** later (TTL is 45 s, so it was held inside
  Google Play Services on the phone, not in transit) — the standby-bucket/Doze demotion the
  09-01 census describes. 1 of 8 calls today; 08-31 20:02/22:04 the same shape. The 09-02 wake
  gate fired (`WAKE_SUPPRESSED_DUPLICATE` ×2) but the watchdog still queued **247 wakes on
  09-05** while the phone sat unregistered all Shabbos (NORMAL priority now). **When this hits
  there is NO vibration** — it is not the complaint in the title.
- ⏳ **NOT BUILT (app build, Izzy's call):** upload `canUseFullScreenIntent`,
  `lastIncomingUiPresentation`, `areNotificationsEnabled`, channel importance,
  `batteryOptimizationIgnored` and ringer mode with every device register + stamp the
  presentation into the flight session; re-prompt for the permission while it is off (daily,
  not once per install) and show an in-app banner; link Diagnostics from Settings. Acceptance
  after the toggle: ring→screen ≈ 3 s again and answers via `onNewIntent` / in-app.
