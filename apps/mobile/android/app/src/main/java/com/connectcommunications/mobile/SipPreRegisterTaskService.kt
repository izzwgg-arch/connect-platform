package com.connectcommunications.mobile

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * SipPreRegisterTaskService
 *
 * Boots a HeadlessJS task ("ConnectSipPreRegister", registered in
 * src/notifications/sipPreRegisterHeadlessTask.ts) during the ring of an
 * INCOMING_CALL push when the app is terminated / swiped away.
 *
 * Why
 * ---
 * In the fully-killed state no JavaScript runs during the ring — the native
 * IncomingCallFirebaseService posts the call UI but never boots React Native,
 * so the JsSIP UA can only register AFTER the user answers (which finally
 * launches MainActivity). That cold registration then waits several seconds for
 * the PBX to re-deliver the INVITE — the "very long time to connect" symptom.
 *
 * Started from IncomingCallFirebaseService.onMessageReceived (within the FCM
 * high-priority grant window, so a background service start is permitted), this
 * boots the JS engine during the ring and registers SIP on the shared singleton
 * client. On the old (bridge) architecture the HeadlessJS task and MainActivity
 * share ONE ReactInstanceManager / JS runtime, so the UA + INVITE this task
 * receives during the ring is the SAME client SipContext attaches to at answer
 * → the answer is instant.
 */
class SipPreRegisterTaskService : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        val extras = intent?.extras
        val data = if (extras != null) Arguments.fromBundle(extras) else Arguments.createMap()
        return HeadlessJsTaskConfig(
            "ConnectSipPreRegister",
            data,
            // Timeout must exceed the JS task's MAX_HOLD_MS (30s) so RN does not
            // tear the task down mid-ring; the JS side exits earlier when the
            // call is answered or canceled.
            35_000L,
            // allowedInForeground = true so it still runs if the app happens to
            // be foregrounded (the JS task no-ops fast when already registered).
            true,
        )
    }
}
