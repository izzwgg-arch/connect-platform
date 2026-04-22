package com.connectcommunications.mobile

import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
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
  }

  companion object {
    private const val TAG = "IncomingCallUiModule"
    private const val EVENT_INCOMING_CALL_FOREGROUND = "IncomingCall.ForegroundInvite"

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
}
