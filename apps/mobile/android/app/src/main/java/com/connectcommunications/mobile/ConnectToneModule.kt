package com.connectcommunications.mobile

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * ConnectToneModule — plays short PCM WAV cues (DTMF digits, hang-up chime,
 * voice-note ticks) through a native AudioTrack.
 *
 * Why this exists (2026-07-29): the JS layer synthesises these cues as WAV
 * data-URIs and played them through expo-av. On Android that playback rides
 * the media stream, which is silenced whenever InCallManager holds
 * MODE_IN_COMMUNICATION — so every in-call cue (keypad DTMF, hang-up tone)
 * was created but inaudible, and the voice-note cues raced expo-av's own
 * recorder session. Playing the same PCM bytes on a native AudioTrack with
 * the right AudioAttributes sidesteps both: USAGE_VOICE_COMMUNICATION mixes
 * into the live call path (earpiece/speaker/BT — wherever the call is
 * routed), USAGE_MEDIA plays normally outside calls.
 *
 * The usage is chosen automatically from the current AudioManager mode, so JS
 * call sites don't need to know whether a call is active.
 */
class ConnectToneModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ConnectTone"

  companion object {
    private const val TAG = "CONNECT_TONE"
    private const val WAV_HEADER_BYTES = 44
  }

  /**
   * Play a mono 16-bit PCM WAV (base64, header included) once.
   * volume: 0.0–1.0. Resolves true when playback was started.
   */
  @ReactMethod
  fun playWavBase64(base64Wav: String, volume: Double, promise: Promise) {
    try {
      val bytes = Base64.decode(base64Wav, Base64.DEFAULT)
      if (bytes.size <= WAV_HEADER_BYTES) {
        promise.resolve(false)
        return
      }
      // Sample rate lives at offset 24 (LE uint32) in the canonical header the
      // JS synthesiser writes. Fall back to 22050 (its constant) when absurd.
      val sr = ((bytes[24].toInt() and 0xFF)
        or ((bytes[25].toInt() and 0xFF) shl 8)
        or ((bytes[26].toInt() and 0xFF) shl 16)
        or ((bytes[27].toInt() and 0xFF) shl 24))
      val sampleRate = if (sr in 8000..48000) sr else 22050
      val pcm = bytes.copyOfRange(WAV_HEADER_BYTES, bytes.size)

      val am = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val inCall = am.mode == AudioManager.MODE_IN_COMMUNICATION || am.mode == AudioManager.MODE_IN_CALL
      val usage = if (inCall) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_MEDIA

      val attrs = AudioAttributes.Builder()
        .setUsage(usage)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      val format = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .build()
      val track = AudioTrack(
        attrs,
        format,
        pcm.size,
        AudioTrack.MODE_STATIC,
        AudioManager.AUDIO_SESSION_ID_GENERATE,
      )
      if (track.state != AudioTrack.STATE_NO_STATIC_DATA && track.state != AudioTrack.STATE_INITIALIZED) {
        Log.w(TAG, "AudioTrack init failed state=" + track.state)
        track.release()
        promise.resolve(false)
        return
      }
      track.write(pcm, 0, pcm.size)
      val vol = volume.toFloat().coerceIn(0f, 1f)
      track.setVolume(vol)
      track.play()
      Log.i(TAG, "cue started bytes=" + pcm.size + " sr=" + sampleRate + " usage=" + (if (inCall) "voice" else "media"))
      // Release after the clip has fully played (duration + small margin).
      val durationMs = (pcm.size / 2) * 1000L / sampleRate
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
        try { track.stop() } catch (_: Throwable) {}
        try { track.release() } catch (_: Throwable) {}
      }, durationMs + 150L)
      promise.resolve(true)
    } catch (t: Throwable) {
      Log.w(TAG, "playWavBase64 failed: " + (t.message ?: t.toString()))
      promise.resolve(false)
    }
  }
}
