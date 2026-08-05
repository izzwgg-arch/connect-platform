package com.connectcommunications.mobile

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge to dismiss the native incoming-call notification and stop the
 * native ringtone immediately when Answer/Decline is handled in JavaScript.
 */
class IncomingCallUiModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "IncomingCallUi"

  @ReactMethod
  fun dismiss(inviteId: String?) {
    IncomingCallFirebaseService.dismissIncomingCallUi(
      reactApplicationContext,
      inviteId,
      "js_incoming_call_ui_dismiss",
    )
  }

  @ReactMethod
  fun stopRingtone() {
    IncomingCallFirebaseService.stopIncomingCallRingtone("js_stop_ringtone")
  }

  /** Clears show-when-locked / turn-screen-on after a call so hangup does not leave a blank stage. */
  @ReactMethod
  fun clearLockScreenCallPresentation() {
    val activity = reactApplicationContext.currentActivity as? MainActivity ?: return
    activity.runOnUiThread {
      MainActivity.clearIncomingCallWindowFlags(activity)
    }
  }
}
