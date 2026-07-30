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
import { AppState, NativeModules, Platform, Vibration } from "react-native";
import { getMobileIncomingRingtone } from "./ringtonePreferences";
import { appendIosRingLog } from "../diagnostics/iosRingLog";
import { audioRouteManager } from "./audioRouteManager";

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

// ─── Connect UI sound effects (hang-up / voice-note) ──────────────────────────
//
// A small, deliberately-matched family of short UI sounds synthesised with the
// same warm timbre (fundamental + soft 2nd/3rd harmonics) and the same gentle
// percussive attack/exponential-decay envelope, all drawn from a C-major
// pentatonic palette so they feel like they belong together:
//   • hang-up      → descending two-note (call ended)
//   • v-note start → single soft tick (recording armed)
//   • v-note sent  → ascending two-note (message away)
// Fully PCM-synthesised — no bundled audio assets required.

type SfxNote = { freq: number; ms: number };

function buildToneSequenceWav(notes: SfxNote[], volume = 0.5): string {
  const totalMs = notes.reduce((s, n) => s + n.ms, 0);
  const numSamples = Math.floor((SAMPLE_RATE * totalMs) / 1000);
  const dataSize = numSamples * 2;
  const bufferSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufferSize);
  const view = new DataView(buf);

  // RIFF/WAVE header (mono, 16-bit PCM) — identical layout to buildDualToneWav.
  view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
  writeUInt32LE(view, 4, bufferSize - 8);
  view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
  view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
  writeUInt32LE(view, 16, 16);
  writeUInt16LE(view, 20, 1);
  writeUInt16LE(view, 22, 1);
  writeUInt32LE(view, 24, SAMPLE_RATE);
  writeUInt32LE(view, 28, SAMPLE_RATE * 2);
  writeUInt16LE(view, 32, 2);
  writeUInt16LE(view, 34, 16);
  view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
  writeUInt32LE(view, 40, dataSize);

  const amp = 32767 * volume;
  let cursor = 0;
  for (const note of notes) {
    const noteSamples = Math.floor((SAMPLE_RATE * note.ms) / 1000);
    // Raised-cosine attack (~8ms, capped at 30% of the note) then exponential
    // decay to the note's end — soft enough to avoid clicks at boundaries.
    const attackLen = Math.min(Math.floor(SAMPLE_RATE * 0.008), Math.floor(noteSamples * 0.3)) || 1;
    for (let j = 0; j < noteSamples; j++) {
      const t = j / SAMPLE_RATE;
      let env: number;
      if (j < attackLen) {
        env = 0.5 - 0.5 * Math.cos((Math.PI * j) / attackLen);
      } else {
        const p = (j - attackLen) / Math.max(1, noteSamples - attackLen);
        env = Math.exp(-3.2 * p);
      }
      const w = 2 * Math.PI * note.freq * t;
      const timbre =
        Math.sin(w) + 0.3 * Math.sin(2 * w) + 0.12 * Math.sin(3 * w);
      const sample = Math.round(env * amp * 0.6 * timbre);
      view.setInt16(44 + (cursor + j) * 2, Math.max(-32768, Math.min(32767, sample)), true);
    }
    cursor += noteSamples;
  }

  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

let _callEndWav: string | null = null;
let _vnoteStartWav: string | null = null;
let _vnoteSentWav: string | null = null;

// ── Native cue player (Android) ──────────────────────────────────────────────
// expo-av playback rides the MEDIA stream, which Android silences while
// InCallManager holds MODE_IN_COMMUNICATION — so in-call cues (DTMF, hang-up)
// were synthesised but inaudible, and the voice-note cues raced expo-av's own
// recorder session (observed live 2026-07-29: none of them ever sounded).
// ConnectTone plays the exact same WAV bytes on a native AudioTrack with
// voice-call attributes during a call and media attributes otherwise. Falls
// back to expo-av (iOS / module missing).
function playCueNative(dataUri: string, volume: number): boolean {
  if (Platform.OS !== "android") return false;
  try {
    const mod = (NativeModules as any)?.ConnectTone;
    if (!mod || typeof mod.playWavBase64 !== "function") return false;
    const b64 = dataUri.replace(/^data:audio\/wav;base64,/, "");
    mod.playWavBase64(b64, volume).catch?.(() => undefined);
    return true;
  } catch {
    return false;
  }
}

function playCue(dataUri: string, volume: number): void {
  if (playCueNative(dataUri, volume)) return;
  playOnce(dataUri, volume).catch(() => undefined);
}

/** Subtle descending two-note "call ended" cue (G4 → C4). */
export function playCallEndTone(): void {
  if (!_callEndWav) {
    _callEndWav = buildToneSequenceWav([
      { freq: 392.0, ms: 90 },
      { freq: 261.63, ms: 170 },
    ], 0.5);
  }
  playCue(_callEndWav, 0.5);
}

