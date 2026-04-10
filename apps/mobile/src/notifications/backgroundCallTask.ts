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
 * AsyncStorage key used to record that the background task woke the app
 * so NotificationsContext can emit a PUSH_RECEIVED telemetry event after
 * it has an auth token.
 */
export const BG_WAKE_EVENTS_KEY = 'connect_bg_wake_events';

// ─── Task definition ──────────────────────────────────────────────────────────
// Must be called at module level — TaskManager requires this to run before the
// React component tree initialises.

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[BGTask] Error in background notification task:', error.message);
    return;
  }

  try {
    // expo-notifications passes the notification inside `data.notification`
    const notification = (data as any)?.notification as Notifications.Notification | undefined;
    const payload = notification?.request?.content?.data as Record<string, any> | undefined;

    if (!payload?.type) return;

    const now = Date.now();

    if (payload.type === 'INCOMING_CALL') {
      // ── Persist invite data ───────────────────────────────────────────────
      // Stored before showing CallKeep UI so the foreground app can read it
      // synchronously on cold start without hitting the API first.
      await AsyncStorage.setItem(
        PENDING_CALL_STORAGE_KEY,
        JSON.stringify({ ...payload, _storedAt: now }),
      ).catch(() => {});

      // ── Record wake event for deferred telemetry ──────────────────────────
      const wakeRaw = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
      const wakeEvents: any[] = wakeRaw ? JSON.parse(wakeRaw).catch?.(() => []) ?? [] : [];
      wakeEvents.push({
        type: 'APP_WAKE',
        inviteId: payload.inviteId,
        at: now,
      });
      await AsyncStorage.setItem(BG_WAKE_EVENTS_KEY, JSON.stringify(wakeEvents.slice(-10))).catch(() => {});

      // ── Show native incoming-call screen via Android Telecom API ──────────
      // CallKeep.displayIncomingCall uses TelecomManager.addNewIncomingCall()
      // which fires a full-screen intent even when the app is fully killed.
      // The phone account was registered the first time the user opened the
      // app; subsequent background calls don't need UI for setup().
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const RNCallKeep = require('react-native-callkeep').default;

        // Re-setup in background context (fast no-op if account already registered)
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
          payload.inviteId,
          payload.fromDisplay || payload.fromNumber || 'Unknown',
          payload.fromDisplay || payload.fromNumber || 'Unknown',
          'number',
          false,
        );

        console.log('[BGTask] displayIncomingCall fired for invite:', payload.inviteId);
      } catch (callkeepErr) {
        console.warn('[BGTask] CallKeep displayIncomingCall failed:', callkeepErr);
        // CallKeep failed — the system notification is still visible in the
        // notification tray as a fallback (we always send title+body in push).
      }

    } else if (payload.type === 'INVITE_CANCELED' || payload.type === 'INVITE_CLAIMED') {
      // ── Cancel the native call screen if it's showing ────────────────────
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const RNCallKeep = require('react-native-callkeep').default;
        RNCallKeep.endCall(payload.inviteId);
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
// Called here (module level) rather than inside a React component so it
// executes exactly once during the headless JS context setup.
Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK).catch((e) => {
  // Throws if the task is already registered (safe to ignore on subsequent boots)
  if (!String(e?.message).includes('already registered')) {
    console.warn('[BGTask] registerTaskAsync failed:', e?.message);
  }
});
