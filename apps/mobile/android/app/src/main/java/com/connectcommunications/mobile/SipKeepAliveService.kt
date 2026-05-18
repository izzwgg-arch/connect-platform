package com.connectcommunications.mobile

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person

/**
 * Stage 2: persistent Android Foreground Service that keeps the JS process
 * in the "foreground" importance tier while the user is logged in.
 *
 * Why this exists
 * ---------------
 * Samsung / Xiaomi / OPPO One UI aggressively kill backgrounded processes
 * (we observed a WebSocket code 1006 "Software caused connection abort"
 * ~10 s after screen lock in the latency test). Once that happens:
 *   • JsSIP's WebSocket is torn down, so incoming INVITEs cannot arrive.
 *   • JS setTimeout / setInterval are frozen by Doze, so our own
 *     auto-reconnect timer sits idle for up to ~10 s (we measured 9 s).
 *
 * A started-foreground service with an ongoing notification:
 *   • Promotes the process to OOM importance FOREGROUND_SERVICE (tier 125
 *     in procstats), which prevents Doze / App Standby from freezing our
 *     JS timers and from killing our WebSocket.
 *   • Survives the Activity being swiped away from recents, so JsSIP
 *     keeps its registration alive even when the user isn't actively
 *     using the app.
 *
 * The service holds a partial wake lock as a belt-and-suspenders against
 * deep-sleep CPU gating on aggressive OEMs — we only need the CPU awake
 * enough for JsSIP to answer the occasional REGISTER refresh, so the
 * battery cost is negligible.
 *
 * Lifecycle
 * ---------
 *   • START  — called from IncomingCallUiModule.startSipKeepAlive() the
 *              moment SipContext sees provisioning.
 *   • STOP   — called from IncomingCallUiModule.stopSipKeepAlive() on
 *              logout (authToken cleared).
 *   • Survives reboot via BootReceiver if the user was logged in.
 *
 * The service intentionally does NOT own any SIP / WebRTC logic. All
 * it does is keep the process alive so the existing JsSIP UA in the JS
 * thread can maintain its registration. That keeps Stage 2 a surgical,
 * low-risk change rather than a full re-architecture.
 */
class SipKeepAliveService : Service() {

