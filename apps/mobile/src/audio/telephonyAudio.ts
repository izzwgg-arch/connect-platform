/**
 * telephonyAudio
 *
 * Generates and plays telephony audio tones for the mobile softphone:
 *   - US ringback  (440 + 480 Hz, 2s on / 4s off, NANP cadence)
 *   - Incoming ringtone (480 + 440 Hz, double-ring: 0.4s on / 0.2s off / 0.4s on / 3s off)
 *   - DTMF keypad tones (standard ITU-T frequencies, 120 ms per digit)
 *
 * All tones are synthesised from PCM math — no audio files required.
 * Uses expo-av Audio.Sound for playback.
 */

import { Audio } from "expo-av";
import { NativeModules, Platform } from "react-native";
import { getMobileIncomingRingtone } from "./ringtonePreferences";

/**
 * Stop the Android native incoming-call ringtone played by
 * IncomingCallFirebaseService. Best-effort no-op on other platforms or when
 * the native module isn't linked (e.g. during jest). Called from
 * stopAllTelephonyAudio so the SIP session.on('ended'/'failed') handler also
 * silences the native MediaPlayer — without this, remote CANCEL while the
 * phone is still ringing left the native ringtone playing until the user
 * force-quit the app.
 */
function stopNativeAndroidRingtone(reason: string): void {
  if (Platform.OS !== "android") return;
  try {
    const mod = (NativeModules as any)?.IncomingCallUi;
    if (!mod) return;
    if (typeof mod.stopRingtone === "function") {
      mod.stopRingtone(reason ?? "stop_all_telephony_audio");
    }
  } catch {
    /* ignore — native module missing or misbehaving */
  }
}

// ─── PCM WAV generation ───────────────────────────────────────────────────────

const SAMPLE_RATE = 22050;

/** Write a little-endian 32-bit int into a DataView. */
function writeUInt32LE(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}
/** Write a little-endian 16-bit int into a DataView. */
function writeUInt16LE(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

/**
 * Build a mono 16-bit PCM WAV buffer containing a dual-tone for `durationMs`.
 * Returns a base64-encoded data URI: "data:audio/wav;base64,..."
 */
function buildDualToneWav(
  freqA: number,
  freqB: number,
  durationMs: number,
  volume = 0.4,
): string {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const dataSize = numSamples * 2; // 16-bit = 2 bytes/sample
  const bufferSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  // RIFF header
  // "RIFF"
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  writeUInt32LE(view, 4, bufferSize - 8);
  // "WAVE"
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
  // "fmt "
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  writeUInt32LE(view, 16, 16);       // PCM chunk size
  writeUInt16LE(view, 20, 1);        // PCM format
  writeUInt16LE(view, 22, 1);        // Mono
  writeUInt32LE(view, 24, SAMPLE_RATE);
  writeUInt32LE(view, 28, SAMPLE_RATE * 2); // byte rate
  writeUInt16LE(view, 32, 2);        // block align
  writeUInt16LE(view, 34, 16);       // bits per sample
  // "data"
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  writeUInt32LE(view, 40, dataSize);

  // PCM samples: mix two sine waves
  const amp = Math.floor(32767 * volume * 0.5); // half each tone, combined
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Apply a tiny fade-in/out (5ms) to avoid clicks
    const fadeLen = Math.floor(SAMPLE_RATE * 0.005);
    let env = 1.0;
    if (i < fadeLen) env = i / fadeLen;
    else if (i > numSamples - fadeLen) env = (numSamples - i) / fadeLen;

    const sample = Math.round(
      env * amp * (Math.sin(2 * Math.PI * freqA * t) + Math.sin(2 * Math.PI * freqB * t)),
    );
    view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, sample)), true);
  }

  // Convert ArrayBuffer to base64
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return `data:audio/wav;base64,${b64}`;
}

// ─── DTMF frequency table ─────────────────────────────────────────────────────

const DTMF_FREQS: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

// ─── Pre-built WAV data URIs (lazy, built on first use) ───────────────────────

let _ringbackWav: string | null = null;
let _ringtoneWav: string | null = null;
const _dtmfWavCache: Record<string, string> = {};

function getRingbackWav(): string {
  if (!_ringbackWav) _ringbackWav = buildDualToneWav(440, 480, 2000, 0.35);
  return _ringbackWav;
}

function getRingtoneWav(): string {
  if (!_ringtoneWav) _ringtoneWav = buildDualToneWav(480, 440, 400, 0.45);
  return _ringtoneWav;
}

function getDtmfWav(digit: string): string | null {
  const key = digit.toUpperCase();
  if (_dtmfWavCache[key]) return _dtmfWavCache[key];
  const freqs = DTMF_FREQS[key];
  if (!freqs) return null;
  _dtmfWavCache[key] = buildDualToneWav(freqs[0], freqs[1], 120, 0.4);
  return _dtmfWavCache[key];
}

// ─── Sound player helpers ─────────────────────────────────────────────────────

