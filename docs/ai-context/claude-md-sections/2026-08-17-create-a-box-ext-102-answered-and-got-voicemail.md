# ⛔ AGENT HANDOFF — Create A Box ext 102 answered and got voicemail AGAIN, because his phone is 8 days behind (2026-08-17) — READ FIRST before investigating ANY "I answered and nothing happened" on a mobile app, and before opening a call-path investigation on any extension

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


⛔⛔ **SUPERSEDED 2026-08-23 — THE RECOMMENDATION IN THIS SECTION ("get him onto the
current APK") IS NOW THE THING THAT BREAKS HIM.** He installed it and every answer
failed; see the warm-answer-deadline section above. Keep this section only for the
network backdrop and the query notes.

Full handoff: **`docs/ai-context/AGENT_HANDOFF_ANSWER_UNACKED_PUSH_CHANNEL_2026-08-06.md` §9**
(**Read-only investigation — no code, no deploy, no PBX write, no data change.**)
Memory: [[warm-answer-deadline-regression]].

- ⛔⛔ **CHECK THE INSTALLED APP VERSION BEFORE DIAGNOSING ANYTHING.** Sender Weiss
  (ext 102) runs **`1.0.0+20260804-202642`**; the published APK is
  **`1.0.0+20260812-215020`** (2026-08-13), whose own release note reads *"Answering a
  call retries instead of dying silently"* — that IS the `c55ae840` bounded-retry +
  `answer_unacked` rescue. §8 of that handoff said those mobile fixes were "on NO
  phone"; they shipped, **his phone was never updated**. The recommendation is an APK
  install, not engineering.
- **It recurred today, 16:47 ET, on a real customer call:** he tapped Answer,
  received **0 audio packets** for 10 s, hung up — while Asterisk logged
  *"Nobody picked up in 30000 ms"* → voicemail. `Endpoint T7_102_1 is now Unreachable`
  8 s after the tap; contact removed 28 s later. Identical to 2026-08-05.
- ⛔ **THE CDR LIES ABOUT WHO ANSWERED — use the PBX `app_dial.c … answered` line.**
  That lost call is stored `disposition: answered, talk=63s` — which is the **IVR plus
  voicemail** answering, not a human. ⛔ And an inbound CDR carries **both** legs
  (`PJSIP/T7_102_1-…` app, `PJSIP/T7_102-…` desk) because the PBX rings both, so the
  app leg's presence proves it was **rung**, never that it **answered**.
- **Today: 5 inbound — app answered 1** (quality **poor**, 8.34 % loss, 186 packets, on
  T-Mobile), **desk answered 2, 2 lost to voicemail**; all **8 outbound came off the
  desk phone**. Three voicemails on ext 102 sit **UNHEARD**, one from the lost 16:47 call.
- ⛔ **The app endpoint had no live contact for 93 minutes today — 8.9 % of the day**,
  across **27 gaps of ≥30 s** (many 3–6 min) plus 25 sub-30 s blips; 137 REGISTERED /
  118 UNREGISTERED in one day. **A call in any ≥30 s gap cannot ring the app** — that is
  precisely how the 11:46 call was lost (app offline 11:43:40→11:47:44).
- ⛔ **He roamed 14 source IPs today** — T-Mobile CGNAT (`172.56.x`/`172.59.x`), two
  fixed lines, and **`45.14.194.179` = loopcom, i.e. the office GL.iNet → WireGuard
  tunnel**. ⛔⛔ **Create A Box is NOT on the 443 SIP route** (`webrtcRouteViaSbc: false`,
  `sipWsUrl` still `wss://m.connectcomunications.com:8089/ws`), so a loopcom contact IP
  on THIS tenant means the **office tunnel** — do not read it the way you would for
  Gesheft / Displaydex / inii mini / B Visible / Loopcom Demo. **Both networks hurt him
  today**: T-Mobile gave the 8.34 % loss, the tunnel gave the dead answer.
- ⛔ **Do NOT reflexively move this tenant to 443** — it would route his SIP through
  France deliberately, and his contact RTT through the tunnel is already **305 ms**
  (desk 237 ms). Izzy's call, on evidence.
- ✅ **Superseded good news:** he IS on the fast direct-FCM push channel now — a NEW
  `MobileDevice` row `cmsgbqocr0hbrtd136dxshbsf` carries `nativeFcmToken`. ⛔ **Order his
  devices by `updatedAt` and read the newest**; the old `cmr9epohm0db5pe13ib1hmur5` row
  still reads `hasFcm: false` and reproduces the stale 2026-08-05 conclusion.
- **Field traps:** `ConnectCdr` uses **`durationSec`/`talkSec`** (not `…Seconds`);
  `Voicemail` uses **`callerNumber`/`durationSec`/`listened`** (not
  `callerId`/`durationSeconds`/`readAt`).
- ⏳ **NOT DONE:** nobody has told Sender to update the app, and the office's internet
  (T-Mobile cellular behind the GL.iNet box) is unchanged — the long-term cure is still
  **real wired internet at that office**.
