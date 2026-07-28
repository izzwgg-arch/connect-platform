import { DeviceEventEmitter, Platform } from "react-native";

import { getSipClient } from "./sipClientSingleton";

/**
 * Module-scope handler for the in-call notification action buttons
 * (End / Speaker / Mute), i.e. "Sip.InCallNotificationAction" events emitted
 * by IncomingCallUiModule.emitInCallAction.
 *
 * Why module scope and not SipContext
 * -----------------------------------
 * A recents-swipe destroys MainActivity, and ReactDelegate.onHostDestroy
 * unmounts the whole React tree — including SipContext and every
 * DeviceEventEmitter listener it registered. The SIP call itself survives
 * (the JsSIP client is a module singleton and WebRTC media runs on native
 * threads), so the user is left with a live call whose notification buttons
 * emit events NOBODY is listening to (live failure 2026-07-28 08:10: "when I
 * swipe away the app, I press hang up, the call does not hang up").
 *
 * This listener lives at module scope — installed when sipClientSingleton is
 * first imported (headless boot and app boot both hit it) — so it keeps
 * working after the tree unmounts.
 *
 * Division of labor with SipContext's own listener:
 *   - THIS module performs the actual call control (hangup / speaker / mute)
 *     against the singleton client. All three are idempotent value-setters.
 *   - SipContext's listener only mirrors the change into React state so the
 *     in-app UI reflects it while mounted. It does NOT call the client.
 */
let installed = false;

export function installInCallNotificationActions(): void {
  if (installed) return;
  if (Platform.OS !== "android") return;
  installed = true;
  DeviceEventEmitter.addListener(
    "Sip.InCallNotificationAction",
    (evt: { action?: string; value?: boolean }) => {
      const action = evt?.action;
      const value = typeof evt?.value === "boolean" ? evt.value : undefined;
      console.log(
        "[IN_CALL_NOTIF] module-scope action",
        JSON.stringify({ action, value }),
      );
      try {
        const client = getSipClient();
        switch (action) {
          case "hangup": {
            void client.hangup().catch((err) => {
              console.warn(
                "[IN_CALL_NOTIF] module-scope hangup failed:",
                err instanceof Error ? err.message : String(err),
              );
            });
            break;
          }
          case "toggle_speaker": {
            // Native always sends the target value (it flipped its own
            // snapshot first); default to ON if it ever arrives without one.
            client.setSpeaker(value ?? true);
            break;
          }
          case "toggle_mute": {
            client.setMute(value ?? true);
            break;
          }
        }
      } catch (e) {
        console.warn(
          "[IN_CALL_NOTIF] module-scope action failed:",
          e instanceof Error ? e.message : String(e),
        );
      }
    },
  );
  console.log("[IN_CALL_NOTIF] module-scope action listener installed");
}
