/**
 * backgroundCallTask.ts
 *
 * Registers a headless background-notification task via expo-task-manager.
 * This module MUST be imported at the very top of index.js (before
 * registerRootComponent) so the task is defined before React boots.
 *
 * Flow (INCOMING_CALL, data-only FCM from API):
 *   FCM data message → ExpoFirebaseMessagingService →
 *   Notifications.registerTaskAsync task → CallKeep.displayIncomingCall()
 *
 * No fallback notification: incoming calls must use native Telecom UI only.
 */

import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { logCallFlow } from '../debug/callFlowDebug';
import { flightBeginCall, flightRecord } from '../diagnostics/CallFlightRecorder';

export const BACKGROUND_NOTIFICATION_TASK = 'CONNECT_BACKGROUND_NOTIFICATION';

const LOG = '[CALL_INCOMING]';

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

/**
 * Cache file written by IncomingCallFirebaseService.java when it handles an
 * INCOMING_CALL push natively (calls TelecomManager.addNewIncomingCall directly).
 * The JS background task reads this to skip the duplicate displayIncomingCall
 * while still writing the invite to AsyncStorage so SIP can connect on answer.
 */
export const NATIVE_CALL_CACHE_FILE = 'pending_call_native.json';

/** Read the native call cache file written by IncomingCallFirebaseService.java. */
async function readNativeCallCache(): Promise<(Record<string, any> & { _nativeCallAdded?: boolean; _storedAt?: number }) | null> {
  try {
    const uri = FileSystem.cacheDirectory + NATIVE_CALL_CACHE_FILE;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri);
    return safeParse(raw);
  } catch {
    return null;
  }
}

/** Delete the native call cache file once consumed. */
async function deleteNativeCallCache(): Promise<void> {
  try {
    const uri = FileSystem.cacheDirectory + NATIVE_CALL_CACHE_FILE;
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // ignore
  }
}

/** Safe JSON.parse that never throws — returns null on any error. */
function safeParse(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** FCM delivers string values — normalize to a plain object for branching. */
function coerceDataMap(raw: Record<string, any> | undefined): Record<string, any> | null {
  if (!raw || typeof raw !== 'object') return null;

  // Expo wraps our payload inside a JSON "body" string at the FCM data level.
  // The FCM data map contains Expo envelope keys (experienceId, scopeKey, body, etc.)
  // and our actual app data is in raw.body as a JSON string. Parse and merge it.
  let base: Record<string, any> = { ...raw };
  if (typeof raw.body === 'string' && raw.body.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw.body);
      if (parsed && typeof parsed === 'object') {
        // Merge: body fields win over envelope keys so our data takes precedence.
        base = { ...base, ...parsed };
      }
    } catch {
      // not valid JSON — leave base as-is
    }
  }

  const out: Record<string, any> = { ...base };
  if (!out.inviteId && out.callId) out.inviteId = out.callId;
  if (!out.fromNumber && out.from) out.fromNumber = out.from;
  if (out.fromDisplay === '') out.fromDisplay = null;
  if (out.pbxCallId === '') out.pbxCallId = null;
  if (out.sipCallTarget === '') out.sipCallTarget = null;
  if (out.pbxSipUsername === '') out.pbxSipUsername = null;
  return out;
}

