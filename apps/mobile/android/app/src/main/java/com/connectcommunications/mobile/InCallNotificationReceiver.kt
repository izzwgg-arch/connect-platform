package com.connectcommunications.mobile

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Manifest-registered BroadcastReceiver that runs in the MAIN process (no
 * android:process attribute in AndroidManifest.xml).
 *
 * Why this exists
 * ---------------
 * SipKeepAliveService lives in the :keepalive process. When the user taps
 * "Hang Up" in the in-call notification, the original code sent a broadcast
 * that was received by a dynamically-registered BroadcastReceiver *inside*
 * :keepalive, then tried to call IncomingCallUiModule.emitInCallAction("hangup").
 * That call silently fails because IncomingCallUiModule only has a
 * ReactApplicationContext in the MAIN process (where the React bridge lives).
 * JS therefore never received the "hangup" event, so JsSIP never sent BYE,
 * so the session never terminated, so the notification never cleared.
 *
 * Fix
 * ---
 * The "Hang Up" PendingIntent now uses PendingIntent.getService() with
 * ACTION_NOTIF_HANGUP_SVC. The service receives it in onStartCommand and:
 *   1. Clears inCall + stopForeground(REMOVE) + cancel 4242 IMMEDIATELY.
 *   2. Sends NOTIF_ACTION_HANGUP_RELAY broadcast which reaches THIS receiver
 *      in the MAIN process.
 * This receiver then calls emitInCallAction("hangup") which succeeds because
 * lastReactContext is set in the main process.
 *
 * Security
 * --------
 * android:exported="false" in the manifest — only the app itself can send
 * to this receiver. The setPackage(packageName) call in the service also
 * restricts delivery to this package.
 */
class InCallNotificationReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "InCallNotifReceiver"
    private const val NOTIFICATION_ID = 4242
  }

  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      SipKeepAliveService.NOTIF_ACTION_HANGUP_RELAY -> {
        Log.i(TAG, "NOTIF_ACTION_HANGUP_RELAY received in main process — emitting hangup to JS")
        // Belt-and-suspenders: cancel notification directly from the main process
        // in case the service-side clearInCallForeground() was somehow delayed.
        try {
          (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
            ?.cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {}
        // Notify JS so it can call session.terminate() and send SIP BYE.
        // If the React bridge is not yet up (cold-start edge case), this logs a
        // warning and returns — acceptable because the notification is already cleared.
        try {
          IncomingCallUiModule.emitInCallAction("hangup")
          Log.i(TAG, "[CONNECT_CALL_UI] hangup_relayed_to_js")
        } catch (t: Throwable) {
          Log.w(TAG, "emitInCallAction(hangup) failed: ${t.message}")
        }
      }
    }
  }
}
