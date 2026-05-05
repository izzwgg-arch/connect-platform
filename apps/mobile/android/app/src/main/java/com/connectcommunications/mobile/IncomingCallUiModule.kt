package com.connectcommunications.mobile

import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.lang.ref.WeakReference

/**
 * JS bridge to dismiss the native incoming-call notification and stop the
 * native ringtone immediately when Answer/Decline is handled in JavaScript.
 */
class IncomingCallUiModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  init {
    // Track the most recent ReactApplicationContext so other Android
    // components (IncomingCallFirebaseService, lifecycle hooks) can emit
    // events back into JS without owning a direct reference.
    lastReactContext = WeakReference(reactContext)
  }

  override fun getName(): String = "IncomingCallUi"

  override fun initialize() {
    super.initialize()
    lastReactContext = WeakReference(reactApplicationContext)
    // Telecom events that fired while the React instance was still booting
    // are buffered by TelecomBridge — flush them now that JS is alive.
    try {
      TelecomBridge.drainPendingEvents()
    } catch (t: Throwable) {
      Log.w(TAG, "TelecomBridge.drainPendingEvents failed: ${t.message}")
    }
  }

  companion object {
    private const val TAG = "IncomingCallUiModule"
    private const val EVENT_INCOMING_CALL_FOREGROUND = "IncomingCall.ForegroundInvite"
    /**
     * Push-wake (Option 2) event. Fired by IncomingCallFirebaseService when an
     * INCOMING_CALL_WAKE FCM data message arrives. JS (SipContext) listens and
     * triggers JsSIP register({ forceRestart: true }) so the device is online
     * before the PBX dials in ~6 seconds.
     */
    private const val EVENT_SIP_WAKE_REGISTER = "Sip.WakeRegister"
    /**
     * Fired when the user taps an action button on the persistent in-call
     * notification (Hangup, Toggle Speaker, Toggle Mute). Payload:
     *   { action: "hangup" | "toggle_speaker" | "toggle_mute", value?: bool }
     * SipContext subscribes and translates each into a JsSIP / ICM call.
     */
    private const val EVENT_IN_CALL_ACTION = "Sip.InCallNotificationAction"

    @JvmStatic
    private var lastReactContext: WeakReference<ReactApplicationContext>? = null

    /**
     * Emits a "foreground incoming call" event to JavaScript carrying the
     * invite payload written by IncomingCallFirebaseService. JS listens for
     * this event and mounts IncomingCallScreen directly, independent of
     * JsSIP's newRTCSession signal (which can be silently delayed when the
     * WSS socket is stale after returning from background).
     */
    @JvmStatic
    fun emitForegroundInvite(payload: WritableMap) {
      val ctx = lastReactContext?.get()
      if (ctx == null) {
        Log.w(TAG, "emitForegroundInvite: no ReactApplicationContext cached yet")
        return
      }
      if (!ctx.hasActiveReactInstance()) {
        Log.w(TAG, "emitForegroundInvite: ReactContext has no active instance — dropping event")
        return
      }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_INCOMING_CALL_FOREGROUND, payload)
        Log.i(TAG, "emitForegroundInvite: dispatched $EVENT_INCOMING_CALL_FOREGROUND to JS")
      } catch (t: Throwable) {
        Log.w(TAG, "emitForegroundInvite failed: ${t.message}")
      }
    }

    /**
     * Push-wake bridge: tells the JS SipContext that an INCOMING_CALL_WAKE FCM
     * push just landed for the given pbxCallId. SipContext should immediately
     * call sip.register({ forceRestart: true }) and POST DEVICE_REGISTER_*
     * events to /mobile/wake/event so the backend timeline shows the full
     * sequence.
     *
     * Native side ALWAYS starts the SipKeepAliveService BEFORE emitting this
     * event so the JS process gets the FOREGROUND_SERVICE importance bump it
     * needs to keep the WSS socket open while it re-registers.
     */
    @JvmStatic
    fun emitSipWakeRegister(payload: WritableMap) {
      val ctx = lastReactContext?.get()
      if (ctx == null) {
        Log.w(TAG, "emitSipWakeRegister: no ReactApplicationContext cached yet — wake event dropped (JS not yet booted)")
        return
      }
      if (!ctx.hasActiveReactInstance()) {
        Log.w(TAG, "emitSipWakeRegister: ReactContext has no active instance — wake event dropped (JS booting?)")
        return
      }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_SIP_WAKE_REGISTER, payload)
        Log.i(TAG, "emitSipWakeRegister: dispatched $EVENT_SIP_WAKE_REGISTER to JS")
      } catch (t: Throwable) {
        Log.w(TAG, "emitSipWakeRegister failed: ${t.message}")
      }
    }

    /**
     * Forwards a tap on one of the in-call notification action buttons to
     * the JS layer. Wrapped in a try/catch so a missing React context
     * (extremely unlikely while a call is active, but possible during a
     * mid-call cold-restart race) cannot crash the BroadcastReceiver.
     */
    /**
     * Returns true iff the React Native context exists AND the JS instance
     * is alive. Used by TelecomBridge to decide whether to emit an event
     * straight to JS or buffer it for replay once the bundle has booted.
     */
    @JvmStatic
    fun hasActiveReactContext(): Boolean {
      val ctx = lastReactContext?.get() ?: return false
      return try { ctx.hasActiveReactInstance() } catch (_: Throwable) { false }
    }

    /**
     * Telecom→JS event emitter. The event name is dynamic
     * (Telecom.Answer / Telecom.Reject / Telecom.Disconnect / Telecom.Failed)
     * so a single helper handles every Telecom callback. JS subscribes to
     * each name via DeviceEventEmitter in NotificationsContext.
     */
    @JvmStatic
    fun emitTelecomEvent(name: String, payload: WritableMap) {
      val ctx = lastReactContext?.get()
      if (ctx == null || !ctx.hasActiveReactInstance()) {
        Log.w(TAG, "emitTelecomEvent($name): no active React context — TelecomBridge will buffer")
        return
      }
      try {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(name, payload)
        Log.i(TAG, "emitTelecomEvent: dispatched $name to JS")
      } catch (t: Throwable) {
        Log.w(TAG, "emitTelecomEvent($name) failed: ${t.message}")
      }
    }

    @JvmStatic
    fun emitInCallAction(action: String, value: Boolean? = null) {
      val ctx = lastReactContext?.get() ?: run {
        Log.w(TAG, "emitInCallAction($action): no ReactApplicationContext cached")
        return
      }
      if (!ctx.hasActiveReactInstance()) {
        Log.w(TAG, "emitInCallAction($action): ReactContext has no active instance")
        return
      }
      try {
        val payload = Arguments.createMap()
        payload.putString("action", action)
        if (value != null) payload.putBoolean("value", value)
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit(EVENT_IN_CALL_ACTION, payload)
        Log.i(TAG, "emitInCallAction: dispatched $action value=$value")
      } catch (t: Throwable) {
        Log.w(TAG, "emitInCallAction failed: ${t.message}")
      }
    }
  }

  /**
   * Native logging sink for the call-latency instrumentation. JS calls
   * this from callLatency.ts so events always reach `adb logcat` even in
   * release builds where Hermes does not pipe `console.log` to
   * android.util.Log. Non-blocking fire-and-forget.
   *
   * Greppable tag: `CALL_LATENCY_NATIVE`. Payload is the single-line
   * string exactly as produced by JS (e.g.
   * `[CALL_LATENCY] event=ANSWER_TAPPED +120ms total=850ms id=...`).
   */
  @ReactMethod
  fun logLatency(line: String?) {
    if (line.isNullOrEmpty()) return
    Log.i("CALL_LATENCY_NATIVE", line)
  }

  /**
   * Stage 2 bridge — turn the persistent SIP keep-alive foreground service
   * on or off. Called from SipContext in JS:
   *   • `setKeepAliveEnabled(true)` on app boot after provisioning is
   *     loaded and on successful login. Starts SipKeepAliveService, which
   *     keeps the JS process in the foreground importance tier so Samsung
   *     / Xiaomi / OPPO cannot kill our WebSocket or freeze our timers.
   *   • `setKeepAliveEnabled(false)` on logout. Stops the service so the
   *     user does not see a "Connect is running" notification when they
   *     are signed out.
   *
   * The enabled flag is persisted so BootReceiver can restart the service
   * after device reboot without needing to spin up a ReactInstance.
   */
  @ReactMethod
  fun setKeepAliveEnabled(enabled: Boolean) {
    val ctx = reactApplicationContext.applicationContext
    BootReceiver.setEnabled(ctx, enabled)
    if (enabled) {
      Log.i(TAG, "setKeepAliveEnabled(true) — starting SipKeepAliveService")
      SipKeepAliveService.start(ctx)
    } else {
      Log.i(TAG, "setKeepAliveEnabled(false) — stopping SipKeepAliveService")
      SipKeepAliveService.stop(ctx)
    }
  }

  /**
   * Returns true if the OS has whitelisted this app from Doze / battery
   * optimizations (i.e. the user has granted "Not optimized" / "Don't
   * optimize battery usage"). On Samsung this is the single most important
   * knob for keeping SIP alive in the background — our foreground service
   * can still be killed under memory pressure without it.
   */
  @ReactMethod
  fun isBatteryOptimizationIgnored(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        promise.resolve(true)
        return
      }
      val ctx = reactApplicationContext.applicationContext
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val ignored = pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: false
      promise.resolve(ignored)
    } catch (t: Throwable) {
      Log.w(TAG, "isBatteryOptimizationIgnored failed: ${t.message}")
      promise.resolve(false)
    }
  }

  /**
   * Launches the system dialog that asks the user to exempt Connect from
   * battery optimization. Uses ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
   * when possible (single-tap grant), and falls back to the battery
   * optimization settings screen on OEMs that block the direct intent.
   *
   * Resolves true if the exemption is in place after the call, false
   * otherwise. JS decides whether to prompt again next launch based on
   * that result.
   */
  @ReactMethod
  fun requestBatteryOptimizationExclusion(promise: Promise) {
    try {
      val ctx = reactApplicationContext.applicationContext
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        promise.resolve(true)
        return
      }
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (pm != null && pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
        Log.i(TAG, "requestBatteryOptimizationExclusion: already ignored")
        promise.resolve(true)
        return
      }
      val activity = currentActivity
      val intentTarget: Context = activity ?: ctx
      val directIntent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${ctx.packageName}")
        if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        intentTarget.startActivity(directIntent)
        Log.i(TAG, "requestBatteryOptimizationExclusion: launched direct ACTION_REQUEST intent")
        promise.resolve(false) // user hasn't accepted yet; JS re-polls
        return
      } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "direct ACTION_REQUEST intent unavailable: ${e.message}")
      } catch (t: Throwable) {
        Log.w(TAG, "direct ACTION_REQUEST intent failed: ${t.message}")
      }
      // Fallback: open the battery-optimization settings list so the user
      // can manually switch Connect to "Not optimized".
      val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
        if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        intentTarget.startActivity(fallback)
        Log.i(TAG, "requestBatteryOptimizationExclusion: launched fallback settings screen")
      } catch (t: Throwable) {
        Log.w(TAG, "fallback settings intent failed: ${t.message}")
      }
      promise.resolve(false)
    } catch (t: Throwable) {
      Log.w(TAG, "requestBatteryOptimizationExclusion crashed: ${t.message}")
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun dismiss(inviteId: String?) {
    IncomingCallFirebaseService.dismissIncomingCallUi(
      reactApplicationContext,
      inviteId,
      "js_incoming_call_ui_dismiss",
    )
  }

  @ReactMethod
  fun stopRingtone(inviteId: String?) {
    IncomingCallFirebaseService.stopIncomingCallRingtone("js_stop_ringtone", inviteId)
  }

  /** Clears show-when-locked / turn-screen-on after a call so hangup does not leave a blank stage. */
  @ReactMethod
  fun clearLockScreenCallPresentation() {
    val activity = reactApplicationContext.currentActivity as? MainActivity ?: return
    activity.runOnUiThread {
      MainActivity.clearIncomingCallWindowFlags(activity)
    }
  }

  /**
   * Returns native ringtone timing info for the flight recorder.
   * JS reads this after the call completes to add RINGTONE_START / RINGTONE_STOP events
   * with accurate native timestamps even when JS wasn't running when ringtone started.
   *
   * Returns a map with: startedAtMs, stoppedAtMs, source, stopReason.
   * startedAtMs = 0 means ringtone never started this session.
   */
  // CRITICAL: return type MUST be `WritableMap` (interface), NOT
  // `WritableNativeMap` (concrete class). React Native's synchronous
  // bridge metadata generator throws
  //   "Got unknown return class: WritableNativeMap"
  // when it encounters the concrete class, and that failure poisons the
  // entire IncomingCallUi module — every later `NativeModules.IncomingCallUi`
  // access (dismiss, isDeviceLocked, consumeLaunchedFromIncomingCall,
  // moveToBackground, …) throws with the same error, which is exactly
  // what was making answer-from-heads-up silently fail with "stuck on
  // Connecting…". Keep this as `WritableMap`.
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getRingtoneTimings(): WritableMap {
    val map = Arguments.createMap()
    map.putDouble("startedAtMs", IncomingCallFirebaseService.ringtoneStartedAtMs.toDouble())
    map.putDouble("stoppedAtMs", IncomingCallFirebaseService.ringtoneStoppedAtMs.toDouble())
    map.putString("source", IncomingCallFirebaseService.ringtoneSource ?: "")
    map.putString("stopReason", IncomingCallFirebaseService.ringtoneStopReason ?: "")
    return map
  }

  /** Resets ringtone timing state so next call starts fresh. */
  @ReactMethod
  fun resetRingtoneTimings() {
    IncomingCallFirebaseService.ringtoneStartedAtMs = 0
    IncomingCallFirebaseService.ringtoneStoppedAtMs = 0
    IncomingCallFirebaseService.ringtoneSource = null
    IncomingCallFirebaseService.ringtoneStopReason = null
  }

  /**
   * Multi-call busy flag. Set to true whenever the JS CallSessionManager has
   * at least one `active` call. The native IncomingCallFirebaseService reads
   * this flag on the next INCOMING_CALL FCM to:
   *   - suppress the full-screen incoming-call intent (a banner in
   *     ActiveCallScreen handles the waiting call instead),
   *   - skip the loud native ringtone (the app plays a short in-call beep
   *     through the SIP audio path so the peer's audio is not interrupted).
   *
   * The flag persists across service restarts because it is a single static
   * boolean on the service class — this is sufficient because FCM delivery
   * and service rebirth happen within the same process.
   */
  @ReactMethod
  fun setInActiveCall(active: Boolean) {
    IncomingCallFirebaseService.inActiveCall = active
    Log.i(TAG, "setInActiveCall active=$active — native full-screen intent ${if (active) "suppressed" else "allowed"}")
  }

  /**
   * Moves the app task to the background, revealing the lock screen (or home screen).
   * Called after a call ends that was answered from the lock screen so the phone
   * returns to the lock screen rather than showing the app's Quick page on top.
   */
  @ReactMethod
  fun moveToBackground() {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      activity.moveTaskToBack(true)
    }
  }

  /**
   * Synchronous check: is the device keyguard locked right now?
   *
   * Used by the answer flow in NotificationsContext to decide whether to
   * flag the call as "answered from lock screen" so that on hangup we can
   * moveTaskToBack() and expose the lock screen again, instead of leaving
   * the user on QuickAction and forcing a back-press.
   *
   * We cannot rely on AppState==='active' for this decision: with the
   * static android:showWhenLocked="true" in AndroidManifest.xml (added so
   * repeated lock-screen calls surface UI reliably), MainActivity resumes
   * above the keyguard and AppState flips to 'active' even though the
   * device is still locked. KeyguardManager is the source of truth.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun isDeviceLocked(): Boolean {
    return try {
      val km = reactApplicationContext
        .getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      km?.isKeyguardLocked == true
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Returns true if MainActivity was launched / resumed via the incoming-call
   * full-screen pending intent (or notification answer/decline action) since
   * the last consumption. ALSO RESETS the flag so a single call's hangup can
   * only trigger one moveTaskToBack.
   *
   * This is the authoritative signal for "should we return to the lock screen
   * after hangup?" — KeyguardManager.isKeyguardLocked() is unreliable on
   * Samsung One UI once MainActivity surfaces over the keyguard.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun consumeLaunchedFromIncomingCall(): Boolean {
    val v = MainActivity.launchedFromIncomingCall
    MainActivity.launchedFromIncomingCall = false
    return v
  }

  /**
   * Enumerate the current audio output landscape.
   *
   * Returns a WritableMap with:
   *   bluetoothConnected  - true iff a Bluetooth SCO / A2DP headset is
   *                         currently reachable as an OUTPUT device. Uses
   *                         AudioManager.getDevices(GET_DEVICES_OUTPUTS)
   *                         on API 23+ (supported on every device we ship
   *                         to). Falls back to the legacy
   *                         isBluetoothA2dpOn() / isBluetoothScoOn() flags
   *                         on older builds.
   *   wiredHeadsetConnected - analogous flag for 3.5mm / USB headsets.
   *   speakerphoneOn      - whether the phone's loudspeaker is currently
   *                         forced on via AudioManager.
   *
   * JS polls this every couple of seconds during an active call so the
   * speaker button can make the "Speaker ↔ Bluetooth" / "Speaker ↔
   * Earpiece" decision correctly. This is the authoritative source — the
   * react-native-incall-manager library does NOT expose a reliable
   * getAudioDeviceList() on v4.x.
   *
   * Blocking synchronous method: call is O(n) over AudioManager's device
   * list (n ≤ 10 in practice) and returns a tiny map, so it's safe to
   * invoke from the JS render loop.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getAudioDevices(): WritableMap {
    val map = Arguments.createMap()
    map.putBoolean("bluetoothConnected", false)
    map.putBoolean("wiredHeadsetConnected", false)
    map.putBoolean("speakerphoneOn", false)
    try {
      val am = reactApplicationContext
        .getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return map

      map.putBoolean("speakerphoneOn", am.isSpeakerphoneOn)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        var bt = false
        var wired = false
        for (d in devices) {
          when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> bt = true
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET -> wired = true
          }
        }
        // Hearing aids (API 28+) count as a non-speaker sink that the user
        // expects the "other" position of the speaker toggle to route to —
        // treat them like BT for routing purposes.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          for (d in devices) {
            if (d.type == AudioDeviceInfo.TYPE_HEARING_AID) { bt = true; break }
          }
        }
        map.putBoolean("bluetoothConnected", bt)
        map.putBoolean("wiredHeadsetConnected", wired)
      } else {
        @Suppress("DEPRECATION")
        map.putBoolean("bluetoothConnected", am.isBluetoothA2dpOn || am.isBluetoothScoOn)
        @Suppress("DEPRECATION")
        map.putBoolean("wiredHeadsetConnected", am.isWiredHeadsetOn)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "getAudioDevices failed: ${t.message}")
    }
    return map
  }

  /**
   * Force the active VoIP call audio to route to a Bluetooth headset.
   *
   * Invokes AudioManager.startBluetoothSco() which is the documented,
   * reliable way to force a Bluetooth SCO link during a VoIP call on
   * Android. setSpeakerphoneOn(false) is a no-op on some OEMs when we
   * really wanted BT specifically (they route to earpiece instead), so
   * this path is used as the explicit "go to BT" action from the
   * in-call speaker button.
   *
   * Must be paired with stopBluetoothSco() when switching away from BT
   * (e.g. to speaker) to release the SCO link cleanly.
   */
  @ReactMethod
  fun routeAudioToBluetooth() {
    try {
      val am = reactApplicationContext
        .getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      am.isSpeakerphoneOn = false
      if (!am.isBluetoothScoOn) {
        try { am.startBluetoothSco() } catch (_: Throwable) { }
        am.isBluetoothScoOn = true
      }
      Log.i(TAG, "routeAudioToBluetooth: SCO link requested")
    } catch (t: Throwable) {
      Log.w(TAG, "routeAudioToBluetooth failed: ${t.message}")
    }
  }

  @ReactMethod
  fun routeAudioToEarpiece() {
    try {
      val am = reactApplicationContext
        .getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      if (am.isBluetoothScoOn) {
        try { am.stopBluetoothSco() } catch (_: Throwable) { }
        am.isBluetoothScoOn = false
      }
      am.isSpeakerphoneOn = false
      Log.i(TAG, "routeAudioToEarpiece: SCO stopped, speakerphone off")
    } catch (t: Throwable) {
      Log.w(TAG, "routeAudioToEarpiece failed: ${t.message}")
    }
  }

  @ReactMethod
  fun routeAudioToSpeaker() {
    try {
      val am = reactApplicationContext
        .getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      if (am.isBluetoothScoOn) {
        try { am.stopBluetoothSco() } catch (_: Throwable) { }
        am.isBluetoothScoOn = false
      }
      am.isSpeakerphoneOn = true
      Log.i(TAG, "routeAudioToSpeaker: speakerphone on")
    } catch (t: Throwable) {
      Log.w(TAG, "routeAudioToSpeaker failed: ${t.message}")
    }
  }

  // ── In-call FGS bridge ─────────────────────────────────────────────────
  // These tell SipKeepAliveService when an active call begins / ends / changes
  // audio routing. The service uses this to:
  //   1. Re-promote its foreground type to include MICROPHONE while a call is
  //      live, which is the ONLY way Android 14+ keeps WebRTC mic capture
  //      alive when the app is backgrounded (without it the remote party
  //      hears silence the moment you switch apps).
  //   2. Swap its persistent notification to a CallStyle.forOngoingCall
  //      ringer with End / Speaker / Mute action buttons and a live
  //      chronometer, so the user can manage the call without bringing the
  //      app foreground.
  // The companion-object methods on SipKeepAliveService are reachable from
  // Kotlin without explicit `.Companion.` qualification.

  /**
   * Called by SipContext when a JsSIP session enters the `confirmed` state.
   * Triggers the in-call FGS + CallStyle notification on Android. iOS / web
   * have native CallKit handling so this is a no-op there.
   */
  @ReactMethod
  fun startInCallNotification(callerName: String?, callStartedAtMs: Double, speakerOn: Boolean, muted: Boolean) {
    try {
      val ctx = reactApplicationContext.applicationContext
      SipKeepAliveService.startInCall(
        ctx,
        callerName,
        callStartedAtMs.toLong(),
        speakerOn,
        muted,
      )
    } catch (t: Throwable) {
      Log.w(TAG, "startInCallNotification failed: ${t.message}")
    }
  }

  /**
   * Refresh the in-call notification's Speaker / Mute toggle visuals when
   * JS flips the underlying audio routing. No-op if no call is currently
   * active (the service simply rebuilds with whatever state it has).
   */
  @ReactMethod
  fun updateInCallNotification(speakerOn: Boolean, muted: Boolean) {
    try {
      val ctx = reactApplicationContext.applicationContext
      SipKeepAliveService.updateInCallState(ctx, speakerOn, muted)
    } catch (t: Throwable) {
      Log.w(TAG, "updateInCallNotification failed: ${t.message}")
    }
  }

  /**
   * Called when the call ends (ANY cause — normal, declined, ghosted, etc.).
   * Tears down the in-call FGS / CallStyle notification and restores the
   * idle "Ready to receive calls" minimal notification.
   */
  @ReactMethod
  fun stopInCallNotification() {
    try {
      val ctx = reactApplicationContext.applicationContext
      SipKeepAliveService.stopInCall(ctx)
    } catch (t: Throwable) {
      Log.w(TAG, "stopInCallNotification failed: ${t.message}")
    }
  }

  // ── Telecom JS bridge ─────────────────────────────────────────────────
  //
  // JS calls these to drive the OS-level call UI when the SIP layer
  // detects state transitions that did not originate from the user
  // tapping Answer / Decline in the system UI. The connection lookup is
  // by inviteId (the same id Telecom passed to JS on Telecom.Answer).

  /**
   * JS reports the SIP UA acknowledged the user's answer (200 OK sent /
   * media established). Flips the OS Connection to ACTIVE so the system
   * call UI shows the in-call timer and the lock-screen banner clears.
   */
  @ReactMethod
  fun telecomMarkActive(inviteId: String?) {
    val id = inviteId ?: return
    try {
      TelecomBridge.getActiveConnection(id)?.markActive()
        ?: Log.w(TAG, "telecomMarkActive: no Connection for inviteId=$id")
    } catch (t: Throwable) {
      Log.w(TAG, "telecomMarkActive failed: ${t.message}")
    }
  }

  /**
   * JS reports the call ended (remote hangup, network loss, server cancel,
   * JS-side decline). Tears down the OS Connection cleanly with a reason
   * code so the system call log reflects what actually happened.
   *
   * Reasons accepted: remote_hangup | missed | canceled | rejected | other
   */
  @ReactMethod
  fun telecomTerminate(inviteId: String?, reason: String?) {
    val id = inviteId ?: return
    try {
      TelecomBridge.getActiveConnection(id)?.terminate(reason ?: "other")
        ?: Log.w(TAG, "telecomTerminate: no Connection for inviteId=$id")
    } catch (t: Throwable) {
      Log.w(TAG, "telecomTerminate failed: ${t.message}")
    }
  }

  /**
   * Synchronous lookup — true iff Telecom currently owns a Connection for
   * this inviteId. Lets the JS answer pipeline distinguish "OS-driven
   * answer (Telecom UI)" from "in-app answer (React UI)" so it does not
   * try to mark a non-Telecom call active.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun telecomHasConnection(inviteId: String?): Boolean {
    val id = inviteId ?: return false
    return try { TelecomBridge.getActiveConnection(id) != null } catch (_: Throwable) { false }
  }

  // NativeEventEmitter support — required by React Native on Android so that
  // `new NativeEventEmitter(NativeModules.IncomingCallUi)` does not warn
  // ("`new NativeEventEmitter()` was called with a non-null argument without
  // the required `addListener` method"). No-op bodies; we emit directly via
  // RCTDeviceEventEmitter above.
  @ReactMethod
  fun addListener(eventName: String?) {
    // no-op: NativeEventEmitter tracking happens on the JS side
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // no-op: NativeEventEmitter tracking happens on the JS side
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Call-wake diagnostics bridge.
  //
  // These are read by the in-app Diagnostics screen so the user (and we) can
  // see in real time:
  //   • whether the OS still grants USE_FULL_SCREEN_INTENT (Android 14+ can
  //     silently revoke this from non-call-category apps — the single most
  //     likely Samsung S25 wake regression),
  //   • whether POST_NOTIFICATIONS is granted,
  //   • the current importance of the connect-incoming-ui-* channel,
  //   • when the FCM push was last physically received in onMessageReceived,
  //   • when the native incoming-call notification was last posted.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Android 14+ runtime check: returns true iff the OS still allows this app
   * to launch a full-screen intent from a notification. On older releases this
   * always resolves true (the manifest permission is sufficient).
   */
  @ReactMethod
  fun canUseFullScreenIntent(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        promise.resolve(true)
        return
      }
      val ctx = reactApplicationContext.applicationContext
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      val allowed = nm?.canUseFullScreenIntent() ?: false
      promise.resolve(allowed)
    } catch (t: Throwable) {
      Log.w(TAG, "canUseFullScreenIntent failed: ${t.message}")
      promise.resolve(true)
    }
  }

  /** Whether the user has granted POST_NOTIFICATIONS (Android 13+). */
  @ReactMethod
  fun areNotificationsEnabled(promise: Promise) {
    try {
      val ctx = reactApplicationContext.applicationContext
      val ok = NotificationManagerCompat.from(ctx).areNotificationsEnabled()
      promise.resolve(ok)
    } catch (t: Throwable) {
      Log.w(TAG, "areNotificationsEnabled failed: ${t.message}")
      promise.resolve(true)
    }
  }

  /**
   * Importance of the incoming-call notification channel as the OS sees it
   * right now. Returns -1 on pre-O or if the channel hasn't been created yet.
   * Maps directly to NotificationManager.IMPORTANCE_* constants.
   */
  @ReactMethod
  fun getCallChannelImportance(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        promise.resolve(NotificationManager.IMPORTANCE_HIGH)
        return
      }
      val ctx = reactApplicationContext.applicationContext
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      val ch = nm?.getNotificationChannel("connect-incoming-ui-v6")
      promise.resolve(ch?.importance ?: -1)
    } catch (t: Throwable) {
      Log.w(TAG, "getCallChannelImportance failed: ${t.message}")
      promise.resolve(-1)
    }
  }

  /**
   * Synchronous device snapshot: manufacturer / model / brand / OS / SDK /
   * package / app-version. Sent up by the mobile registration flow so the
   * backend can correlate "S24 works, S25 broken" without guessing.
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getDeviceInfo(): WritableMap {
    val map = Arguments.createMap()
    try {
      map.putString("manufacturer", Build.MANUFACTURER ?: "")
      map.putString("model", Build.MODEL ?: "")
      map.putString("brand", Build.BRAND ?: "")
      map.putString("device", Build.DEVICE ?: "")
      map.putString("hardware", Build.HARDWARE ?: "")
      map.putString("osVersion", Build.VERSION.RELEASE ?: "")
      map.putInt("sdkInt", Build.VERSION.SDK_INT)
      val ctx = reactApplicationContext.applicationContext
      map.putString("packageName", ctx.packageName ?: "")
      try {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        map.putString("appVersion", info.versionName ?: "")
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        map.putString("appBuild", code.toString())
      } catch (_: PackageManager.NameNotFoundException) {
      }
    } catch (t: Throwable) {
      Log.w(TAG, "getDeviceInfo failed: ${t.message}")
    }
    return map
  }

  /**
   * Snapshot of the wake path's most recent activity:
   *   - lastPushReceivedAtMs : when FCM physically delivered onMessageReceived
   *   - lastPushType         : payload type ("INCOMING_CALL", "INVITE_CANCELED", …)
   *   - lastPushInviteId     : inviteId / callId on the most recent push
   *   - lastPushReceivedAppState : process importance bucket at the time
   *   - lastIncomingUiDisplayedAtMs : when the CallStyle notification posted
   *   - lastIncomingUiPresentation  : "full_screen" | "heads_up"
   *   - lastPushError        : last non-fatal error (e.g. POST_NOTIFICATIONS denied)
   *
   * 0 / "" mean "no event recorded since process start". Reading this from JS
   * after a missed S25 wake tells you which step failed (push didn't arrive
   * vs notification didn't post vs full-screen intent was downgraded).
   */
  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getCallWakeDiagnostics(): WritableMap {
    val map = Arguments.createMap()
    map.putDouble("lastPushReceivedAtMs", IncomingCallFirebaseService.lastPushReceivedAtMs.toDouble())
    map.putString("lastPushType", IncomingCallFirebaseService.lastPushType ?: "")
    map.putString("lastPushInviteId", IncomingCallFirebaseService.lastPushInviteId ?: "")
    map.putString("lastPushReceivedAppState", IncomingCallFirebaseService.lastPushReceivedAppState ?: "")
    map.putDouble("lastIncomingUiDisplayedAtMs", IncomingCallFirebaseService.lastIncomingUiDisplayedAtMs.toDouble())
    map.putString("lastIncomingUiPresentation", IncomingCallFirebaseService.lastIncomingUiPresentation ?: "")
    map.putString("lastPushError", IncomingCallFirebaseService.lastPushError ?: "")
    map.putDouble("ringtoneStartedAtMs", IncomingCallFirebaseService.ringtoneStartedAtMs.toDouble())
    map.putDouble("ringtoneStoppedAtMs", IncomingCallFirebaseService.ringtoneStoppedAtMs.toDouble())
    map.putString("ringtoneStopReason", IncomingCallFirebaseService.ringtoneStopReason ?: "")
    // Push-wake (Option 2) snapshot
    map.putDouble("lastWakePushReceivedAtMs", IncomingCallFirebaseService.lastWakePushReceivedAtMs.toDouble())
    map.putString("lastWakePushPbxCallId", IncomingCallFirebaseService.lastWakePushPbxCallId ?: "")
    map.putString("lastWakePushExtension", IncomingCallFirebaseService.lastWakePushExtension ?: "")
    map.putDouble("lastWakeBridgeEmittedAtMs", IncomingCallFirebaseService.lastWakeBridgeEmittedAtMs.toDouble())
    map.putString("lastWakeBridgeStatus", IncomingCallFirebaseService.lastWakeBridgeStatus ?: "")
    // Wake placeholder notification (the early "Incoming call — connecting…"
    // heads-up). Lets Diagnostics show "yes the OS told the user a call was
    // coming even though SIP REGISTER took 5s after that".
    map.putDouble("lastWakePlaceholderPostedAtMs", IncomingCallFirebaseService.lastWakePlaceholderPostedAtMs.toDouble())
    map.putString("lastWakePlaceholderResult", IncomingCallFirebaseService.lastWakePlaceholderResult ?: "")
    // Stage 2 keep-alive foreground service status. Surfacing this lets the
    // Diagnostics screen prove "the FGS that should hold the WSS open is
    // actually running" or "no, startForeground threw <X> because Android 15
    // / One UI 7 rejects PHONE_CALL FGS without an active call". Without
    // these fields the only way to find out was logcat — useless for users.
    map.putBoolean("keepAliveIsRunning", SipKeepAliveService.isRunning)
    map.putDouble("keepAliveServiceCreatedAtMs", SipKeepAliveService.serviceCreatedAtMs.toDouble())
    map.putDouble("keepAliveServiceDestroyedAtMs", SipKeepAliveService.serviceDestroyedAtMs.toDouble())
    map.putDouble("keepAliveLastStartAttemptAtMs", SipKeepAliveService.lastStartAttemptAtMs.toDouble())
    map.putString("keepAliveLastStartResult", SipKeepAliveService.lastStartResult)
    map.putString("keepAliveLastStartErrorClass", SipKeepAliveService.lastStartErrorClass)
    map.putString("keepAliveLastStartErrorMessage", SipKeepAliveService.lastStartErrorMessage)
    map.putDouble("keepAliveLastForegroundAttemptAtMs", SipKeepAliveService.lastForegroundAttemptAtMs.toDouble())
    map.putString("keepAliveLastForegroundResult", SipKeepAliveService.lastForegroundResult)
    map.putString("keepAliveLastForegroundTypeUsed", SipKeepAliveService.lastForegroundTypeUsed)
    map.putString("keepAliveLastForegroundErrorClass", SipKeepAliveService.lastForegroundErrorClass)
    map.putString("keepAliveLastForegroundErrorMessage", SipKeepAliveService.lastForegroundErrorMessage)
    return map
  }

  /**
   * Opens the Android 14+ "Allow full-screen notifications" page for this
   * app. Called from the Diagnostics screen "Fix Call Reliability" flow when
   * canUseFullScreenIntent() returns false. Falls back gracefully on older
   * OS versions / OEMs that don't expose the action.
   */
  @ReactMethod
  fun requestFullScreenIntentPermission(promise: Promise) {
    val ctx = reactApplicationContext.applicationContext
    try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        promise.resolve(true)
        return
      }
      val activity = currentActivity
      val target: Context = activity ?: ctx
      val intent = Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT).apply {
        data = Uri.parse("package:${ctx.packageName}")
        if (activity == null) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      target.startActivity(intent)
      Log.i(TAG, "requestFullScreenIntentPermission: launched MANAGE_APP_USE_FULL_SCREEN_INTENT")
      promise.resolve(true)
    } catch (e: ActivityNotFoundException) {
      Log.w(TAG, "requestFullScreenIntentPermission: action not available, falling back to app settings")
      try {
        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
          data = Uri.parse("package:${ctx.packageName}")
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(fallback)
        promise.resolve(false)
      } catch (t: Throwable) {
        Log.w(TAG, "requestFullScreenIntentPermission fallback failed: ${t.message}")
        promise.resolve(false)
      }
    } catch (t: Throwable) {
      Log.w(TAG, "requestFullScreenIntentPermission failed: ${t.message}")
      promise.resolve(false)
    }
  }
}