// ─── Task definition ──────────────────────────────────────────────────────────
// Must be called at module level — TaskManager requires this to run before the
// React component tree initialises.

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
  console.log(`${LOG} BG handler fired (task=${BACKGROUND_NOTIFICATION_TASK})`);
  logCallFlow('BACKGROUND_TASK_FIRED', { extra: { task: BACKGROUND_NOTIFICATION_TASK } });

  if (error) {
    console.warn(`${LOG} BG handler error from TaskManager:`, error.message);
    logCallFlow('BACKGROUND_TASK_ERROR', { extra: { message: error.message } });
    return;
  }

  try {
    const raw = data as any;
    console.log(`${LOG} raw task keys:`, raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw);

    const notification = raw?.notification as Notifications.Notification | undefined;
    const payload = coerceDataMap(
      (notification?.request?.content?.data as Record<string, any> | undefined) ??
        (notification?.request?.trigger as any)?.remoteMessage?.data ??
        (notification?.request?.trigger as any)?.payload ??
        (raw?.request?.content?.data as Record<string, any> | undefined) ??
        (raw?.data?.data as Record<string, any> | undefined) ??
        (raw?.data as Record<string, any> | undefined) ??
        (raw?.remoteMessage?.data as Record<string, any> | undefined),
    );

    if (!payload) {
      // FCM data wasn't accessible from the Expo notification object (common when
      // IncomingCallFirebaseService.java handles the push first). Fall back to the
      // native cache file the Java service writes synchronously in onMessageReceived.
      // This avoids a 2+ second getPendingInvites() network call later.
      console.warn(`${LOG} push received but payload is null/empty after normalization — trying native cache`);
      const nativeFallback = await readNativeCallCache();
      if (nativeFallback && nativeFallback.inviteId && nativeFallback.type === 'INCOMING_CALL') {
        console.log(`${LOG} native cache recovered payload inviteId=${nativeFallback.inviteId}`);
        // Write to AsyncStorage so resolveInviteForAction finds it instantly (no API call).
        await AsyncStorage.setItem(
          PENDING_CALL_STORAGE_KEY,
          JSON.stringify({
            inviteId: nativeFallback.inviteId,
            callId: nativeFallback.callId || nativeFallback.inviteId,
            pbxCallId: nativeFallback.pbxCallId || null,
            fromNumber: nativeFallback.fromNumber || null,
            fromDisplay: nativeFallback.fromDisplay || null,
            toExtension: nativeFallback.toExtension || null,
            tenantId: nativeFallback.tenantId || null,
            pbxSipUsername: nativeFallback.pbxSipUsername || null,
            sipCallTarget: nativeFallback.sipCallTarget || null,
            timestamp: nativeFallback.timestamp || new Date().toISOString(),
            _savedAt: Date.now(),
            _source: 'native_cache_fallback',
          }),
        ).catch(() => {});
        logCallFlow('BACKGROUND_TASK_PAYLOAD_RECOVERED_FROM_CACHE', {
          inviteId: String(nativeFallback.inviteId),
          pbxCallId: nativeFallback.pbxCallId ? String(nativeFallback.pbxCallId) : null,
          extension: nativeFallback.toExtension ? String(nativeFallback.toExtension) : null,
        });
      } else {
        console.warn(`${LOG} native cache also empty/null — cannot recover invite`);
      }
      return;
    }

    const type = String(payload.type ?? '');
    console.log(`${LOG} push received type=`, type, 'payloadKeys=', Object.keys(payload));

    if (type !== 'INCOMING_CALL') {
      if (type === 'INVITE_CANCELED' || type === 'INVITE_CLAIMED') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const RNCallKeep = require('react-native-callkeep').default;
          RNCallKeep.endCall(String(payload.inviteId || payload.callId || ''));
        } catch (e) {
          console.warn(`${LOG} CallKeep.endCall failed:`, e);
        }
        await AsyncStorage.removeItem(PENDING_CALL_STORAGE_KEY).catch(() => {});
      }
      return;
    }

    const inviteId = String(payload.inviteId || payload.callId || '');
    if (!inviteId) {
      console.warn(`${LOG} INCOMING_CALL missing inviteId/callId`);
      return;
    }

    logCallFlow('BACKGROUND_INCOMING_CALL_PAYLOAD_OK', {
      inviteId,
      pbxCallId: payload.pbxCallId ? String(payload.pbxCallId) : null,
      extension: payload.toExtension ? String(payload.toExtension) : null,
      extra: { nativeSkippedPath: Platform.OS === 'android' },
    });

    const now = Date.now();

    // Flight recorder: begin a call session from background push.
    // _active is set synchronously so PUSH_RECEIVED_BG is never lost.
    void flightBeginCall({
      inviteId,
      pbxCallId: payload.pbxCallId ? String(payload.pbxCallId) : null,
      fromNumber: payload.fromNumber ? String(payload.fromNumber) : null,
      extension: payload.toExtension ? String(payload.toExtension) : null,
    });
    flightRecord('PUSH', 'PUSH_RECEIVED_BG', {
      inviteId,
      pbxCallId: payload.pbxCallId ? String(payload.pbxCallId) : null,
      payload: {
        receivedAt: now,
        toExtension: payload.toExtension || null,
        fromNumber: payload.fromNumber || null,
        pushSource: 'expo_fcm',
        appState: 'background',
      },
    });

    // ── Check if the native Java handler already showed the call UI ───────
    // IncomingCallFirebaseService.java writes pending_call_native.json before
    // JS runs. If it already presented the full-screen incoming UI we skip
    // RNCallKeep to avoid a duplicate call screen, but still write to
    // AsyncStorage so SIP can connect.
    const nativeCache = await readNativeCallCache();
    const nativeFired =
      nativeCache?._nativeCallAdded === true &&
      nativeCache?.inviteId === inviteId &&
      typeof nativeCache._storedAt === 'number' &&
      now - nativeCache._storedAt < 60_000;

    if (nativeFired) {
      console.log(`${LOG} native Java handler already presented full-screen UI for ${inviteId} — skipping displayIncomingCall`);
      flightRecord('NATIVE', 'NATIVE_INCOMING_HANDLER_ENTERED', {
        inviteId,
        pbxCallId: payload.pbxCallId ? String(payload.pbxCallId) : null,
        payload: { nativeFired: true, nativeStoredAt: nativeCache?._storedAt },
      });
    }

    // ── Duplicate guard (JS-only path) ────────────────────────────────────
    const existing = safeParse(await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null));
    const existingAge = existing?._storedAt ? now - existing._storedAt : Infinity;
    const isDuplicate = !nativeFired && existing?.inviteId === inviteId && existingAge < 45_000;

    if (isDuplicate) {
      console.log(`${LOG} duplicate push for invite ${inviteId} — skipping displayIncomingCall`);
      return;
    }

    // ── Always write invite to AsyncStorage for SIP connection on answer ──
    await AsyncStorage.setItem(
      PENDING_CALL_STORAGE_KEY,
      JSON.stringify({
        ...payload,
        type: 'INCOMING_CALL',
        inviteId,
        _storedAt: now,
        _pushReceivedAt: now,
        _nativeCallAdded: nativeFired,
      }),
    ).catch(() => {});

    const prevWakeRaw = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
    const prevWakeEvents: any[] = safeParse(prevWakeRaw) ?? [];
    prevWakeEvents.push({
      type: 'INCOMING_PUSH_RECEIVED',
      inviteId,
      pbxCallId: payload.pbxCallId || null,
      toExtension: payload.toExtension || null,
      at: now,
      nativeFired,
    });
    await AsyncStorage.setItem(BG_WAKE_EVENTS_KEY, JSON.stringify(prevWakeEvents.slice(-10))).catch(() => {});

    // ── Only call displayIncomingCall when native handler did NOT fire ─────
    if (nativeFired) {
      prevWakeEvents.push({
        type: 'CALLKEEP_UI_SHOWN',
        inviteId,
        pbxCallId: payload.pbxCallId || null,
        toExtension: payload.toExtension || null,
        at: now,
        source: 'native_java',
      });
      await AsyncStorage.setItem(BG_WAKE_EVENTS_KEY, JSON.stringify(prevWakeEvents.slice(-10))).catch(() => {});
      console.log(`${LOG} invite ${inviteId} written to AsyncStorage; native UI already visible — done`);
      await deleteNativeCallCache();
      return;
    }

    // Android incoming UI is owned by IncomingCallFirebaseService + the in-app
    // screen. CallKeep.displayIncomingCall duplicated a legacy "floating" call
    // that did not dismiss reliably when answering from the real notification.
    if (Platform.OS === 'android') {
      console.log(
        `${LOG} Android: skipping CallKeep.displayIncomingCall (native/in-app incoming UI only) uuid=`,
        inviteId,
      );
      await deleteNativeCallCache().catch(() => undefined);
      return;
    }

    console.log(`${LOG} CallKeep.displayIncomingCall begin uuid=`, inviteId);

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
        },
      }).catch((e: unknown) => {
        console.warn(`${LOG} CallKeep.setup warning:`, e);
      });

      RNCallKeep.setAvailable(true);

      const handle = String(payload.fromDisplay || payload.fromNumber || payload.from || 'Unknown');
      RNCallKeep.displayIncomingCall(inviteId, handle, handle, 'number', false);

      const pendingRaw = await AsyncStorage.getItem(PENDING_CALL_STORAGE_KEY).catch(() => null);
      const pending = safeParse(pendingRaw) ?? {};
      await AsyncStorage.setItem(
        PENDING_CALL_STORAGE_KEY,
        JSON.stringify({ ...pending, _callkeepShownAt: Date.now() }),
      ).catch(() => {});
      const wakeRaw2 = await AsyncStorage.getItem(BG_WAKE_EVENTS_KEY).catch(() => null);
      const wakeEvents2: any[] = safeParse(wakeRaw2) ?? [];
      wakeEvents2.push({
        type: 'CALLKEEP_UI_SHOWN',
        inviteId,
        pbxCallId: payload.pbxCallId || null,
        toExtension: payload.toExtension || null,
        at: Date.now(),
        source: 'rncallkeep',
      });
      await AsyncStorage.setItem(BG_WAKE_EVENTS_KEY, JSON.stringify(wakeEvents2.slice(-10))).catch(() => {});

      console.log(`${LOG} CallKeep.displayIncomingCall done (native incoming UI should be visible)`);
      logCallFlow('CALLKEEP_DISPLAY_DONE', { inviteId, extra: { platform: 'ios', source: 'background_task' } });
    } catch (callkeepErr) {
      console.error(`${LOG} CallKeep.displayIncomingCall FAILED:`, callkeepErr);
      logCallFlow('CALLKEEP_DISPLAY_FAILED', {
        inviteId,
        extra: { message: callkeepErr instanceof Error ? callkeepErr.message : String(callkeepErr) },
      });
    }
  } catch (e) {
    console.error(`${LOG} BG handler unhandled exception:`, e);
  }
});

// ─── Register the task with expo-notifications ────────────────────────────────
Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK)
  .then(() => {
    console.log(`${LOG} registerTaskAsync OK (${BACKGROUND_NOTIFICATION_TASK})`);
  })
  .catch((e) => {
    if (!String(e?.message).includes('already registered')) {
      console.warn(`${LOG} registerTaskAsync failed:`, e?.message);
    } else {
      console.log(`${LOG} registerTaskAsync already registered`);
    }
  });
