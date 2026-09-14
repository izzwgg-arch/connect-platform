# ⛔ AGENT HANDOFF — iOS CallKit zombie call + TestFlight release (2026-08-02) — READ FIRST for iOS call teardown or any EAS build

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_IOS_CALLKIT_TESTFLIGHT_2026-08-02.md`**

- **iOS build 44 (`3d8103af…`, commit `695a53e6`) is VERIFIED ON DEVICE by Izzy.**
  Its twin **build 45** (`27387fbe…`, commit `ecb6071f`, ios-prod) is on TestFlight,
  beta review **APPROVED**, live to the external group "Loopcom Testers".
- **Any deferred call action must re-verify its precondition at FIRE time.** The
  12s deferred decline from build 43 outlived the answer and declined a CONNECTED
  call (proven twice in `voiceDiagEvent`); a ring rejection cannot tear down a
  confirmed dialog, so the SIP session AND the CallKit call both survived → stuck
  green pill + a lock-screen call that had to be hung up by hand. Fixed `4640a04d`.
- **`sip.callState` inside the CallKeep handlers is a STALE render closure.** Ground
  liveness checks in the module-scope SIP singleton (`confirmedAtMs != null`) or refs.
- `nativeCallEndedCleanup` was Android-only — iOS had **no last-session-ended safety
  net** at all. It now ends orphaned CallKit calls, re-verifying no session is live
  after a 1.2s settle.
- ⛔ **`EAS_NO_VCS=1` uploads the WORKING TREE, not the commit — a green EAS build is
  NOT proof the committed tree builds.** A stale `pnpm-lock.yaml` (declared 4
  `patchedDependencies`, locked 1) made every clean checkout unbuildable; fixed
  `0e5207d7`. Re-lock whenever patches change.
- EAS build logs are **brotli**, not gzip. Poll builds by **explicit id**, never
  "newest" — that misreads the previous build and reports phantom failures.
