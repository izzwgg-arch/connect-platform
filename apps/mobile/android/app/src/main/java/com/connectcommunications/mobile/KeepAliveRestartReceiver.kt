package com.connectcommunications.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Restart hook for the keep-alive foreground service. Two triggers:
 *   • ACTION_RESTART_KEEPALIVE  — one-shot, scheduled from onTaskRemoved /
 *     onDestroy when those callbacks actually run (graceful kill).
 *   • ACTION_HEARTBEAT_KEEPALIVE — periodic watchdog. The critical path on
 *     aggressive OEMs: the process is often SIGKILLed under memory pressure
 *     WITHOUT any lifecycle callback, so the one-shot path never gets armed.
 *     The heartbeat alarm is held by the system independently of our process,
 *     fires after the kill, resurrects the registered process, and re-arms the
 *     NEXT heartbeat so the chain continues across repeated kills.
 *
 * We only restart if keepalive is still enabled (user logged in, no stop()).
 */
class KeepAliveRestartReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val ctx = context.applicationContext
    val action = intent?.action
    if (!SipKeepAliveService.isKeepAliveEnabled(ctx)) {
      Log.i(TAG, "onReceive action=$action: keepalive disabled, skip restart + cancel heartbeat")
      SipKeepAliveService.cancelHeartbeat(ctx)
      return
    }
    Log.i(TAG, "onReceive action=$action: (re)starting SipKeepAliveService")
    SipKeepAliveService.start(ctx)
    // ALWAYS re-arm the next heartbeat, even on the one-shot restart path — the
    // pending alarm must exist before this (briefly revived) process can be
    // killed again, otherwise the chain dies. Idempotent.
    SipKeepAliveService.scheduleHeartbeat(ctx)
  }

  companion object {
    private const val TAG = "KeepAliveRestartRcvr"
  }
}