/** Soft single-note tick when a voice note starts recording (A5). */
export function playVoiceNoteStartTone(): void {
  if (!_vnoteStartWav) {
    _vnoteStartWav = buildToneSequenceWav([{ freq: 880.0, ms: 95 }], 0.42);
  }
  playCue(_vnoteStartWav, 0.5);
}

/** Bright ascending two-note "sent" cue when a voice note is released (E5 → C6). */
export function playVoiceNoteSentTone(): void {
  if (!_vnoteSentWav) {
    _vnoteSentWav = buildToneSequenceWav([
      { freq: 659.25, ms: 85 },
      { freq: 1046.5, ms: 150 },
    ], 0.5);
  }
  playCue(_vnoteSentWav, 0.6);
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

// ─── Android ringback via InCallManager ───────────────────────────────────────
//
// On Android the outbound ringback must NOT be a synthesized WAV played through
// expo-av's media stream, for two reasons the user hit directly:
//
//   1. No ringback at all — while InCallManager holds the call audio mode
//      (MODE_IN_COMMUNICATION), media-stream playback is ducked/silenced, so the
//      generated tone was created but inaudible on outgoing calls.
//   2. Ringback stops when backgrounding — an expo-av sound is tied to the app
//      lifecycle, so leaving the app mid-dial (to open another app) went silent
//      even though the call was still ringing.
//
// InCallManager plays ringback on the voice-call stream via a native tone
// generator: it's audible during the call and keeps playing when the app is in
// the background, because it's owned by the call audio session, not JS. The
// audio manager is already activated by the SIP dial path, so passing a
// non-empty `ringback` here only starts the tone (no re-route).
function androidStartIcmRingback(): boolean {
  if (Platform.OS !== "android") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("react-native-incall-manager").default;
    // IMPORTANT: the SIP dial path already called InCallManager.start("audio")
    // to enter MODE_IN_COMMUNICATION. InCallManager guards start() against
    // re-entry (once audioManagerActivated is true, a second start() — even one
    // that passes a `ringback` option — is a no-op), so passing ringback to
    // start() here never actually played a tone. Use the dedicated
    // startRingback() API instead, which plays the ringback on the already-active
    // voice-call stream (audible + background-safe). Falls through to the expo-av
    // cadence only if the native method is unavailable.
    if (typeof m.startRingback === "function") {
      m.startRingback("_DTMF_");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function androidStopIcmRingback(): void {
  if (Platform.OS !== "android") return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const m = require("react-native-incall-manager").default;
    if (typeof m.stopRingback === "function") m.stopRingback();
  } catch {
    /* module missing — nothing to stop */
  }
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

/**
 * Configure the *default* playback audio session (iOS).
 *
 * Called once at app startup (and after a call ends) so that ALL expo-av
 * playback — voicemail audio, chat voice notes, DTMF — uses the AVAudioSession
 * `playback` category instead of expo-av's default `ambient`/`soloAmbient`.
 *
 * Why this matters: with the default category iOS silences app audio whenever
 * the physical Ring/Silent switch is flipped to silent, and routes quietly.
 * A phone app must keep playing voicemail/voice notes regardless of the ringer
 * switch (this is how WhatsApp / native Phone behave), so we force
 * `playsInSilentModeIOS: true` with recording OFF (→ speaker output).
 */
export async function initPlaybackAudioSession() {
  if (Platform.OS !== "ios") return;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
  } catch { /* non-fatal */ }
}

/**
 * Restore the default *playback* audio session after a call ends (iOS only).
 *
 * Intentionally keeps `playsInSilentModeIOS: true` so that voicemail / voice
 * notes remain audible after a call — the previous value (`false`) re-broke
 * playback whenever the user had the ringer switch on silent.
 */
export async function restoreAudioSession() {
  if (Platform.OS !== "ios") return;
  try {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
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
  // Stop the Android InCallManager ringback tone (no-op on iOS / when idle).
  androidStopIcmRingback();
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

  // Android: delegate to InCallManager's native ringback (voice-call stream,
  // audible during the call AND background-safe). Falls through to the expo-av
  // synthesized cadence below only if the native module is unavailable.
  if (androidStartIcmRingback()) return;

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
  void appendIosRingLog("IOS_STARTRINGTONE", { pref: ringtonePreference, appState: AppState.currentState });
  if (isSuperseded()) return;

  // iOS "classic" = give the ringtone back to the iPhone: showIncomingNativeCall
  // (CallKit displayIncomingCall/reportNewIncomingCall) already makes the OS
  // play the user's own chosen iPhone ringtone the instant the native incoming
  // call UI appears. Also playing our synthesized double-ring tone on top of
  // that would layer two audible ringtones at once — the same "double
  // ringtone" bug already fixed for Android's native MediaPlayer path (see
  // IncomingCallScreen.tsx). So for "classic" on iOS we play nothing here and
  // let CallKit's native ring be the only sound. "connect-default" still needs
  // the JS layer below since CallKit has no bundled Connect sound to fall
  // back to.
  if (ringtonePreference === "classic" && Platform.OS === "ios") {
    // Foreground: the in-app incoming-call screen is shown and the native
    // CallKit report is suppressed, so JS must provide the audible ring - fall
    // through to the synthesized standard double-ring below. Background /
    // CallKit-driven (app not active): CallKit plays the phone's system ring
    // itself, so do NOT layer a second ring here.
    if (AppState.currentState !== "active") {
      return;
    }
  }

  if (ringtonePreference === "connect-default") {
    // iOS background/killed: CallKit plays the bundled connect-default-ringtone.caf
    // natively (plugins/withIosConnectRingtone.js). Playing the JS ringtone too
    // double-rings with CallKit (two copies of the Connect tone, out of phase).
    // Only ring from JS when foreground-active, where the native CallKit ring is
    // suppressed and JS is the sole ring. Foreground + Android unchanged.
    if (Platform.OS === "ios" && AppState.currentState !== "active") {
      void appendIosRingLog("IOS_STARTRINGTONE_SUPPRESSED_BG", { pref: ringtonePreference, appState: AppState.currentState });
      return;
    }
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

/** Play a single DTMF keypad tone (120ms). Non-blocking, fire-and-forget.
 *  Routed through the native AudioTrack on Android so it is audible inside an
 *  active call (expo-av's media stream is silenced in MODE_IN_COMMUNICATION —
 *  the in-call keypad was completely mute; Izzy 2026-07-29). */
export function playDtmfTone(digit: string): void {
  const uri = getDtmfWav(digit);
  if (!uri) return;
  playCue(uri, 0.6);
}

// Call-waiting alert: while another call is ringing during an active call, a
// single longer, loud HIGH beep repeats every ~3.5s. The FIRST beep also fires a
// short vibrate; the repeats are beep-only. Bracketed by startCallWaitingAlert()
// / stopCallWaitingAlert() (driven by CallSessionManager). Safe during a live
// SIP call; expo-av mixes with the WebRTC audio path.
let _callWaitingBeepWav: string | null = null;
function getCallWaitingBeepWav(): string {
  if (!_callWaitingBeepWav) {
    // A longer, bright high beep (~180ms) — high pitch so it isn't bassy.
    _callWaitingBeepWav = buildDualToneWav(1400, 1400, 180, 0.36);
  }
  return _callWaitingBeepWav;
}

async function playOneCallWaitingBeep(): Promise<void> {
  try {
    const uri = getCallWaitingBeepWav();
    const beep = await playOnce(uri, 0.72);
    // iOS: expo-av just re-activated the shared AVAudioSession, which drops the
    // in-call speaker override. Re-assert the call's route immediately (and once
    // more mid-beep) so the beep actually comes out the speaker when the user is
    // on speakerphone instead of the earpiece. No-op unless a call is on speaker.
    try { audioRouteManager.reassertRoute("call_waiting_beep"); } catch { /* ignore */ }
    setTimeout(() => {
      try { audioRouteManager.reassertRoute("call_waiting_beep_mid"); } catch { /* ignore */ }
    }, 40);
    setTimeout(async () => {
      try { await beep?.stopAsync(); } catch { /* ignore */ }
      try { await beep?.unloadAsync(); } catch { /* ignore */ }
    }, 320);
  } catch {
    /* ignore — best-effort */
  }
}

const CALL_WAITING_REPEAT_MS = 5000;
let _callWaitingAlertTimer: ReturnType<typeof setInterval> | null = null;
let _callWaitingAlertActive = false;

/** Start the repeating call-waiting alert. First beep also vibrates; the repeats
 *  are beep-only, every ~3.5s. Idempotent (a second call while active is a no-op). */
export function startCallWaitingAlert(): void {
  if (_callWaitingAlertActive) return;
  _callWaitingAlertActive = true;
  console.log("[AUDIO] startCallWaitingAlert");
  try { Vibration.vibrate(220); } catch { /* ignore */ }
  void playOneCallWaitingBeep();
  _callWaitingAlertTimer = setInterval(() => { void playOneCallWaitingBeep(); }, CALL_WAITING_REPEAT_MS);
}

/** Stop the repeating call-waiting alert. Idempotent. */
export function stopCallWaitingAlert(): void {
  if (_callWaitingAlertTimer) { clearInterval(_callWaitingAlertTimer); _callWaitingAlertTimer = null; }
  if (_callWaitingAlertActive) console.log("[AUDIO] stopCallWaitingAlert");
  _callWaitingAlertActive = false;
}

// Back-compat one-shot entry point — now starts the repeating alert. Existing
// call sites (the push/notification invite path) get the new behavior too.
export async function playCallWaitingBeep(): Promise<void> {
  startCallWaitingAlert();
}
