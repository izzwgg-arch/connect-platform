package com.connectcommunications.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

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
    private const val NOTIFICATION_ID = 4242
    private const val WAKE_LOCK_TAG = "ConnectCommunications:SipKeepAlive"

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

    fun start(context: Context) {
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
      try {
        context.stopService(Intent(context, SipKeepAliveService::class.java))
        Log.i(TAG, "stop: dispatched stopService")
      } catch (t: Throwable) {
        Log.w(TAG, "stop failed: ${t.message}")
      }
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onCreate() {
    super.onCreate()
    Log.i(TAG, "onCreate")
    serviceCreatedAtMs = System.currentTimeMillis()
    serviceDestroyedAtMs = 0
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i(TAG, "onStartCommand startId=$startId")
    val foregrounded = startForegroundSafely()
    if (foregrounded) {
      isRunning = true
      acquireWakeLock()
    } else {
      // We could not enter foreground state. Returning START_STICKY would let
      // the system silently restart us into the same failure. Stop the service
      // so the failure is visible (the keepalive notification stays missing
      // and the diagnostics surface lastForegroundResult="threw"), and let JS
      // fall back to the wake-then-dial path entirely.
      isRunning = false
      Log.w(TAG, "onStartCommand: startForeground failed, stopping service to avoid silent restart loop")
      stopSelf(startId)
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  override fun onDestroy() {
    Log.i(TAG, "onDestroy")
    serviceDestroyedAtMs = System.currentTimeMillis()
    isRunning = false
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // The user swiped the app away from recents. On most OEMs the OS tears
    // down non-foreground services here; because we ARE foreground with a
    // valid notification, we survive. Log it so we can correlate during
    // latency testing.
    Log.i(TAG, "onTaskRemoved — user swiped recents. keepalive persists.")
    super.onTaskRemoved(rootIntent)
  }

  override fun onBind(intent: Intent?): IBinder? = null

  // ── Internals ───────────────────────────────────────────────────────────

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
    // declare `phoneCall|dataSync`, so PHONE_CALL, DATA_SYNC, and the combo
    // are all valid. SPECIAL_USE / MEDIA_PLAYBACK / etc. would throw
    // MissingForegroundServiceTypeException — we'd need a manifest update
    // to add those, which is its own change.
    val attempts: List<Pair<String, Int>> = listOf(
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

  private fun buildNotification(): Notification {
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
}