async function playOnce(source: any, volume = 1.0): Promise<Audio.Sound | null> {
  try {
    const { sound } = await Audio.Sound.createAsync(
      typeof source === "string" ? { uri: source } : source,
      { shouldPlay: true, volume, isLooping: false },
    );
    // Auto-unload when done
    sound.setOnPlaybackStatusUpdate((status) => {
      if ("didJustFinish" in status && status.didJustFinish) {
        sound.unloadAsync().catch(() => undefined);
      }
    });
    return sound;
  } catch {
    return null;
  }
}

async function playLooping(source: any, volume = 1.0): Promise<Audio.Sound | null> {
  try {
    const { sound } = await Audio.Sound.createAsync(
      typeof source === "string" ? { uri: source } : source,
      { shouldPlay: true, volume, isLooping: true },
    );
    return sound;
  } catch {
    return null;
  }
}

// ─── TelephonyAudio controller ────────────────────────────────────────────────

let ringbackSound: Audio.Sound | null = null;
let ringbackTimer: ReturnType<typeof setTimeout> | null = null;
let ringbackStopped = true; // true = not playing; false = currently playing

let ringtoneSound: Audio.Sound | null = null;
let ringtoneTimer: ReturnType<typeof setTimeout> | null = null;
let ringtoneStopped = true; // true = not playing; false = currently playing
// Generation counter that increments on every stopAll / startRingtone invocation.
// Any in-flight startRingtone captures its own generation and uses it to detect
// whether it has been superseded — protects against the race where an async
// Audio.Sound creation resolves AFTER a stopAllTelephonyAudio (during InCallManager
// MODE_IN_COMMUNICATION the leaked sound is silent, so the user only hears it
// after hangup when audio mode returns to NORMAL).
let ringtoneGeneration = 0;
const CONNECT_DEFAULT_RINGTONE_SOURCE = require("../../assets/connect-default-ringtone.mp4");

/**
 * Set up the audio session for telephony.
 *
 * iOS: configure the AVAudioSession so the mic, silent-mode playback, and
 *   background audio all work correctly for VoIP calls.
 *
 * Android: intentionally skipped — InCallManager owns the AudioManager mode
 *   on Android. Calling setAudioModeAsync here would override InCallManager's
 *   MODE_IN_COMMUNICATION setting and route call audio to the speakerphone
 *   instead of the earpiece.
 */
export async function initAudioSession() {
  if (Platform.OS !== "ios") return;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,       // Required for call mic + Bluetooth on iOS
      playsInSilentModeIOS: true,     // Always play even in silent mode
      staysActiveInBackground: true,  // Keep audio active during a call
      shouldDuckAndroid: false,
    });
  } catch { /* non-fatal */ }
}

/** Restore default audio session after a call ends (iOS only). */
export async function restoreAudioSession() {
  if (Platform.OS !== "ios") return;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: false,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
  } catch { /* non-fatal */ }
}

/** Stop and unload a sound safely. */
async function stopSound(sound: Audio.Sound | null) {
  if (!sound) return;
  try {
    await sound.stopAsync();
    await sound.unloadAsync();
  } catch { /* ignore */ }
}

/** Stop all ringing/ringback audio immediately. */
export async function stopAllTelephonyAudio() {
  console.log("[AUDIO] stopAllTelephonyAudio");
  // Always belt-and-braces stop the native Android incoming ringtone. This is
  // synchronous/fire-and-forget: the native module runs on its own thread.
  // Calling this first means that even if awaiting JS sound.stop() below
  // hangs for a frame, the MediaPlayer is already silenced. It's also the
  // canonical chokepoint invoked by SIP session 'ended' / 'failed' callbacks
  // so the ringtone stops the instant the remote party CANCELs.
  stopNativeAndroidRingtone("stop_all_telephony_audio");
  // Bump generation first so any in-flight startRingtone resolves and self-unloads
  // the sound it was about to assign to ringtoneSound.
  ringtoneGeneration += 1;
  ringbackStopped = true;
  if (ringbackTimer) { clearTimeout(ringbackTimer); ringbackTimer = null; }
  await stopSound(ringbackSound);
  ringbackSound = null;

  ringtoneStopped = true;
  if (ringtoneTimer) { clearTimeout(ringtoneTimer); ringtoneTimer = null; }
  await stopSound(ringtoneSound);
  ringtoneSound = null;
}

/**
 * US ringback tone: 440+480 Hz, 2s on / 4s off.
 * Loops until stopAllTelephonyAudio() is called.
 *
 * Guard: if ringback is already playing this call does nothing so that
 * repeated SIP "progress" events don't interrupt the cadence and produce
 * a continuous tone.
 */
export async function startRingback() {
  // Already running — do not restart; preserves the silence gap in the cadence
  if (!ringbackStopped) return;
  console.log("[AUDIO] startRingback");

  // Stop any incoming ringtone but leave ringback state intact
  ringtoneStopped = true;
  if (ringtoneTimer) { clearTimeout(ringtoneTimer); ringtoneTimer = null; }
  await stopSound(ringtoneSound);
  ringtoneSound = null;

  ringbackStopped = false;

  async function cycle() {
    if (ringbackStopped) return;
    ringbackSound = await playOnce(getRingbackWav(), 0.7);
    // 6s total cadence: 2s tone already encoded in WAV + 4s silence
    ringbackTimer = setTimeout(async () => {
      if (ringbackStopped) return;
      await stopSound(ringbackSound);
      ringbackSound = null;
      cycle();
    }, 6000);
  }

  await cycle();
}

