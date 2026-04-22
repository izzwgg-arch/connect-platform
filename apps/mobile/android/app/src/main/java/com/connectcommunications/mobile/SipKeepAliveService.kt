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

    fun start(context: Context) {
      val intent = Intent(context, SipKeepAliveService::class.java)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        Log.i(TAG, "start: dispatched startForegroundService")
      } catch (t: Throwable) {
        Log.w(TAG, "start failed: ${t.message}")
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
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i(TAG, "onStartCommand startId=$startId")
    startForegroundSafely()
    acquireWakeLock()
    // STICKY so the system re-creates the service if it is killed for memory
    // pressure — that is exactly the scenario we are trying to defeat.
    return START_STICKY
  }

  override fun onDestroy() {
    Log.i(TAG, "onDestroy")
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

  private fun startForegroundSafely() {
    val notification = buildNotification()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        // Android 14+ requires an explicit foregroundServiceType on startForeground.
        //
        // We combine PHONE_CALL | DATA_SYNC:
        //   • PHONE_CALL gives this service the highest FGS protection tier —
        //     the OS is far less willing to kill it under memory pressure than
        //     a plain dataSync service. We qualify: the app is a VoIP/SIP
        //     client, holds MANAGE_OWN_CALLS, and registers a
        //     ConnectionService (CallKeep) for in-call behavior. The keep-alive
        //     service is part of the phone-call pipeline — without it the
        //     inbound INVITE never reaches the device.
        //   • DATA_SYNC is kept as a secondary type so the service still has
        //     a legitimate foreground type on OEMs / scenarios where the
        //     phoneCall type is denied (e.g. when no dialer role is granted).
        //
        // On Samsung the previous DATA_SYNC-only configuration was killed with
        // "fg +50 FGS (273,1623) mem-pressure-event" roughly 16 s after
        // backgrounding, defeating the entire Stage 2 promise. PHONE_CALL sits
        // at a significantly lower oom_adj and survives those sweeps.
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      Log.i(TAG, "startForeground posted ongoing notification id=$NOTIFICATION_ID")
    } catch (t: Throwable) {
      Log.w(TAG, "startForeground failed: ${t.message}")
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
