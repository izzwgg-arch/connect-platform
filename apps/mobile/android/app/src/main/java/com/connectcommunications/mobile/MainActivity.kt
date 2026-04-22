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

    /**
     * True if the most recent activity start / resume was triggered by the
     * incoming-call PendingIntent (i.e. the user came TO the app from the
     * lock-screen / notification full-screen surface, not from the launcher).
     *
     * KeyguardManager.isKeyguardLocked() is unreliable on Samsung One UI when
     * showWhenLocked=true: once MainActivity surfaces above the keyguard, the
     * KeyguardManager reports unlocked even though the keyguard is still
     * present. We therefore can't use it to decide whether to moveTaskToBack
     * after hangup. This flag is the authoritative signal.
     *
     * Set in [applyIncomingCallWindowFlags] when showIncomingCall=true.
     * Read + cleared in [IncomingCallUiModule.consumeLaunchedFromIncomingCall].
     */
    @Volatile
    var launchedFromIncomingCall: Boolean = false

    /**
     * Clears the per-window FLAG_KEEP_SCREEN_ON set for an active call.
     *
     * IMPORTANT: show-when-locked and turn-screen-on are declared STATICALLY
     * in AndroidManifest.xml (android:showWhenLocked="true" /
     * android:turnScreenOn="true"). They MUST NOT be toggled dynamically at
     * runtime via setShowWhenLocked(false) — doing so caused the "first call
     * works, second call on lock screen has no UI" bug. The manifest flags
     * ensure the window always surfaces above the keyguard whenever the
     * activity is resumed by a full-screen incoming-call PendingIntent,
     * regardless of how many prior calls happened or whether MainActivity
     * was paused behind the keyguard. This function therefore only clears
     * FLAG_KEEP_SCREEN_ON and stale intent extras.
     */
    @JvmStatic
    fun clearIncomingCallWindowFlags(activity: MainActivity) {
      try {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Stale deep links otherwise re-apply lock-screen presentation on every resume.
        activity.intent?.removeExtra("connect_show_incoming_call")
        Log.i(TAG, "[LOCK_CALL] clearIncomingCallWindowFlags — cleared FLAG_KEEP_SCREEN_ON")
      } catch (e: Exception) {
        Log.w(TAG, "[LOCK_CALL] clearIncomingCallWindowFlags failed: ${e.message}")
      }
    }
  }

  override fun onResume() {
    super.onResume()
    hostActivityResumed = true
    Log.i(TAG, "[LOCK_CALL_STATE] onResume hostActivityResumed=true")
  }

  override fun onPause() {
    hostActivityResumed = false
    Log.i(TAG, "[LOCK_CALL_STATE] onPause hostActivityResumed=false")
    super.onPause()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    Log.i(TAG, "[LOCK_CALL_STATE] onCreate intentAction=${intent?.action} data=${intent?.data}")
    neutralizeStaleIncomingCallIntent(intent, "onCreate")
    dismissIncomingCallFromIntent(intent, "onCreate")
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    super.onCreate(null)
    applyIncomingCallWindowFlags(intent)
  }

  override fun onNewIntent(intent: Intent?) {
    Log.i(TAG, "[LOCK_CALL_STATE] onNewIntent action=${intent?.action} data=${intent?.data}")
    super.onNewIntent(intent)
    setIntent(intent)
    neutralizeStaleIncomingCallIntent(intent, "onNewIntent")
    dismissIncomingCallFromIntent(intent, "onNewIntent")
    applyIncomingCallWindowFlags(intent)
  }

  /**
   * When MainActivity is re-launched via Samsung Recents / launcher after a
   * call has already ended, Android replays the task's saved baseIntent — the
   * original `com.connectcommunications.mobile://incoming-call?...` deep link.
   * Without intervention JS re-reads the URL via Linking.getInitialURL(),
   * re-shows IncomingCallScreen, polls the server, sees hungup, shows Call
   * Ended, and if the user presses back and comes back via Recents again the
   * whole cycle repeats → the "call ended / incoming call" loop reported by
   * the user.
   *
   * The native service's CACHE_FILE is our authoritative "is there a pending
   * call?" breadcrumb. If it's absent, the call has already been dismissed
   * (by INVITE_CLAIMED / CANCELED / MISSED FCM, JS polling, or user action),
   * so the baseIntent is stale and we strip it to avoid JS re-triggering.
   */
  private fun neutralizeStaleIncomingCallIntent(intent: Intent?, source: String) {
    val i = intent ?: return
    val data = i.data ?: return
    if (data.scheme != "com.connectcommunications.mobile") return
    if (data.host != "incoming-call") return
    val action = data.getQueryParameter("action")
    // Answer/decline actions are always fresh (posted by the user THIS instant
    // via notification buttons) — don't drop them.
    if (action == "answer" || action == "decline") return
    if (IncomingCallFirebaseService.hasPendingIncomingCall(this)) return
    val inviteId = data.getQueryParameter("inviteId") ?: data.getQueryParameter("callId")
    Log.i(
      TAG,
      "[LOCK_CALL] neutralizing stale incoming-call deep link source=$source inviteId=$inviteId"
    )
    // Reset to a plain launcher intent so ReactActivity / JS Linking see a cold
    // start with no queued action.
    i.data = null
    i.action = Intent.ACTION_MAIN
    i.addCategory(Intent.CATEGORY_LAUNCHER)
    i.removeExtra("connect_show_incoming_call")
    i.removeExtra("inviteId")
    i.removeExtra("fromNumber")
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
    Log.i(TAG, "[LOCK_CALL] notification_action=$action inviteId=$inviteId source=$source")
    IncomingCallFirebaseService.dismissIncomingCallUi(this, inviteId, "intent_$action:$source")
    intent?.removeExtra("connect_show_incoming_call")
  }

  /**
   * Per-call FLAG_KEEP_SCREEN_ON management. show-when-locked / turn-screen-on
   * are static (manifest) and MUST NOT be touched here — see the comment on
   * [clearIncomingCallWindowFlags] above.
   */
  private fun applyIncomingCallWindowFlags(intent: Intent?) {
    val showIncomingCall = intent?.getBooleanExtra("connect_show_incoming_call", false) == true
    val inviteId = intent?.getStringExtra("inviteId")
    val action = intent?.data?.getQueryParameter("action")
    Log.i(TAG, "[LOCK_CALL] applyIncomingCallWindowFlags showIncomingCall=$showIncomingCall action=$action inviteId=$inviteId")

        if (showIncomingCall) {
          // Mark this lifecycle as "launched from incoming-call surface" so the
          // hangup path can moveTaskToBack and reveal the lock screen again
          // instead of leaving QuickAction visible. Set for both answer/decline
          // intent paths and the full-screen "open" path because in all three
          // the user reached MainActivity via a call notification, not the
          // launcher. This is consumed exactly once in JS at hangup time via
          // IncomingCallUiModule.consumeLaunchedFromIncomingCall().
          launchedFromIncomingCall = true
          Log.i(TAG, "[LOCK_CALL] launchedFromIncomingCall=true source=$action inviteId=$inviteId")
          if (action == "answer" || action == "decline") {
            // Notification answer/decline already dismissed the shade above; just
            // drop KEEP_SCREEN_ON so the activity can pause normally if the user
            // leaves the call screen.
            clearIncomingCallWindowFlags(this)
            return
          }
          // "open" (or full-screen pending intent): cancel the ongoing notification
          // — native ringtone keeps playing until JS dismiss / INVITE_CLAIMED. Add
          // FLAG_KEEP_SCREEN_ON so the incoming UI stays bright while ringing. The
          // manifest's showWhenLocked=true already positions the window above the
          // keyguard whenever the PendingIntent brings us to the foreground.
          IncomingCallFirebaseService.cancelIncomingCallNotificationOnly(this, inviteId)
          window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          Log.i(TAG, "[LOCK_CALL_UI] incoming_window_primed inviteId=$inviteId keepScreenOn=true")
          return
        }

    // Not an incoming-call intent — make sure we don't leak FLAG_KEEP_SCREEN_ON
    // from an earlier call.
    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
  }
}
