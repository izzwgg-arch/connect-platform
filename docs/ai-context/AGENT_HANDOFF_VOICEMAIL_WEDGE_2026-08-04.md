# AGENT HANDOFF — Voicemail playback wedge / phantom Telecom call (2026-08-04)

Read this before touching voicemail playback, `ConnectIncomingConnection`,
`TelecomBridge`, the keepalive leak watchdog, or diagnosing any Android report
shaped like "audio shows playing but nothing plays until reinstall".

## The report

RSBK ext 101 (tenant `cmqtgxtwr1rhgmk130kw0ustz`, devices in
`HANDOFF_AUDIO_ROUTE_RSBK101.md` §Identifiers): "every little bit of time,
voicemails stop playing. Press play → it switches to playing, but it's not
playing and the wave is not progressing. Only reinstalling the APK fixes it."

## Root cause — the full chain (each link verified in code)

1. **Ghost ring**: `INVITE_CANCELED` push raced past its own `INCOMING_CALL`
   push (the Trimpro 2026-07-30 bug, fix `88d405a7` on `fix/ring-cancel-race`
   — which sat UNMERGED until this session). The device rings for a dead call.
2. **Answer flips a phantom ACTIVE**: tapping Answer runs
   `ConnectIncomingConnection.onAnswer()` → `setActive()` **before** JS learns
   the invite is dead. No SIP session ever exists to own the Connection's
   lifecycle, so nothing ever terminates it.
3. **Every safety net missed this exact shape**:
   - `terminateAnchorConnections` only kills `tc-anchor-*` (ring-time
     Connections use the real inviteId);
   - `nativeCallEndedCleanup` is gated to skip unconfirmed inbound legs;
   - `resetCallAudioStateIfIdle` **skips while any Connection is registered**
     — the phantom disarms the very watchdog built for this;
   - the 45s keepalive leak watchdog called `telecomTerminateAnchors` only.
4. **Android refuses media playback while it believes a call is live** →
   expo-av loads fine but never starts. `VoicemailTab` sets the playing state
   optimistically and swallowed the prewarmed-path play rejection
   (`warm.playAsync().catch(() => undefined)`) → pause icon + frozen waveform,
   zero errors anywhere.
5. **Only a process kill clears it**: `SipKeepAliveService` (FGS) keeps the
   process alive through recents-swipes, so reinstalling the APK was the only
   user action that worked. **Force stop in app settings is the equivalent
   two-tap workaround** — give that to any customer still on an old build.

Precedent: the same end-symptom was fixed 2026-07-29 for OUTBOUND legs only
("stuck TC@216, voicemails inaudible" — see the comment in `jssip.ts`'s
`session_ended` handler). This was the inbound twin.

## What shipped (all on `feat/ivr-migration-takeover`)

| Commit | What |
|---|---|
| `0cd7119b` | Merge of `fix/ring-cancel-race` (`88d405a7`): server per-pbxCallId ring/cancel serialization + cancel tombstones; Android 60s terminated-call memory in `IncomingCallFirebaseService`; JS dead-invite answer → "Caller hung up" |
| `065bce23` | Four backstops (below) |

The four backstops in `065bce23` — independent, so no single missed path can
ever wedge a phone again:

1. **Ring self-destruct** (`ConnectIncomingConnection.kt`): a non-anchor
   Connection still `STATE_RINGING` 120s after creation terminates itself as
   missed. No PBX ring runs that long.
2. **Stale-aware sweep** (`TelecomBridge.terminateStaleConnections`, exposed
   as `IncomingCallUiModule.telecomTerminateStale`): kills anchors + RINGING
   >90s + ACTIVE >30s + DISCONNECTED stragglers. ⛔ **Caller contract: only
   invoke after verifying ZERO live SIP sessions** — the age gates alone
   cannot tell a leaked ACTIVE ghost from a real hour-long call. The 45s
   keepalive leak watchdog in `jssip.ts` now prefers this over anchors-only
   (it already gates on `sessionsById.size === 0`).
3. **Dead-invite answer teardown** (`NotificationsContext.tsx`): both
   caller-gone paths from the merged fix now also call
   `terminateTelecomCall(invite.id, "canceled")` — `dismissNativeIncomingUi`
   only clears notification+ringtone, NOT the Connection the Answer tap
   flipped ACTIVE.
4. **Playback-stall watchdog** (`VoicemailTab.tsx`, `armStallWatchdog`): if
   the engine reports no progress ~2s after any play path starts, it runs the
   stale sweep + `resetCallAudioState` (gated on `hasActiveSipSession()`
   false), retries once, and only then reverts the UI with a real error.
   Logcat tags: `playback_stalled`, `playback_recovered`,
   `playback_stalled_final`, `prewarm_play_rejected` (no longer silent).

## Ship state

- **APK `1.0.0+20260804-202642`** (commit `065bce23`) built via
  `scripts/android-ship.ps1 -SkipJunction -SkipInstall` and **PUBLISHED**
  2026-08-05 to the download page (`connectcomms-latest.apk` promoted, public
  URL smoke-tested 200, 147,502,627 bytes).
- **Server half of `88d405a7`** (`apps/api/src/server.ts` ring/cancel
  serialization): ships with the api container deploy from this branch —
  verify with `docker inspect app-api-1 --format '{{index .Config.Labels
  "org.opencontainers.image.revision"}}'`; it must show `065bce23` or later.
- Pre-deploy state was container = `7f3c7970`, the exact parent of the merge —
  so this deploy ships ONLY the ring-cancel fix + backstops.

## Gotchas for the next agent

- ⛔ `telecomTerminateStale` is NOT a free-for-all cleanup: both existing call
  sites assert zero live SIP sessions immediately before calling. A third call
  site must do the same or it can kill a real call's Connection.
- The stall watchdog's self-heal deliberately does nothing while a SIP session
  is live (a real call legitimately blocks media audio).
- `ConnectIncomingConnection.activeAtMs` is now `private set` (read by the
  sweep); `createdAtMs` is stamped at construction. Don't remove either.
- Old builds in the field still wedge; the fleet heals as devices update from
  the download page. Interim customer advice: Settings → Apps → Connect →
  Force stop, reopen.
- Diagnosis-time gap that made this invisible remotely: `[VOICEMAIL_AUDIO]`
  and `[audio_route]` logs are logcat-only, and `MobileDevice.appVersion` is
  stuck at `"1.0.0"` for every Android device (register payload sends the
  static Expo config version). Both are still open items — see
  `HANDOFF_AUDIO_ROUTE_RSBK101.md` §Recommended next steps.
