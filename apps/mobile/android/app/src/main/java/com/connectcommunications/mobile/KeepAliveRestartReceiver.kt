package com.connectcommunications.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * One-shot restart hook used when OEM process management kills the app shortly
 * after recents-swipe. We only restart if keepalive is still enabled (user is
 * logged in and did not request stop).
 */
class KeepAliveRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (!SipKeepAliveService.isKeepAliveEnabled(context.applicationContext)) {
      Log.i(TAG, "onReceive: keepalive disabled, skip restart")
      return
    }
    Log.i(TAG, "onReceive: restarting SipKeepAliveService after process kill")
    SipKeepAliveService.start(context.applicationContext)
  }

  companion object {
    private const val TAG = "KeepAliveRestartRcvr"
  }
}
