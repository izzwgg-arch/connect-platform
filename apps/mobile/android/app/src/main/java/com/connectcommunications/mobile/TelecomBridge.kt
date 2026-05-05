package com.connectcommunications.mobile

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import com.facebook.react.bridge.Arguments

/**
 * Static helper around Android's TelecomManager. Owns:
 *   1. PhoneAccount registration (idempotent, fires once at app start).
 *   2. addNewIncomingCall(...) entry point used by the FCM service when a
 *      wake push arrives (works whether the JS engine is running or not).
 *   3. A registry of active {@link ConnectIncomingConnection} instances
 *      keyed by inviteId so the JS layer can drive them via
 *      IncomingCallUiModule (mark active, terminate on remote hangup, …).
 *   4. Bridge-out emitters that forward Telecom user actions (Answer /
 *      Reject / Hangup) into JS via DeviceEventEmitter — the JS layer
 *      listens and runs the SIP answer / reject pipeline.
 *
 * IMPORTANT: when the OS first delivers an FCM data message and our
 * process has been killed, the JS context does NOT exist yet. Telecom
 * still works because Android instantiates ConnectConnectionService on
 * its own and shows the system UI without our JS. We only attempt to emit
 * to JS when {@link IncomingCallUiModule} reports an active React
 * instance — otherwise the action is buffered and replayed once JS is up.
 */
object TelecomBridge {
  private const val TAG = "TelecomBridge"

  /**
   * PhoneAccount ID. Fixed across the app — we have exactly one VoIP
   * account per device. Changing this string breaks call continuity for
   * users on the prior version, so leave it stable.
   */
  private const val ACCOUNT_ID = "connect-mobile-voip"
  private const val ACCOUNT_LABEL = "Connect"
  private const val SCHEME_TEL = "tel"

  /**
   * Telecom event names exposed to JS via DeviceEventEmitter. Listened to
   * by NotificationsContext / SipContext on the React Native side.
   */
  private const val EVENT_TELECOM_ANSWER = "Telecom.Answer"
  private const val EVENT_TELECOM_REJECT = "Telecom.Reject"
  private const val EVENT_TELECOM_DISCONNECT = "Telecom.Disconnect"
  private const val EVENT_TELECOM_FAILED = "Telecom.Failed"

  @Volatile
  private var phoneAccountHandle: PhoneAccountHandle? = null

  // Connections live for the duration of a single call. We hold strong
  // references so the GC cannot collect them while Telecom still owns the
  // outer Connection instance — a collected reference would become a
  // dead object on the JS-bridge side and prevent us from terminating
  // calls cleanly.
  @SuppressLint("StaticFieldLeak")
  private val activeConnections: MutableMap<String, ConnectIncomingConnection> = mutableMapOf()

  // Pending Telecom events that fired before the React instance was alive.
  // We replay them as soon as IncomingCallUiModule reports a live React
  // context (see drainPendingEventsIfReactReady).
  private data class PendingEvent(val name: String, val payload: Bundle)
  private val pendingEvents = ArrayDeque<PendingEvent>()

