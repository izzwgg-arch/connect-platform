package com.connectcommunications.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.util.Log

/**
 * Starts SipKeepAliveService after device boot if the user was signed in
 * at the time of shutdown. Without this, Stage 2's "always registered"
 * promise would break for the first incoming call after every reboot.
 *
 * Login state is mirrored into SharedPreferences from JS via
 * IncomingCallUiModule.setKeepAliveEnabled(true|false) so we do not need
 * to spin up a ReactInstance just to ask "is the user logged in?".
 */
class BootReceiver : BroadcastReceiver() {

  companion object {
    private const val TAG = "ConnectBootReceiver"
    private const val PREFS = "connect_sip_keepalive_prefs"
    private const val KEY_ENABLED = "keepalive_enabled"

    fun setEnabled(context: Context, enabled: Boolean) {
      prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun isEnabled(context: Context): Boolean {
      return prefs(context).getBoolean(KEY_ENABLED, false)
    }

    private fun prefs(context: Context): SharedPreferences {
      return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED &&
        action != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
        action != "android.intent.action.QUICKBOOT_POWERON" &&
        action != "com.htc.intent.action.QUICKBOOT_POWERON") {
      return
    }
    val enabled = isEnabled(context)
    Log.i(TAG, "onReceive action=$action keepaliveEnabled=$enabled")
    if (enabled) {
      SipKeepAliveService.start(context)
    }
  }
}
