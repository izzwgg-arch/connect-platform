package com.connectcommunications.mobile

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowManager

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  companion object {
    private const val TAG = "ConnectMainActivity"

    /**
     * True while this activity is in the resumed portion of its lifecycle.
     * Used from [IncomingCallFirebaseService] because FCM often runs with the
     * process marked IMPORTANCE_FOREGROUND even when the user has not opened
     * the app — that must still use the native incoming-call + ringtone path.
     */
    @Volatile
    private var hostActivityResumed: Boolean = false

    @JvmStatic
    fun isHostResumedForIncoming(): Boolean = hostActivityResumed

    @JvmStatic
    fun clearIncomingCallWindowFlags(activity: MainActivity) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(false)
          activity.setTurnScreenOn(false)
        } else {
          @Suppress("DEPRECATION")
          activity.window.clearFlags(
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
              WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
          )
        }
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Stale deep links otherwise re-apply lock-screen presentation on every resume.
        activity.intent?.removeExtra("connect_show_incoming_call")
      } catch (_: Exception) {
      }
    }
  }

  override fun onResume() {
    super.onResume()
    hostActivityResumed = true
  }

  override fun onPause() {
    hostActivityResumed = false
    super.onPause()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    dismissIncomingCallFromIntent(intent, "onCreate")
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    applyIncomingCallWindowFlags(intent)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    setIntent(intent)
    dismissIncomingCallFromIntent(intent, "onNewIntent")
    applyIncomingCallWindowFlags(intent)
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }

  /**
   * Answer/Decline from the notification must stop ringtone + remove shade immediately.
   * "open" must NOT stop ringtone — JS / user actions stop it once the in-app UI owns audio.
   */
  private fun dismissIncomingCallFromIntent(intent: Intent?, source: String) {
    val data = intent?.data ?: return
    if (data.scheme != "com.connectcommunications.mobile") return
    if (data.host != "incoming-call") return
    val action = data.getQueryParameter("action") ?: return
    if (action != "answer" && action != "decline") return
    val inviteId =
      data.getQueryParameter("inviteId")
        ?: data.getQueryParameter("callId")
        ?: intent.getStringExtra("inviteId")
    IncomingCallFirebaseService.dismissIncomingCallUi(this, inviteId, "intent_$action:$source")
    intent?.removeExtra("connect_show_incoming_call")
  }

  private fun applyIncomingCallWindowFlags(intent: Intent?) {
    val showIncomingCall = intent?.getBooleanExtra("connect_show_incoming_call", false) == true
    val inviteId = intent?.getStringExtra("inviteId")
    if (showIncomingCall) {
      val action = intent?.data?.getQueryParameter("action") ?: "open"
      if (action == "answer" || action == "decline") {
        // Notification answer/decline: dismiss ran first — do not lock the activity on top of ActiveCall.
        clearIncomingCallWindowFlags(this)
        return
      } else {
        // Remove the ongoing notification but keep ringing until the in-app screen stops audio.
        IncomingCallFirebaseService.cancelIncomingCallNotificationOnly(this, inviteId)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        setShowWhenLocked(true)
        setTurnScreenOn(true)
      } else {
        @Suppress("DEPRECATION")
        window.addFlags(
          WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        )
      }
      window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      Log.i(TAG, "[CALL_INCOMING] applied lock-screen window flags without keyguard dismissal")
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(false)
      setTurnScreenOn(false)
    } else {
      @Suppress("DEPRECATION")
      window.clearFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
          WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or
          WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
      )
    }
    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}