  /**
   * Idempotent: registers a single SELF_MANAGED PhoneAccount with the
   * Telecom system. Call from MainApplication.onCreate(). Cheap to call
   * repeatedly — registerPhoneAccount is a no-op when the handle is
   * already registered with identical metadata.
   */
  fun ensurePhoneAccountRegistered(context: Context) {
    try {
      val tm = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
      if (tm == null) {
        Log.w(TAG, "ensurePhoneAccountRegistered: TelecomManager unavailable")
        return
      }
      val handle = phoneAccountHandle ?: PhoneAccountHandle(
        ComponentName(context, ConnectConnectionService::class.java),
        ACCOUNT_ID,
      )
      phoneAccountHandle = handle

      val builder = PhoneAccount.builder(handle, ACCOUNT_LABEL)
        .addSupportedUriScheme(SCHEME_TEL)
        .addSupportedUriScheme(PhoneAccount.SCHEME_SIP)
        .setShortDescription("Connect Communications VoIP")

      var capabilities = 0
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        capabilities = capabilities or PhoneAccount.CAPABILITY_SELF_MANAGED
      }
      // CAPABILITY_VIDEO_CALLING / CALL_PROVIDER omitted on purpose — we
      // are voice-only and SELF_MANAGED, never the system default dialer.
      builder.setCapabilities(capabilities)

      val account = builder.build()
      tm.registerPhoneAccount(account)
      Log.i(TAG, "ensurePhoneAccountRegistered: account registered handle=$handle capabilities=$capabilities")
    } catch (t: Throwable) {
      Log.w(TAG, "ensurePhoneAccountRegistered failed: ${t.message}", t)
    }
  }

  /**
   * Called by IncomingCallFirebaseService on every incoming-call wake push.
   * Asks the OS to display its native incoming-call UI; the OS spawns
   * ConnectConnectionService → ConnectIncomingConnection automatically.
   *
   * Returns true on success, false if Telecom rejected the request (in
   * which case the caller should fall back to the legacy notification-
   * based incoming-call UI so we never miss a call).
   */
  fun startIncomingCall(
    context: Context,
    inviteId: String,
    callerNumber: String?,
    callerName: String?,
    pbxCallId: String?,
  ): Boolean {
    return try {
      ensurePhoneAccountRegistered(context)
      val handle = phoneAccountHandle ?: run {
        Log.w(TAG, "startIncomingCall: no PhoneAccountHandle after register")
        return false
      }
      val tm = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        ?: return false

      // Verify the OS actually has our PhoneAccount enabled BEFORE dispatch.
      // On Samsung One UI 6+ / Android 16 the SELF_MANAGED auto-enable is
      // not always honored on first install — addNewIncomingCall returns
      // void and silently no-ops, so the only way to know it will fail is
      // to check the account state up-front. When disabled we return false
      // immediately so the caller falls back to the legacy CallStyle/FSI
      // path and the user still sees a ringing UI.
      if (!isPhoneAccountEnabled(tm, handle)) {
        Log.w(TAG, "startIncomingCall: PhoneAccount not enabled — skipping Telecom dispatch (legacy fallback will fire)")
        return false
      }

      val numberSan = (callerNumber ?: "").replace("[^+0-9]".toRegex(), "").ifEmpty { "0000000000" }
      val callUri = Uri.fromParts(SCHEME_TEL, numberSan, null)

      val extras = Bundle().apply {
        putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, callUri)
        val callExtras = Bundle().apply {
          putString(ConnectConnectionService.EXTRA_INVITE_ID, inviteId)
          putString(ConnectConnectionService.EXTRA_CALLER_NUMBER, callerNumber ?: "")
          putString(ConnectConnectionService.EXTRA_CALLER_NAME, callerName ?: "")
          putString(ConnectConnectionService.EXTRA_PBX_CALL_ID, pbxCallId ?: "")
        }
        putBundle(TelecomManager.EXTRA_INCOMING_CALL_EXTRAS, callExtras)
      }

      tm.addNewIncomingCall(handle, extras)
      Log.i(TAG, "startIncomingCall: addNewIncomingCall dispatched inviteId=$inviteId from=$callerNumber name=$callerName")
      true
    } catch (se: SecurityException) {
      // Telecom rejects addNewIncomingCall when the PhoneAccount is not
      // enabled (some OEMs require the user to enable our account in the
      // Calling Accounts screen, even for SELF_MANAGED). We log and fall
      // back to the legacy notification path.
      Log.w(TAG, "startIncomingCall SecurityException — PhoneAccount likely not enabled: ${se.message}")
      false
    } catch (t: Throwable) {
      Log.w(TAG, "startIncomingCall failed: ${t.message}", t)
      false
    }
  }

  /**
   * Reads the PhoneAccount the OS currently knows about for our handle and
   * returns true iff it exists AND is enabled. {@code getPhoneAccount} can
   * return null if registration failed silently (e.g. ComponentName not
   * exported, or the OS dropped the account during a background-app
   * cleanup). We treat any non-true result as "do not dispatch via Telecom".
   *
   * Callable safely from any thread — TelecomManager is process-wide.
   */
  private fun isPhoneAccountEnabled(tm: TelecomManager, handle: PhoneAccountHandle): Boolean {
    return try {
      val pa = tm.getPhoneAccount(handle)
      val enabled = pa?.isEnabled == true
      if (!enabled) {
        Log.i(TAG, "isPhoneAccountEnabled=false (account=${pa != null}) handle=$handle")
      }
      enabled
    } catch (t: Throwable) {
      Log.w(TAG, "isPhoneAccountEnabled threw: ${t.message}")
      false
    }
  }

  /**
   * JS-callable diagnostic — true iff the OS currently has our PhoneAccount
   * registered AND enabled. Surfaced through IncomingCallUiModule so the
   * Diagnostics screen can show "Telecom ready: yes/no" and prompt the user
   * to open the Calling Accounts settings if it's no.
   */
  fun isPhoneAccountReady(context: Context): Boolean {
    return try {
      val tm = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return false
      val handle = phoneAccountHandle ?: return false
      isPhoneAccountEnabled(tm, handle)
    } catch (_: Throwable) {
      false
    }
  }

  // ── Connection registry ──────────────────────────────────────────────

  fun registerActiveConnection(inviteId: String, connection: ConnectIncomingConnection) {
    if (inviteId.isEmpty()) return
    synchronized(activeConnections) {
      activeConnections[inviteId] = connection
    }
    Log.i(TAG, "registerActiveConnection inviteId=$inviteId active=${activeConnections.size}")
  }

  fun unregisterActiveConnection(inviteId: String) {
    if (inviteId.isEmpty()) return
    synchronized(activeConnections) {
      activeConnections.remove(inviteId)
    }
    Log.i(TAG, "unregisterActiveConnection inviteId=$inviteId remaining=${activeConnections.size}")
  }

  fun getActiveConnection(inviteId: String): ConnectIncomingConnection? {
    if (inviteId.isEmpty()) return null
    return synchronized(activeConnections) { activeConnections[inviteId] }
  }

  // ── Bridge out: Telecom → JS ─────────────────────────────────────────

  fun notifyAnswer(inviteId: String, callerNumber: String, callerName: String, pbxCallId: String) {
    val payload = Bundle().apply {
      putString("inviteId", inviteId)
      putString("callerNumber", callerNumber)
      putString("callerName", callerName)
      putString("pbxCallId", pbxCallId)
    }
    emitOrBuffer(EVENT_TELECOM_ANSWER, payload)
  }

  fun notifyReject(inviteId: String, reason: String) {
    val payload = Bundle().apply {
      putString("inviteId", inviteId)
      putString("reason", reason)
    }
    emitOrBuffer(EVENT_TELECOM_REJECT, payload)
  }

  fun notifyDisconnect(inviteId: String, reason: String) {
    val payload = Bundle().apply {
      putString("inviteId", inviteId)
      putString("reason", reason)
    }
    emitOrBuffer(EVENT_TELECOM_DISCONNECT, payload)
  }

  fun notifyConnectionFailed(inviteId: String, reason: String) {
    val payload = Bundle().apply {
      putString("inviteId", inviteId)
      putString("reason", reason)
    }
    emitOrBuffer(EVENT_TELECOM_FAILED, payload)
  }

  /**
   * Replay any pending Telecom events through the JS bridge once the React
   * instance is alive. Called by IncomingCallUiModule.initialize() after
   * the React context has been wired up.
   */
  fun drainPendingEvents() {
    val drained = synchronized(pendingEvents) {
      val list = pendingEvents.toList()
      pendingEvents.clear()
      list
    }
    if (drained.isEmpty()) return
    Log.i(TAG, "drainPendingEvents: replaying ${drained.size} buffered Telecom events")
    drained.forEach { emit(it.name, it.payload) }
  }

  private fun emitOrBuffer(name: String, payload: Bundle) {
    if (!IncomingCallUiModule.hasActiveReactContext()) {
      synchronized(pendingEvents) {
        // Cap the buffer to avoid pathological growth if JS never starts.
        while (pendingEvents.size >= 16) pendingEvents.removeFirst()
        pendingEvents.add(PendingEvent(name, payload))
      }
      Log.i(TAG, "emitOrBuffer: no active React instance — buffered $name (queue=${pendingEvents.size})")
      return
    }
    emit(name, payload)
  }

  private fun emit(name: String, payload: Bundle) {
    try {
      val map = Arguments.fromBundle(payload)
      IncomingCallUiModule.emitTelecomEvent(name, map)
    } catch (t: Throwable) {
      Log.w(TAG, "emit($name) failed: ${t.message}")
    }
  }
}
