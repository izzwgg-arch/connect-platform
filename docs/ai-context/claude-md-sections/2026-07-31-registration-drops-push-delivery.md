# ⛔ AGENT HANDOFF — registration drops & push delivery (2026-07-31) — READ FIRST for any "calls don't ring" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_REGISTRATION_PUSH_2026-07-31.md`**

- **Before diagnosing ANY "extension doesn't ring" report, pull the 10-day
  `PbxEndpointRegistrationEvent` history first** (exact query in the handoff §1).
  Diagnosing from a single day produced the wrong root cause and a wasted fix round.
  A healthy device shows ~1200 REGISTERED events per 10 days; Luxure T5_101_1 showed 153.
- **The Expo→direct-FCM migration is HALF DONE.** `apps/api` has `fcmDirect.ts`;
  **`apps/worker` has none** and pushes every call ring / wake / cancel over the Expo
  relay. Only **6 of 16** active Android devices have a `nativeFcmToken`, so the other
  10 fall back to the relay even from the API. Keep `expo-notifications` the library
  (that is how the FCM token is obtained); eliminate `exp.host` sends.
- A device that ignores a **direct-FCM** wake is powered off / force-stopped / in
  Samsung "Deep sleeping apps" — **no server or app code can revive it.** Stop
  engineering and check the physical device.
- Live in prod (`cdd5bbdd`): device-registration watchdog sends recovery wake pushes,
  and ALL alerts email `tod10950@gmail.com`.