  companion object {
    private const val TAG = "SipKeepAliveService"
    private const val CHANNEL_ID = "connect_sip_keepalive"
    private const val CHANNEL_NAME = "Connect background service"
    /**
     * Separate channel for the in-call ongoing notification so we can give it
     * a higher importance + visible category — the keep-alive idle channel
     * is IMPORTANCE_MIN, which would render the in-call CallStyle without
     * action buttons on the lock screen on some OEMs.
     */
    private const val IN_CALL_CHANNEL_ID = "connect_in_call_v2"
    private const val IN_CALL_CHANNEL_NAME = "On a call"
    private const val NOTIFICATION_ID = 4242
    private const val WAKE_LOCK_TAG = "ConnectCommunications:SipKeepAlive"
    private const val PREFS_NAME = "connect_keepalive"
    private const val PREF_KEEPALIVE_ENABLED = "enabled"
    private const val ACTION_RESTART_KEEPALIVE = "com.connectcommunications.mobile.SipKeepAlive.RESTART"

    // ── Foreground state intents ─────────────────────────────────────────────
    /**
     * Sent to onStartCommand to swap the service into in-call mode:
     *   • foreground type ladder includes MICROPHONE (so mic capture survives
     *     backgrounding on Android 14+)
     *   • notification swaps to a CallStyle.forOngoingCall ringer with End +
     *     Speaker actions and a live chronometer
     * Extras: EXTRA_CALLER_NAME, EXTRA_CALL_STARTED_AT_MS, EXTRA_SPEAKER_ON.
     */
    private const val ACTION_ENTER_CALL = "com.connectcommunications.mobile.SipKeepAlive.ENTER_CALL"
    private const val ACTION_EXIT_CALL  = "com.connectcommunications.mobile.SipKeepAlive.EXIT_CALL"
    private const val ACTION_UPDATE_CALL = "com.connectcommunications.mobile.SipKeepAlive.UPDATE_CALL"
    private const val EXTRA_CALLER_NAME = "callerName"
    private const val EXTRA_CALL_STARTED_AT_MS = "callStartedAtMs"
    private const val EXTRA_SPEAKER_ON = "speakerOn"
    private const val EXTRA_MUTED = "muted"

    // ── Notification action intents ──────────────────────────────────────────
    //
    // ARCHITECTURE NOTE — why the Hang Up button uses a service intent, not a broadcast:
    //
    // SipKeepAliveService runs in the :keepalive process. DeviceEventEmitter
    // (IncomingCallUiModule.emitInCallAction) only works in the MAIN process where
    // the React bridge lives. A broadcast received in :keepalive has no React context.
    //
    // Fix: the "Hang Up" PendingIntent is a getService() call delivered directly to
    // SipKeepAliveService with ACTION_NOTIF_HANGUP_SVC. The service:
    //   1. Clears inCall + stopForeground(REMOVE) + cancel 4242 IMMEDIATELY (no round-trip).
    //   2. Sends NOTIF_ACTION_HANGUP_RELAY broadcast (received by InCallNotificationReceiver
    //      in the MAIN process, which can reach DeviceEventEmitter and tell JS to send BYE).
    //
    // Speaker / Mute toggles still use dynamic broadcast receivers (also in :keepalive) so
    // the notification icon flips instantly. JS roundtrip is not needed for the icon update.
    // NOTE: the speaker/mute cross-process JS call will silently fail if the app is fully
    // backgrounded — actual audio routing changes only take effect when the app is active.

    // Service-action version of the Hang Up button — delivered to onStartCommand in :keepalive.
    private const val ACTION_NOTIF_HANGUP_SVC = "com.connectcommunications.mobile.SipKeepAlive.NOTIF_HANGUP_SVC"

    // Relay broadcast — picked up by InCallNotificationReceiver in the MAIN process so it
    // can call IncomingCallUiModule.emitInCallAction("hangup") to reach JS.
    const val NOTIF_ACTION_HANGUP_RELAY = "com.connectcommunications.mobile.SipKeepAlive.NOTIF_HANGUP_RELAY"

    const val NOTIF_ACTION_HANGUP = "com.connectcommunications.mobile.SipKeepAlive.NOTIF_HANGUP"
    const val NOTIF_ACTION_TOGGLE_SPEAKER = "com.connectcommunications.mobile.SipKeepAlive.NOTIF_TOGGLE_SPEAKER"
    const val NOTIF_ACTION_TOGGLE_MUTE = "com.connectcommunications.mobile.SipKeepAlive.NOTIF_TOGGLE_MUTE"

    // ── Diagnostics state ────────────────────────────────────────────────────
    // Surfaced via IncomingCallUiModule.getCallWakeDiagnostics() so the in-app
    // Diagnostics screen can prove "yes the keep-alive service started" or
    // "no, startForegroundService threw <ForegroundServiceStartNotAllowedException>"
    // without needing logcat. The S25 / Android 15 / One UI 7 silently rejects
    // FOREGROUND_SERVICE_TYPE_PHONE_CALL on some launch paths and the only way
    // to know is to capture the exception class and surface it.
    @JvmStatic @Volatile var lastStartAttemptAtMs: Long = 0
    @JvmStatic @Volatile var lastStartResult: String = ""
    @JvmStatic @Volatile var lastStartErrorClass: String = ""
    @JvmStatic @Volatile var lastStartErrorMessage: String = ""
    @JvmStatic @Volatile var lastForegroundAttemptAtMs: Long = 0
    @JvmStatic @Volatile var lastForegroundResult: String = ""
    @JvmStatic @Volatile var lastForegroundTypeUsed: String = ""
    @JvmStatic @Volatile var lastForegroundErrorClass: String = ""
    @JvmStatic @Volatile var lastForegroundErrorMessage: String = ""
    @JvmStatic @Volatile var serviceCreatedAtMs: Long = 0
    @JvmStatic @Volatile var serviceDestroyedAtMs: Long = 0
    @JvmStatic @Volatile var isRunning: Boolean = false

    private fun setKeepAliveEnabledFlag(context: Context, enabled: Boolean) {
      try {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .edit()
          .putBoolean(PREF_KEEPALIVE_ENABLED, enabled)
          .apply()
      } catch (_: Throwable) {}
    }

    @JvmStatic
    fun isKeepAliveEnabled(context: Context): Boolean {
      return try {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
          .getBoolean(PREF_KEEPALIVE_ENABLED, false)
      } catch (_: Throwable) {
        false
      }
    }

    fun start(context: Context) {
      setKeepAliveEnabledFlag(context, true)
      lastStartAttemptAtMs = System.currentTimeMillis()
      lastStartErrorClass = ""
      lastStartErrorMessage = ""
      val intent = Intent(context, SipKeepAliveService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        lastStartResult = "dispatched"
        Log.i(TAG, "start: dispatched startForegroundService")
      } catch (t: Throwable) {
        lastStartResult = "threw"
        lastStartErrorClass = t.javaClass.simpleName
        lastStartErrorMessage = t.message ?: ""
        Log.w(TAG, "start failed (${t.javaClass.simpleName}): ${t.message}")
      }
    }

    fun stop(context: Context) {
      setKeepAliveEnabledFlag(context, false)
      try {
        context.stopService(Intent(context, SipKeepAliveService::class.java))
        Log.i(TAG, "stop: dispatched stopService")
      } catch (t: Throwable) {
        Log.w(TAG, "stop failed: ${t.message}")
      }
    }

    /**
     * Switch the (already-running) service into in-call mode.
     *
     * Two outcomes that must succeed atomically:
     *
     *   1. The foreground-service type is re-promoted to include MICROPHONE
     *      so Android 14+ keeps the WebRTC mic stream alive when the user
     *      backgrounds the app. Without this, the remote party hears
     *      silence the moment the app loses foreground.
     *
     *   2. The persistent notification is replaced with a CallStyle ongoing
     *      ringer that shows the caller name, a live timer (chronometer
     *      anchored to callStartedAtMs), and End / Speaker action buttons
     *      so the user can manage the call without bringing the app
     *      foreground.
     *
     * Idempotent: calling repeatedly with new info just refreshes the
     * notification (used for speaker-state changes mid-call).
     */
    fun startInCall(
      context: Context,
      callerName: String?,
      callStartedAtMs: Long,
      speakerOn: Boolean,
      muted: Boolean,
    ) {
      val i = Intent(context, SipKeepAliveService::class.java).apply {
        action = ACTION_ENTER_CALL
        putExtra(EXTRA_CALLER_NAME, callerName ?: "")
        putExtra(EXTRA_CALL_STARTED_AT_MS, callStartedAtMs)
        putExtra(EXTRA_SPEAKER_ON, speakerOn)
        putExtra(EXTRA_MUTED, muted)
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(i)
        } else {
          context.startService(i)
        }
        Log.i(TAG, "startInCall dispatched callerName=${callerName ?: ""} speakerOn=$speakerOn muted=$muted")
      } catch (t: Throwable) {
        Log.w(TAG, "startInCall failed (${t.javaClass.simpleName}): ${t.message}")
      }
    }