/**
 * Incoming ringtone: double-ring pattern (0.4s on, 0.2s off, 0.4s on, 3s off).
 * Loops until stopAllTelephonyAudio() is called.
 */
export async function startRingtone() {
  console.log("[AUDIO] startRingtone");
  await stopAllTelephonyAudio();
  // Claim a generation — any subsequent stopAllTelephonyAudio (or another
  // startRingtone) will bump this counter and our `isSuperseded` checks below
  // will unload whatever sound we were about to expose.
  const myGen = ++ringtoneGeneration;
  const isSuperseded = () => myGen !== ringtoneGeneration;
  ringtoneStopped = false;
  const ringtonePreference = await getMobileIncomingRingtone();
  if (isSuperseded()) return;

  if (ringtonePreference === "connect-default") {
    const sound = await playLooping(CONNECT_DEFAULT_RINGTONE_SOURCE as any, 0.95);
    if (isSuperseded() || ringtoneStopped) {
      // A newer stopAll / startRingtone has already superseded us. Unload the
      // sound we just created so it doesn't leak and keep playing after hangup.
      sound?.stopAsync().catch(() => undefined);
      sound?.unloadAsync().catch(() => undefined);
      return;
    }
    ringtoneSound = sound;
    return;
  }

  async function cycle() {
    if (isSuperseded() || ringtoneStopped) return;
    // First ring
    const first = await playOnce(getRingtoneWav(), 0.85);
    if (isSuperseded() || ringtoneStopped) {
      first?.stopAsync().catch(() => undefined);
      first?.unloadAsync().catch(() => undefined);
      return;
    }
    ringtoneSound = first;
    ringtoneTimer = setTimeout(async () => {
      if (isSuperseded() || ringtoneStopped) return;
      await stopSound(ringtoneSound);
      ringtoneSound = null;
      // 200ms silence, then second ring
      ringtoneTimer = setTimeout(async () => {
        if (isSuperseded() || ringtoneStopped) return;
        const second = await playOnce(getRingtoneWav(), 0.85);
        if (isSuperseded() || ringtoneStopped) {
          second?.stopAsync().catch(() => undefined);
          second?.unloadAsync().catch(() => undefined);
          return;
        }
        ringtoneSound = second;
        // 3s silence, then repeat cycle
        ringtoneTimer = setTimeout(async () => {
          await stopSound(ringtoneSound);
          ringtoneSound = null;
          cycle();
        }, 3000);
      }, 200);
    }, 400);
  }

  await cycle();
}

/** Play a single DTMF keypad tone (120ms). Non-blocking, fire-and-forget. */
export function playDtmfTone(digit: string): void {
  const uri = getDtmfWav(digit);
  if (!uri) return;
  playOnce(uri, 0.6).catch(() => undefined);
}

// Call-waiting beep: short, low-volume 440Hz tone played twice with a 150ms
// gap. Mirrors the North American "Subscriber Alerting Signal (SAS)" cadence
// — ~300ms total. Volume is deliberately soft so it's audible without
// stepping on the active-call conversation. Safe to invoke while a SIP
// session is active; it uses expo-av which mixes with the WebRTC audio path.
let _callWaitingBeepWav: string | null = null;
function getCallWaitingBeepWav(): string {
  if (!_callWaitingBeepWav) {
    // Single tone at 440 Hz for 120ms at low-ish amplitude.
    _callWaitingBeepWav = buildDualToneWav(440, 440, 120, 0.25);
  }
  return _callWaitingBeepWav;
}

let _callWaitingBeepInFlight = false;
export async function playCallWaitingBeep(): Promise<void> {
  if (_callWaitingBeepInFlight) return;
  _callWaitingBeepInFlight = true;
  console.log("[AUDIO] playCallWaitingBeep");
  try {
    const uri = getCallWaitingBeepWav();
    const first = await playOnce(uri, 0.5);
    // Auto-unload after ~300ms (120ms tone + buffer)
    setTimeout(async () => {
      try { await first?.stopAsync(); } catch { /* ignore */ }
      try { await first?.unloadAsync(); } catch { /* ignore */ }
    }, 300);
    // 150ms gap, then second beep
    setTimeout(async () => {
      const second = await playOnce(uri, 0.5);
      setTimeout(async () => {
        try { await second?.stopAsync(); } catch { /* ignore */ }
        try { await second?.unloadAsync(); } catch { /* ignore */ }
      }, 300);
    }, 270);
  } catch {
    /* ignore — best-effort */
  } finally {
    // Release lock after the whole sequence (~700ms) so rapid double-invites
    // don't stutter-play over themselves.
    setTimeout(() => { _callWaitingBeepInFlight = false; }, 700);
  }
}
