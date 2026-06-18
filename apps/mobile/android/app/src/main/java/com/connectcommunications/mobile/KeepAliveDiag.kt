package com.connectcommunications.mobile

import android.content.Context

/**
 * Durable, process-independent mirror of SipKeepAliveService foreground-service
 * health.
 *
 * Why this exists
 * ---------------
 * The keep-alive diagnostics were previously read from SipKeepAliveService's
 * `@JvmStatic @Volatile` companion fields. Static fields are *per-process*: when
 * the service ran in the ":keepalive" process it wrote those fields there, but
 * IncomingCallUiModule.getCallWakeDiagnostics() reads them from the MAIN
 * process, so the snapshot was permanently `serviceCreatedAtMs=0`,
 * `isRunning=false`, `lastForegroundResult=""` — i.e. completely blind to what
 * the service actually did. That blindness is exactly what made the T25/101 S25
 * investigation impossible from telemetry alone.
 *
 * Even now that the service runs in the main process (so the statics ARE
 * readable), a SharedPreferences mirror is strictly better:
 *   • It survives process death, so a cold FCM-wake of a freshly-spawned main
 *     process can still report the LAST foreground outcome and re-arm count
 *     instead of resetting to zeroed statics.
 *   • SharedPreferences(MODE_PRIVATE) is shared across every process of the
 *     same app, so it stays correct even if the service is ever moved back to a
 *     separate process.
 *
 * This object only persists primitives — no Android UI / RN coupling — so it is
 * safe to call from a Service, a BroadcastReceiver, or the JS bridge module.
 */
object KeepAliveDiag {
  private const val PREFS = "connect_keepalive"

  const val K_IS_RUNNING = "ka_is_running"
  const val K_SVC_CREATED = "ka_svc_created_at"
  const val K_SVC_DESTROYED = "ka_svc_destroyed_at"
  const val K_START_ATTEMPT = "ka_start_attempt_at"
  const val K_START_RESULT = "ka_start_result"
  const val K_START_ERR_CLASS = "ka_start_err_class"
  const val K_START_ERR_MSG = "ka_start_err_msg"
  const val K_FG_ATTEMPT = "ka_fg_attempt_at"
  const val K_FG_RESULT = "ka_fg_result"
  const val K_FG_TYPE = "ka_fg_type"
  const val K_FG_ERR_CLASS = "ka_fg_err_class"
  const val K_FG_ERR_MSG = "ka_fg_err_msg"
  /** Wall-clock ms at which startForeground() last *succeeded* (reached foreground). 0 = never. */
  const val K_FG_LANDED = "ka_fg_landed_at"
  /** Name of the process the service last ran in (e.g. the package name = main process). */
  const val K_PROCESS = "ka_process"
  /** How many times the JS watchdog has re-armed the service since install. */
  const val K_REARM_COUNT = "ka_rearm_count"

  private fun prefs(ctx: Context) =
    ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun putLong(ctx: Context, key: String, value: Long) {
    try { prefs(ctx).edit().putLong(key, value).apply() } catch (_: Throwable) {}
  }

  fun putString(ctx: Context, key: String, value: String) {
    try { prefs(ctx).edit().putString(key, value).apply() } catch (_: Throwable) {}
  }

  fun putBool(ctx: Context, key: String, value: Boolean) {
    try { prefs(ctx).edit().putBoolean(key, value).apply() } catch (_: Throwable) {}
  }

  fun getLong(ctx: Context, key: String): Long =
    try { prefs(ctx).getLong(key, 0L) } catch (_: Throwable) { 0L }

  fun getString(ctx: Context, key: String): String =
    try { prefs(ctx).getString(key, "") ?: "" } catch (_: Throwable) { "" }

  fun getBool(ctx: Context, key: String): Boolean =
    try { prefs(ctx).getBoolean(key, false) } catch (_: Throwable) { false }

  fun incrementRearm(ctx: Context): Int {
    return try {
      val next = prefs(ctx).getInt(K_REARM_COUNT, 0) + 1
      prefs(ctx).edit().putInt(K_REARM_COUNT, next).apply()
      next
    } catch (_: Throwable) {
      0
    }
  }

  fun getRearm(ctx: Context): Int =
    try { prefs(ctx).getInt(K_REARM_COUNT, 0) } catch (_: Throwable) { 0 }
}