    /**
     * Refresh the in-call notification's toggle state mid-call (used when JS
     * flips speaker / mute and we need the notification action icon to stay
     * in sync with the actual audio routing). No-op if the service isn't
     * already in in-call mode — the notification is simply rebuilt with the
     * current state.
     */
    fun updateInCallState(
      context: Context,
      speakerOn: Boolean,
      muted: Boolean,
    ) {
      val i = Intent(context, SipKeepAliveService::class.java).apply {
        action = ACTION_UPDATE_CALL
        putExtra(EXTRA_SPEAKER_ON, speakerOn)
        putExtra(EXTRA_MUTED, muted)
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(i)
        } else {
          context.startService(i)
        }
      } catch (t: Throwable) {
        Log.w(TAG, "updateInCallState failed: ${t.message}")
      }
    }

    /**
     * Drop out of in-call mode: re-promote the service to its idle
     * foreground type ladder (PHONE_CALL|DATA_SYNC) and restore the minimal
     * "Connect ready" notification. Called from JS when the call ends.
     */
    fun stopInCall(context: Context) {
      val i = Intent(context, SipKeepAliveService::class.java).apply {
        action = ACTION_EXIT_CALL
      }
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(i)
        } else {
          context.startService(i)
        }
        Log.i(TAG, "stopInCall dispatched")
      } catch (t: Throwable) {
        Log.w(TAG, "stopInCall failed: ${t.message}")
      }
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  /** In-call snapshot. Null = idle keep-alive mode. */
  private data class InCallSnapshot(
    val callerName: String,
    val callStartedAtMs: Long,
    val speakerOn: Boolean,
    val muted: Boolean,
  )
  private var inCall: InCallSnapshot? = null
  private var notifReceiver: BroadcastReceiver? = null

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate")
    serviceCreatedAtMs = System.currentTimeMillis()
    serviceDestroyedAtMs = 0
    ensureChannel()
    ensureInCallChannel()
    registerNotifReceiver()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action
    Log.i(TAG, "onStartCommand startId=$startId action=$action")

    when (action) {
      ACTION_ENTER_CALL -> {
        inCall = InCallSnapshot(
          callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "",
          callStartedAtMs = intent.getLongExtra(EXTRA_CALL_STARTED_AT_MS, System.currentTimeMillis()),
          speakerOn = intent.getBooleanExtra(EXTRA_SPEAKER_ON, false),
          muted = intent.getBooleanExtra(EXTRA_MUTED, false),
        )
        Log.i(TAG, "[CONNECT_CALL_UI] active_call_notification_posted callerName=${inCall?.callerName ?: ""}")
      }

      // ── Hang Up notification button ───────────────────────────────────────
      // Uses getService() so the intent is delivered here in :keepalive instead
      // of via a broadcast that can't reach the React DeviceEventEmitter.
      // We clear the notification FIRST (immediate user feedback), then relay
      // to the main process so JS can send the SIP BYE.
      ACTION_NOTIF_HANGUP_SVC -> {
        Log.i(TAG, "ACTION_NOTIF_HANGUP_SVC — clearing in-call notification immediately")
        inCall = null
        clearInCallForeground()
        Log.i(TAG, "[CONNECT_CALL_UI] active_call_notification_cleared startId=$startId (hangup_button)")
        // Relay to main process: InCallNotificationReceiver → emitInCallAction("hangup") → JS BYE
        try {
          sendBroadcast(Intent(NOTIF_ACTION_HANGUP_RELAY).setPackage(packageName))
          Log.i(TAG, "NOTIF_HANGUP_RELAY broadcast sent to main process")
        } catch (t: Throwable) {
          Log.w(TAG, "NOTIF_HANGUP_RELAY broadcast failed: ${t.message}")
        }
      }

      // ── JS-triggered call end (all terminal paths: local hangup, remote BYE,
      //    session failed, call declined) ────────────────────────────────────
      ACTION_EXIT_CALL -> {
        inCall = null
        // stopForeground(REMOVE) atomically cancels notification 4242 and releases
        // the PHONE_CALL foreground type association. Without this, the
        // CallStyle.forOngoingCall chip persists on OEM lock screens (confirmed
        // on OxygenOS/OnePlus) even after startForeground replaces the notification
        // content, because the channel transition (IN_CALL_CHANNEL_ID → CHANNEL_ID)
        // is not handled atomically by all Android ROMs.
        // startForegroundSafely() immediately re-enters FGS with the idle
        // notification, so there is no foreground gap.
        clearInCallForeground()
        Log.i(TAG, "[CONNECT_CALL_UI] active_call_notification_cleared startId=$startId")
      }

      ACTION_UPDATE_CALL -> {
        inCall = inCall?.copy(
          speakerOn = intent.getBooleanExtra(EXTRA_SPEAKER_ON, inCall?.speakerOn ?: false),
          muted    = intent.getBooleanExtra(EXTRA_MUTED,    inCall?.muted    ?: false),
        )
      }
    }

    val foregrounded = startForegroundSafely()
    if (foregrounded) {
      isRunning = true
      acquireWakeLock()
      if (action == ACTION_EXIT_CALL) {
        Log.i(TAG, "[CONNECT_CALL_UI] foreground_service_idle — idle notification reposted after call exit")
      }
    } else {
      // We could not enter foreground state. Returning START_STICKY would let
      // the system silently restart us into the same failure. Stop the service
      // so the failure is visible (the keepalive notification stays missing
      // and the diagnostics surface lastForegroundResult="threw"), and let JS
      // fall back to the wake-then-dial path entirely.
      isRunning = false
      Log.w(TAG, "onStartCommand: startForeground failed, stopping service to avoid silent restart loop")
      if (action == ACTION_EXIT_CALL) {
        Log.w(TAG, "[CONNECT_CALL_UI] foreground_service_stopped — could not re-enter FGS after call exit")
      }
      stopSelf(startId)
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  override fun onDestroy() {
    Log.i(TAG, "onDestroy")
    serviceDestroyedAtMs = System.currentTimeMillis()
    isRunning = false
    if (isKeepAliveEnabled(applicationContext)) {
      scheduleSelfRestart("onDestroy")
    }
    releaseWakeLock()
    unregisterNotifReceiver()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Samsung can kill our process shortly after recents-swipe even while this
    // service is foreground. Schedule a one-shot restart alarm so wake pushes
    // still have a resident process instead of waiting for ActivityManager's
    // delayed crash-restart backoff.
    val wasInCall = inCall != null
    if (isKeepAliveEnabled(applicationContext)) {
      scheduleSelfRestart("onTaskRemoved")
    }
    Log.i(TAG, "onTaskRemoved — recents swipe detected wasInCall=$wasInCall")

    if (wasInCall) {
      // The call lives in the JS thread (JsSIP) of the MAIN process. The FGS
      // MICROPHONE|PHONE_CALL type should keep the main process alive on most
      // devices, so the call continues and the notification Hang Up button still
      // works (via the cross-process relay path added in this PR).
      //
      // Safety watchdog: on aggressive OEMs (Samsung One UI, MIUI) the main
      // process can be killed within seconds of task removal despite the FGS.
      // If that happens, JS can never send ACTION_EXIT_CALL, so the in-call
      // notification would linger indefinitely.
      //
      // We check after 10 seconds whether the main process is still alive.
      // If it's gone, the call is dead — clear the notification immediately.
      Handler(Looper.getMainLooper()).postDelayed({
        if (inCall == null) return@postDelayed  // already cleared by JS path — happy path
        try {
          val am = getSystemService(ACTIVITY_SERVICE) as? ActivityManager
          val mainProcessAlive = am?.runningAppProcesses?.any { proc ->
            // Main process has the bare package name; :keepalive has "<pkg>:keepalive"
            proc.processName == packageName
          } == true
          if (!mainProcessAlive) {
            Log.i(TAG, "[CONNECT_CALL_UI] active_call_notification_cleared — main process gone after task removal")
            inCall = null
            clearInCallForeground()
            startForegroundSafely()
          } else {
            Log.i(TAG, "onTaskRemoved watchdog — main process alive, call assumed ongoing")
          }
        } catch (t: Throwable) {
          Log.w(TAG, "onTaskRemoved watchdog failed: ${t.message}")
        }
      }, 10_000L)
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Idempotent helper: stop the foreground PHONE_CALL association and cancel
   * notification 4242 from both the FGS layer and the NotificationManager.
   *
   * Two-step approach:
   *   1. stopForeground(REMOVE) — atomically releases the PHONE_CALL foreground
   *      type and cancels the FGS-bound notification. Required to clear the
   *      CallStyle lock-screen chip on OxygenOS/OnePlus.
   *   2. NotificationManager.cancel(4242) — belt-and-suspenders for OEMs that
   *      do not immediately clear the chip via stopForeground alone, or for any
   *      edge case where the notification was re-posted outside the FGS path.
   *
   * Safe to call even if the service is not currently in foreground state.
   */
  private fun clearInCallForeground() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    try {
      (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
        ?.cancel(NOTIFICATION_ID)
    } catch (_: Throwable) {}
  }


  /**
   * Attempt startForeground with progressively safer foregroundServiceType
   * combinations. Returns true iff one of the attempts succeeded; false means
   * the service is NOT in foreground state and the caller must stopSelf() to
   * avoid the system silently restarting us into the same failure.
   *
   * Why this ladder
   * ---------------
   * Android 15 / One UI 7 on the Galaxy S25 has been observed to reject
   * `FOREGROUND_SERVICE_TYPE_PHONE_CALL` with `SecurityException` /
   * `ForegroundServiceTypeNotAllowedException` even when the app holds
   * `MANAGE_OWN_CALLS` + `FOREGROUND_SERVICE_PHONE_CALL`. The exact gate seems
   * to be "no active TelecomManager call right now" — which we don't have when
   * we're spinning up the keep-alive proactively.
   *
   * If PHONE_CALL fails we try DATA_SYNC alone, then SPECIAL_USE (added in
   * Android 14, intended for niche cases like ours), then a typeless
   * startForeground call (the system pre-Android 14 default — many Android
   * 14/15 devices still accept it with a downgrade warning).
   *
   * Each step records the failure into the diagnostics fields so the in-app
   * Diagnostics screen can show `lastForegroundResult="threw"` +
   * `lastForegroundErrorClass="ForegroundServiceTypeNotAllowedException"` —
   * the single most useful signal when triaging "calls don't ring on S25".
   */
  private fun startForegroundSafely(): Boolean {
    val notification = buildNotification()
    lastForegroundAttemptAtMs = System.currentTimeMillis()
    lastForegroundErrorClass = ""
    lastForegroundErrorMessage = ""

    // Pre-Android 8 has no foreground service type concept.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return tryFg("legacy") {
        startForeground(NOTIFICATION_ID, notification)
      }
    }

    // Pre-Android 14 takes type via the Service manifest entry only —
    // the 3-arg startForeground is a no-op on these versions.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      return tryFg("type-from-manifest") {
        startForeground(NOTIFICATION_ID, notification)
      }
    }

    // Android 14+ ladder. Each type passed must be a subset of what is
    // declared in AndroidManifest.xml `android:foregroundServiceType`. We
    // declare `phoneCall|dataSync|microphone`, so any combination of those
    // three is valid.
    //
    // The exact ladder depends on whether we are in-call or idle:
    //
    //   IN-CALL:
    //     The MICROPHONE type is the critical one — without it Android 14+
    //     silently mutes WebRTC capture the moment the app loses foreground
    //     and the remote party hears silence. We try the strongest combo
    //     first (MICROPHONE + PHONE_CALL + DATA_SYNC) so the kernel knows
    //     this is a foreground voice call AND we hold the mic. If PHONE_CALL
    //     is rejected (S25 / Android 15 has been seen to refuse it without
    //     an active TelecomManager call) we fall back to MICROPHONE +
    //     DATA_SYNC which still keeps the mic alive.
    //
    //   IDLE:
    //     PHONE_CALL|DATA_SYNC ladder as before — there's no mic capture
    //     happening so MICROPHONE would be misleading and Android may
    //     enforce timeouts on idle MICROPHONE FGS.
    val attempts: List<Pair<String, Int>> = if (inCall != null) {
      listOf(
        "MICROPHONE|PHONE_CALL|DATA_SYNC" to (
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        ),
        "MICROPHONE|PHONE_CALL" to (
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
        ),
        "MICROPHONE|DATA_SYNC" to (
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        ),
        // Last resort: MICROPHONE alone. Still fixes the mic-mute issue but
        // loses the PHONE_CALL/DATA_SYNC survival hints.
        "MICROPHONE" to ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      listOf(
        // Best — strongest survival tier when accepted. Some Android 15 builds
        // refuse this combo if no active TelecomManager call exists.
        "PHONE_CALL|DATA_SYNC" to (
          ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        ),
        // Some Samsung builds accept PHONE_CALL alone but not the combo.
        "PHONE_CALL" to ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
        // DATA_SYNC alone — weaker tier, killed faster under mem-pressure but
        // never refused on permission grounds. Final fallback.
        "DATA_SYNC" to ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    }

    for ((label, type) in attempts) {
      val ok = tryFg(label) {
        startForeground(NOTIFICATION_ID, notification, type)
      }
      if (ok) return true
    }
    return false
  }

  /** Wraps a single startForeground attempt and records its outcome. */
  private inline fun tryFg(label: String, block: () -> Unit): Boolean {
    return try {
      block()
      lastForegroundResult = "ok"
      lastForegroundTypeUsed = label
      Log.i(TAG, "startForeground posted ongoing notification id=$NOTIFICATION_ID type=$label")
      true
    } catch (t: Throwable) {
      // Capture the LAST failure — overwritten on each attempt so JS sees the
      // final reason we couldn't enter foreground state.
      lastForegroundResult = "threw"
      lastForegroundTypeUsed = label
      lastForegroundErrorClass = t.javaClass.simpleName
      lastForegroundErrorMessage = t.message ?: ""
      Log.w(TAG, "startForeground type=$label failed (${t.javaClass.simpleName}): ${t.message}")
      false
    }
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      CHANNEL_NAME,
      // MIN so it collapses into the "Connect is running in the background"
      // group without distracting the user. The user can still hide it
      // entirely via app notification settings if desired.
      NotificationManager.IMPORTANCE_MIN,
    ).apply {
      description = "Keeps Connect ready to receive calls when the screen is off."
      setShowBadge(false)
      setSound(null, null)
      enableVibration(false)
      enableLights(false)
    }
    nm.createNotificationChannel(channel)
  }

  /**
   * Channel for the in-call ongoing notification. DEFAULT importance (no
   * sound/vibration — the channel is silent because the call audio itself
   * is the notification) so the lock-screen surface still shows action
   * buttons. The keep-alive idle channel is IMPORTANCE_MIN, which on some
   * OEMs strips notification actions on the lock screen.
   */
  private fun ensureInCallChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    if (nm.getNotificationChannel(IN_CALL_CHANNEL_ID) != null) return
    val channel = NotificationChannel(
      IN_CALL_CHANNEL_ID,
      IN_CALL_CHANNEL_NAME,
      NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "Shown for the entire duration of an active call so you can hang up or toggle the speaker without opening the app."
      setShowBadge(false)
      setSound(null, null)
      enableVibration(false)
      enableLights(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    }
    nm.createNotificationChannel(channel)
  }

  /**
   * Subscribes to the three in-call notification action broadcasts. Each
   * action does two things:
   *   1. Updates our local in-call snapshot (speaker / mute toggles flip
   *      immediately so the next notification rebuild reflects the new
   *      icon / label).
   *   2. Re-emits the action to the JS layer via DeviceEventEmitter so
   *      SipContext can call session.terminate() / setSpeaker() /
   *      toggleMute() against the actual JsSIP session. JS owns the SIP
   *      lifecycle — the native side can only request these.
   */
  private fun registerNotifReceiver() {
    if (notifReceiver != null) return
    // NOTIF_ACTION_HANGUP is no longer in this filter — the hangup PendingIntent
    // now uses getService() to deliver ACTION_NOTIF_HANGUP_SVC directly to
    // onStartCommand, avoiding the cross-process emit failure. Speaker/Mute
    // still use broadcast receivers so the notification icon flips immediately
    // within the :keepalive process without a JS round-trip.
    val filter = IntentFilter().apply {
      addAction(NOTIF_ACTION_TOGGLE_SPEAKER)
      addAction(NOTIF_ACTION_TOGGLE_MUTE)
    }
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
          NOTIF_ACTION_TOGGLE_SPEAKER -> {
            val cur = inCall ?: return
            val next = !cur.speakerOn
            Log.i(TAG, "in-call notification: TOGGLE_SPEAKER -> $next")
            inCall = cur.copy(speakerOn = next)
            // Refresh the notification immediately so the action label flips
            // before the JS round-trip completes (perceived latency).
            try {
              val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
              nm?.notify(NOTIFICATION_ID, buildNotification())
            } catch (_: Throwable) {}
            try { IncomingCallUiModule.emitInCallAction("toggle_speaker", next) } catch (_: Throwable) {}
          }
          NOTIF_ACTION_TOGGLE_MUTE -> {
            val cur = inCall ?: return
            val next = !cur.muted
            Log.i(TAG, "in-call notification: TOGGLE_MUTE -> $next")
            inCall = cur.copy(muted = next)
            try {
              val nm = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
              nm?.notify(NOTIFICATION_ID, buildNotification())
            } catch (_: Throwable) {}
            try { IncomingCallUiModule.emitInCallAction("toggle_mute", next) } catch (_: Throwable) {}
          }
        }
      }
    }
    try {
      // Android 14+ requires explicit RECEIVER_NOT_EXPORTED for in-process
      // broadcasts. Older versions ignore the flag.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        registerReceiver(receiver, filter)
      }
      notifReceiver = receiver
      Log.i(TAG, "registerNotifReceiver: subscribed to in-call notification actions")
    } catch (t: Throwable) {
      Log.w(TAG, "registerNotifReceiver failed: ${t.message}")
    }
  }

  private fun unregisterNotifReceiver() {
    val r = notifReceiver ?: return
    try { unregisterReceiver(r) } catch (_: Throwable) {}
    notifReceiver = null
  }

  private fun buildNotification(): Notification {
    val snap = inCall
    return if (snap != null) buildInCallNotification(snap) else buildIdleNotification()
  }

  private fun buildIdleNotification(): Notification {
    val contentIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pi = PendingIntent.getActivity(
      this,
      0,
      contentIntent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle("Connect")
      .setContentText("Ready to receive calls")
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setShowWhen(false)
      .setContentIntent(pi)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  /**
   * Persistent in-call notification — shown for the entire duration of an
   * active call so the user can hang up / toggle speaker without bringing
   * the app foreground.
   *
   * Uses CallStyle.forOngoingCall on Android 12+ so the system renders the
   * familiar one-tap call surface. On older OS versions the same End +
   * Speaker actions still appear as plain notification action buttons.
   *
   * The chronometer is anchored to the original call-confirmed timestamp
   * (callStartedAtMs) so it shows the true wall-clock duration even after
   * the notification is rebuilt mid-call (e.g. on a speaker toggle).
   */
  private fun buildInCallNotification(snap: InCallSnapshot): Notification {
    val pendingFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    // Tap on the body opens MainActivity so the in-app ActiveCallScreen takes
    // over for full controls (keypad, transfer, etc.).
    val openIntent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val openPi = PendingIntent.getActivity(this, 1, openIntent, pendingFlags)

    // Use getService() so the intent is delivered directly to this service's
    // onStartCommand in the :keepalive process. A broadcast PendingIntent would
    // only reach the dynamically registered receiver in :keepalive, which cannot
    // call IncomingCallUiModule.emitInCallAction (React context lives in main process).
    // See ACTION_NOTIF_HANGUP_SVC handling in onStartCommand for the full flow.
    val hangupPi = PendingIntent.getService(
      this, 2,
      Intent(this, SipKeepAliveService::class.java).apply {
        action = ACTION_NOTIF_HANGUP_SVC
      },
      pendingFlags,
    )
    val speakerPi = PendingIntent.getBroadcast(
      this, 3,
      Intent(NOTIF_ACTION_TOGGLE_SPEAKER).setPackage(packageName),
      pendingFlags,
    )
    val mutePi = PendingIntent.getBroadcast(
      this, 4,
      Intent(NOTIF_ACTION_TOGGLE_MUTE).setPackage(packageName),
      pendingFlags,
    )

    val callerLabel = snap.callerName.ifBlank { "On a call" }
    val person = Person.Builder().setName(callerLabel).setImportant(true).build()

    val builder = NotificationCompat.Builder(this, IN_CALL_CHANNEL_ID)
      .setSmallIcon(R.drawable.notification_icon)
      .setContentTitle(callerLabel)
      .setContentText(if (snap.muted) "Muted" else "On a call")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(true)
      .setWhen(snap.callStartedAtMs)
      .setUsesChronometer(true)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setContentIntent(openPi)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

    // Android 12+ — use the system CallStyle. We pass the End action through
    // forOngoingCall (it renders as a red hangup pill). The Speaker / Mute
    // toggles are added as additional actions; CallStyle merges them next
    // to the system buttons.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangupPi))
    } else {
      // Older OS — use plain action buttons with explicit labels.
      builder.addAction(0, "End", hangupPi)
    }

    // Speaker + Mute action buttons. Labels reflect current state so the
    // user knows what tapping will do (matches Android's stock dialer UX).
    builder.addAction(
      0,
      if (snap.speakerOn) "Speaker on" else "Speaker",
      speakerPi,
    )
    builder.addAction(
      0,
      if (snap.muted) "Unmute" else "Mute",
      mutePi,
    )

    return builder.build()
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
      val wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
        setReferenceCounted(false)
      }
      // No timeout — the service owns the lock for as long as it lives.
      // This is safe because the service itself is bounded by user
      // login / logout; we release it in onDestroy.
      wl.acquire()
      wakeLock = wl
      Log.i(TAG, "acquireWakeLock held=${wl.isHeld}")
    } catch (t: Throwable) {
      Log.w(TAG, "acquireWakeLock failed: ${t.message}")
    }
  }

  private fun releaseWakeLock() {
    try {
      wakeLock?.takeIf { it.isHeld }?.release()
    } catch (t: Throwable) {
      Log.w(TAG, "releaseWakeLock failed: ${t.message}")
    } finally {
      wakeLock = null
    }
  }

  private fun scheduleSelfRestart(reason: String) {
    try {
      val alarmManager = getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
      val restartIntent = Intent(this, KeepAliveRestartReceiver::class.java).apply {
        action = ACTION_RESTART_KEEPALIVE
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      val pi = PendingIntent.getBroadcast(this, 24424, restartIntent, flags)
      val triggerAtMs = SystemClock.elapsedRealtime() + 2_000L
      alarmManager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtMs, pi)
      Log.i(TAG, "scheduleSelfRestart reason=$reason in=2000ms")
    } catch (t: Throwable) {
      Log.w(TAG, "scheduleSelfRestart failed: ${t.message}")
    }
  }
}
