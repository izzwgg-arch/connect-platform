/**
 * backgroundCallTask.ts
 *
 * Registers a headless background-notification task via expo-task-manager.
 * This module MUST be imported at the very top of index.js (before
 * registerRootComponent) so the task is defined before React boots.
 *
 * What this solves:
 *   When the app is FULLY TERMINATED and a push arrives, Android wakes a
 *   headless JS context and executes this task. The task calls
 *   RNCallKeep.displayIncomingCall() which shows the native full-screen
 *   incoming-call UI using Android's Telecom API — no app-open required.
 *
 * Flow:
 *   FCM high-priority push → Android OS wakes headless JS →
 *   this task fires → CallKeep shows native call screen →
 *   user taps Answer → Android brings app to foreground →
 *   NotificationsContext cold-start path handles the rest.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const BACKGROUND_NOTIFICATION_TASK = 'CONNECT_BACKGROUND_NOTIFICATION';

/**
 * AsyncStorage key where the background task stores the incoming invite
 * payload so the foregrounded app can read it immediately on cold start
 * without waiting for getPendingInvites() to resolve.
 */
export const PENDING_CALL_STORAGE_KEY = 'connect_pending_call_invite';

/**
 * AsyncStorage key used to record wake events (push received while terminated)
 * so NotificationsContext can emit PUSH_RECEIVED telemetry once it has an
 * auth token.
 */
export const BG_WAKE_EVENTS_KEY = 'connect_bg_wake_events';

/** Safe JSON.parse that never throws — returns null on any error. */
function safeParse(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Task definition ──────────────────────────────────────────────────────────
// Must be called at module level — TaskManager requires this to run before the
// React component tree initialises.

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[BGTask] Error in background notification task:', error.message);
    return;
  }

  try {
    const notification = (data as any)?.notification as Notifications.Notification | undefined;
    const payload = notification?.request?.content?.data as Record<string, any> | undefined;

    if (!payload?.type) return;

    const now = Date.now();

    if (payload.type === 'INCOMING_CALL') {
      const inviteId = String(payload.inviteId || '');
      if (!inviteId) return;

      // ── Duplicate guard ───────────────────────────────────────────────────
      // If the same inviteId is already stored and recent, skip calling
      // displayIncomingCall again. This prevents a retry push (FCM may retry
      // unacknowledged high-priority messages) from showing two native call UIs.
      const existing = safeParse(await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null));
      const existingAge = existing?._storedAt ? now - existing._storedAt : Infinity;
      const isDuplicate = existing?.inviteId === inviteId && existingAge < 45_000;

      if (isDuplicate) {
        console.log('[BGTask] Duplicate push for invite', inviteId, '— skipping displayIncomingCall');
        return;
      }

      // ── Persist invite data with timing ──────────────────────────────────
      await AsyncStorage.setItem(
        PENDING_CALL_STORAGE_KEY,
        JSON.stringify({
          ...payload,
          _storedAt: now,
          _pushReceivedAt: now,   // Timing anchor: when push was received
        }),
      ).catch(() => {});

      // ── Record wake event for deferred telemetry ──────────────────────────
      // We can't POST to the API here (no auth token in headless context), so
      // we accumulate wake events in AsyncStorage and flush them in
      // NotificationsContext once it has a token.
      const prevWakeRaw = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
      const prevWakeEvents: any[] = safeParse(prevWakeRaw) ?? [];
      prevWakeEvents.push({
        type: 'APP_WAKE',
        inviteId,
        at: now,
      });
      await AsyncStorage.setItem(
        BG_WAKE_EVENTS_KEY,
        JSON.stringify(prevWakeEvents.slice(-10)),
      ).catch(() => {});

      // ── Show native incoming-call screen via Android Telecom API ──────────
      // CallKeep.displayIncomingCall uses TelecomManager.addNewIncomingCall()
      // which fires a full-screen intent even when the app is fully killed.
      // The phone account persists from the first time the user opened the app;
      // setup() here is a fast no-op if the account is already registered.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const RNCallKeep = require('react-native-callkeep').default;

        await RNCallKeep.setup({
          ios: { appName: 'Connect Communications', supportsVideo: false },
          android: {
            alertTitle: 'Phone account permission',
            alertDescription: 'This app needs phone account access to show incoming call UI.',
            cancelButton: 'Cancel',
            okButton: 'ok',
            foregroundService: {
              channelId: 'connect-calls',
              channelName: 'Incoming calls',
              notificationTitle: 'Connect call service',
            },
          },
        }).catch(() => {});

        RNCallKeep.setAvailable(true);

        // displayIncomingCall(uuid, handle, localizedCallerName, handleType, hasVideo)
        RNCallKeep.displayIncomingCall(
          inviteId,
          payload.fromDisplay || payload.fromNumber || 'Unknown',
          payload.fromDisplay || payload.fromNumber || 'Unknown',
          'number',
          false,
        );

        // Record the exact timestamp CallKeep was shown for latency tracking
        await AsyncStorage.mergeItem(
          PENDING_CALL_STORAGE_KEY,
          JSON.stringify({ _callkeepShownAt: Date.now() }),
        ).catch(() => {});

        console.log('[BGTask] displayIncomingCall fired for invite:', inviteId);
      } catch (callkeepErr) {
        console.warn('[BGTask] CallKeep displayIncomingCall failed:', callkeepErr);
        // Fallback: the system notification is still visible in the tray.
        // User can tap it to open the app, which picks up the invite via
        // AsyncStorage cache or getPendingInvites().
      }

    } else if (payload.type === 'INVITE_CANCELED' || payload.type === 'INVITE_CLAIMED') {
      // ── Cancel native call screen ─────────────────────────────────────────
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const RNCallKeep = require('react-native-callkeep').default;
        RNCallKeep.endCall(String(payload.inviteId || ''));
      } catch {}

      // Remove cached invite so cold-start doesn't resurrect a dead call
      await AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
    }
  } catch (e) {
    console.warn('[BGTask] Unhandled error:', e);
  }
});

// ─── Register the task with expo-notifications ────────────────────────────────
// This tells expo-notifications to run BACKGROUND_NOTIFICATION_TASK whenever
// a notification arrives and the app is in the background or killed.
Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch((e) => {
  if (!String(e?.message).includes('already registered')) {
    console.warn('[BGTask] registerTaskAsync failed:', e?.message);
  }
});
