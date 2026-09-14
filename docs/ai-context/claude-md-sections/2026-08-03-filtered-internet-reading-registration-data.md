# ⛔ AGENT HANDOFF — filtered internet + reading registration data (2026-08-03) — READ FIRST for any "phone drops / didn't ring" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FILTERED_INTERNET_2026-08-03.md`**

- ⛔ **Content-filtering internet is the NORM across Connect's user base** (confirmed by
  Izzy 2026-08-03), not an edge case. Assume a filter is in the path until disproven.
- **The one command that settles it:** take the device's contact IP from
  `PbxEndpointRegistrationEvent.contactUri` and **`whois` it**. Datacenter/colo block =
  filtering proxy. Residential ISP = their line. Cellular carrier = genuinely moving.
  Luxure ext 101 on 2026-08-02: **128 of 129 registrations came through one filter**
  (Cologuard `192.157.80.0/20`, Old Bridge NJ) rotating across six addresses; exactly
  **one** went direct over his real ISP. "Unstable Wi-Fi" and "the tablet leaves the
  house" were both concluded — and both wrong — before the whois was run.
  ⛔ **This test only works while the device registers DIRECTLY to the PBX.** Once a
  tenant is flipped to the 443 route (`webrtcRouteViaSbc=true`), every `contactUri`
  becomes loopcom `45.14.194.179` and the whois tells you nothing about the customer —
  use loopcom nginx logs instead. Check the tenant's routing flag before trusting a
  contact IP. See the Eli iOS 443 handoff above.
- ⛔ **Never report a raw reconnect count as instability. Split it first.** 80 of 128
  reconnects were **under 5 seconds** (lease renewal, invisible to callers); only 33 were
  ≥30 s. 55 sessions sat at a clean **~840 s / 14-minute metronome — a fixed interval is a
  timer, not weather.** Real outages arrive in *clusters* (proxy); a moving device gives
  isolated single drops.
- **The wake-and-wait work (`PLAN_PUSH_AND_WAIT_SIMON.md` Phase 3) is CONFIRMED WORKING** —
  wake→ready measured **0.9 s / 2.0 s / 0.2 s** vs the original 28 s, and the endpoint was
  already REGISTERED at all five calls. **The transport is the bottleneck now, not the wake.**
- **The 443 fix is NO LONGER A PROPOSAL — it shipped for Displaydex on 2026-08-05** via
  nginx `location /sip` on loopcom + `webrtcRouteViaSbc=true, sipWsUrl=null`. Luxure is a
  copy-the-recipe job now, not a design job. ⛔ The app never refreshes a cached
  `sipWsUrl`, so the user must sign out/in after the flip.
- Remaining open items: a **241 ms `ANSWER_TAPPED {DECLINE}`** that no human could
  produce; `UI_SHOWN` **3.75 s** after the invite (and absent entirely on another call);
  **outbound app calls produce no `ConnectCdr` row**; voicemail ingest wrote nothing Aug 1–3.
- ⛔ Ext 104 dials Simon's cell but **nothing routes to it — that is deliberate, per Izzy.
  Do not add it to a ring group.**
