/**
 * useTelephonyAudio
 *
 * Synthesises all telephony audio client-side using the Web Audio API.
 * No audio files required — tones are generated from pure oscillators.
 *
 * Provides:
 *  - UK local ringback (400 + 450 Hz, 400/200/400/2000 ms cadence) until PBX remote ringback
 *  - US ringback tone  (440 + 480 Hz, 2s on / 4s off cadence) — legacy helper
 *  - Incoming ringtone (480 + 440 Hz double-ring, NANP cadence)
 *  - DTMF keypad tones (standard ITU-T frequencies, 120 ms)
 *  - Call-end chime (short descending three-note disconnect cue)
 */

import { useCallback, useEffect, useRef } from "react";
import {
  getWebIncomingRingtone,
  getWebRingerEnabled,
  getWebRingerOutputDeviceId,
  getWebRingerVolume,
  WEB_RINGER_ENABLED_EVENT,
} from "./telephonyAudioPreferences";

// ─── DTMF frequency table ────────────────────────────────────────────────────
const DTMF_FREQS: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
  "A": [697, 1633], "B": [770, 1633], "C": [852, 1633], "D": [941, 1633],
};

// ─── Types ────────────────────────────────────────────────────────────────────
type ToneHandle = { stop: () => void };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    return new (window.AudioContext || (window as any).webkitAudioContext)();
  } catch {
    return null;
  }
}

/** Play a two-frequency tone burst for `durationMs` ms at given volume (0–1). */
function playToneBurst(
  ctx: AudioContext,
  freqA: number,
  freqB: number,
  durationMs: number,
  volume = 0.15,
): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.setTargetAtTime(0, ctx.currentTime + durationMs / 1000 - 0.01, 0.005);
  gain.connect(ctx.destination);

  [freqA, freqB].forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
  });
}

/**
 * Create a continuously looping two-tone pattern with on/off cadence.
 * Returns a stop() function to cancel.
 */
function startCadenceTone(
  ctx: AudioContext,
  freqA: number,
  freqB: number,
  onMs: number,
  offMs: number,
  volume = 0.12,
): ToneHandle {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  const activeOscillators: OscillatorNode[] = [];
  const activeGains: GainNode[] = [];

  function playBurst() {
    if (stopped) return;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.setTargetAtTime(0, ctx.currentTime + onMs / 1000 - 0.02, 0.008);
    gain.connect(ctx.destination);
    activeGains.push(gain);

    [freqA, freqB].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + onMs / 1000 + 0.05);
      activeOscillators.push(osc);
    });

    timeoutId = setTimeout(() => {
      if (!stopped) playBurst();
    }, onMs + offMs);
  }

  playBurst();

  return {
    stop() {
      stopped = true;
      clearTimeout(timeoutId);
      const t = ctx.currentTime;
      activeGains.forEach((g) => {
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(0, t);
        } catch { /* ignore */ }
      });
      activeOscillators.forEach((o) => {
        try { o.stop(t); } catch { /* ignore */ }
      });
      activeGains.length = 0;
      activeOscillators.length = 0;
    },
  };
}

/**
 * NANP (North American) incoming ringtone cadence:
 *   2 seconds on / 4 seconds off (same frequencies as ringback but slightly louder)
 *
 * US ringback cadence is identical: 440+480 Hz, 2s on / 4s off.
 * Incoming ring uses 480+440 Hz at higher volume to stand out.
 */
function startIncomingRingtone(ctx: AudioContext, volume = 0.18): ToneHandle {
  // Double-ring pattern: 0.4s on, 0.2s off, 0.4s on, 3s off
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout>;

  function ring() {
    if (stopped) return;

    // First ring burst
    playToneBurst(ctx, 480, 440, 400, volume);

    timeoutId = setTimeout(() => {
      if (stopped) return;
      // Second ring burst after 200ms silence
      playToneBurst(ctx, 480, 440, 400, volume);
      // Then 3 seconds silence before repeating
      timeoutId = setTimeout(() => {
        if (!stopped) ring();
      }, 3000);
    }, 600);
  }

  ring();

  return {
    stop() {
      stopped = true;
      clearTimeout(timeoutId);
    },
  };
}

/**
 * UK ringback (BT-style): 400 Hz + 450 Hz,
 * cadence 400 ms on / 200 ms off / 400 ms on / 2000 ms off (repeating).
 */
function startUkRingbackTone(ctx: AudioContext): ToneHandle {
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const volume = 0.12;
  const activeOscillators: OscillatorNode[] = [];
  const activeGains: GainNode[] = [];

  function playBurst(durationMs: number) {
    if (stopped) return;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.setTargetAtTime(0, ctx.currentTime + durationMs / 1000 - 0.02, 0.008);
    gain.connect(ctx.destination);
    activeGains.push(gain);
    [400, 450].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      osc.connect(gain);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + durationMs / 1000 + 0.05);
      activeOscillators.push(osc);
    });
  }

  function cycle() {
    if (stopped) return;
    playBurst(400);
    timeoutId = setTimeout(() => {
      if (stopped) return;
      playBurst(400);
      timeoutId = setTimeout(() => {
        if (!stopped) cycle();
      }, 2000);
    }, 600);
  }

  cycle();

  return {
    stop() {
      stopped = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      const t = ctx.currentTime;
      activeGains.forEach((g) => {
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(0, t);
        } catch { /* ignore */ }
      });
      activeOscillators.forEach((o) => {
        try { o.stop(t); } catch { /* ignore */ }
      });
      activeGains.length = 0;
      activeOscillators.length = 0;
    },
  };
}

/**
 * Connect call-end signature: three quick descending tone pairs (~550 ms total).
 * Distinct from ringback, ringtone, and DTMF.
 */
function playCallEndChimePattern(ctx: AudioContext, volume = 0.13): void {
  const steps: Array<{ delayMs: number; freqA: number; freqB: number; durMs: number; vol: number }> = [
    { delayMs: 0, freqA: 620, freqB: 740, durMs: 110, vol: volume },
    { delayMs: 130, freqA: 480, freqB: 560, durMs: 130, vol: volume * 0.88 },
    { delayMs: 300, freqA: 300, freqB: 360, durMs: 200, vol: volume * 0.75 },
  ];
  const t0 = ctx.currentTime;
  for (const step of steps) {
    const t = t0 + step.delayMs / 1000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(step.vol, t + 0.008);
    gain.gain.setTargetAtTime(0, t + step.durMs / 1000 - 0.015, 0.012);
    gain.connect(ctx.destination);
    [step.freqA, step.freqB].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, t);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + step.durMs / 1000 + 0.04);
    });
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

// Absolute backstop on the incoming ringtone. The ring is normally stopped by a
// SIP event (accepted/ended/failed/CANCEL) or a user click — but if the SIP
// socket dies mid-ring, none of those can ever arrive, and a UA rebuild orphans
// the tone with no session left to stop it (Fixup Group, 2026-08-10: a ring
// survived a PC reboot because the ringing client's WS failed 6 ms after the
// incoming-call screen appeared). 120 s is longer than any real ring-to-voicemail
// window, so this only ever silences a ring whose call is already over.
const RINGTONE_ABSOLUTE_CAP_MS = 120_000;

export function useTelephonyAudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const ringbackRef = useRef<ToneHandle | null>(null);
  const ringtoneRef = useRef<ToneHandle | null>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);
  const ringtoneCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function ensureCtx(): AudioContext | null {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = getCtx();
    }
    if (ctxRef.current?.state === "suspended") {
      ctxRef.current.resume().catch(() => undefined);
    }
    return ctxRef.current;
  }

  /** Stop everything immediately. */
  const stopAll = useCallback(() => {
    if (ringtoneCapTimerRef.current) {
      clearTimeout(ringtoneCapTimerRef.current);
      ringtoneCapTimerRef.current = null;
    }
    ringbackRef.current?.stop();
    ringbackRef.current = null;
    ringtoneRef.current?.stop();
    ringtoneRef.current = null;
    if (ringtoneAudioRef.current) {
      ringtoneAudioRef.current.pause();
      ringtoneAudioRef.current.currentTime = 0;
      ringtoneAudioRef.current = null;
    }
  }, []);

  /** Stop synthesized local ringback only (incoming ringtone untouched). */
  const stopLocalRingback = useCallback(() => {
    ringbackRef.current?.stop();
    ringbackRef.current = null;
  }, []);

  // Route the shared tone AudioContext to a specific output device (the call
  // output / headset). Without this the outbound ringback plays on the OS default
  // speaker even when the user picked a headset — the connected call then jumps to
  // the headset only after answer. Requires AudioContext.setSinkId (Chromium 110+/
  // Electron); a no-op elsewhere so the tone stays on the default device.
  function applyCtxSink(ctx: AudioContext, outputDeviceId?: string) {
    if (outputDeviceId && typeof (ctx as unknown as { setSinkId?: unknown }).setSinkId === "function") {
      void (ctx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(outputDeviceId).catch(() => undefined);
    }
  }

  /**
   * UK local ringback (BT-style 400+450 Hz, 400/200/400/2000 ms).
   * Plays until SIP progress / early media — then stopLocalRingback().
   * `outputDeviceId` = the call output device so ringback plays on the headset.
   */
  const startUkLocalRingback = useCallback((outputDeviceId?: string) => {
    stopLocalRingback();
    const ctx = ensureCtx();
    if (!ctx) return;
    applyCtxSink(ctx, outputDeviceId);
    ringbackRef.current = startUkRingbackTone(ctx);
  }, [stopLocalRingback]);

  /**
   * European local ringback (ETSI-style 425 Hz, 1s on / 4s off).
   * Plays until SIP progress / early media — then stopLocalRingback().
   */
  const startEuropeanLocalRingback = useCallback((outputDeviceId?: string) => {
    stopLocalRingback();
    const ctx = ensureCtx();
    if (!ctx) return;
    applyCtxSink(ctx, outputDeviceId);
    ringbackRef.current = startCadenceTone(ctx, 425, 425, 1000, 4000, 0.12);
  }, [stopLocalRingback]);

  /** US ringback: 440+480 Hz, 2s on / 4s off. */
  const startRingback = useCallback((outputDeviceId?: string) => {
    stopAll();
    const ctx = ensureCtx();
    if (!ctx) return;
    applyCtxSink(ctx, outputDeviceId);
    ringbackRef.current = startCadenceTone(ctx, 440, 480, 2000, 4000, 0.12);
  }, [stopAll]);

  /** Incoming ringtone: double-ring pattern. */
  const startRingtone = useCallback(() => {
    if (!getWebRingerEnabled()) {
      stopAll();
      return;
    }
    stopAll();
    // Arm the absolute cap BEFORE branching so every ring path (media element,
    // codec fallback, plain synth) is covered. stopAll() clears it, so a ring
    // that ends normally never sees this fire.
    ringtoneCapTimerRef.current = setTimeout(() => {
      console.warn(`[TelephonyAudio] ringtone_absolute_cap fired after ${RINGTONE_ABSOLUTE_CAP_MS}ms — force-stopping a ring nothing else stopped`);
      stopAll();
    }, RINGTONE_ABSOLUTE_CAP_MS);
    // Ringer routing (desktop only): its own output device + volume, so a
    // headset user still hears the ring on their speakers. Browser: unchanged.
    const isDesktop =
      typeof window !== "undefined" && Boolean((window as any).connectDesktop?.isDesktop);
    const ringerVol = isDesktop ? getWebRingerVolume() : 1;
    const ringerDeviceId = isDesktop ? getWebRingerOutputDeviceId() : "";
    const ringtonePreference = getWebIncomingRingtone();
    // Synthesized-tone fallback: on Windows editions without the Media Foundation
    // AAC codec (N/KN, stripped images) the .mp4 ring "plays" but is silent, and
    // any media-element error means no ring at all. Web Audio never needs the OS
    // codec, so it always rings.
    const fallbackToSynth = () => {
      ringtoneAudioRef.current = null;
      const c = ensureCtx();
      if (!c) return;
      if (ringerDeviceId && typeof (c as any).setSinkId === "function") {
        void (c as any).setSinkId(ringerDeviceId).catch(() => undefined);
      }
      ringtoneRef.current = startIncomingRingtone(c, 0.18 * ringerVol);
    };
    if (ringtonePreference === "connect-default" && typeof Audio !== "undefined") {
      // Ogg/Vorbis primary (no AAC dependency); .mp4 kept only as a source
      // fallback for any browser that somehow lacks Vorbis but has AAC.
      const audio = new Audio();
      audio.loop = true;
      audio.volume = ringerVol;
      const srcOgg = document.createElement("source");
      srcOgg.src = "/ringtones/connect-default-ringtone.ogg";
      srcOgg.type = "audio/ogg";
      const srcMp4 = document.createElement("source");
      srcMp4.src = "/ringtones/connect-default-ringtone.mp4";
      srcMp4.type = "audio/mp4";
      audio.appendChild(srcOgg);
      audio.appendChild(srcMp4);
      if (ringerDeviceId && typeof (audio as any).setSinkId === "function") {
        void (audio as any).setSinkId(ringerDeviceId).catch(() => undefined);
      }
      // If none of the sources can play (decode/codec failure), ring via Web Audio.
      audio.addEventListener("error", fallbackToSynth, { once: true });
      ringtoneAudioRef.current = audio;
      audio.load();
      audio.play().catch(fallbackToSynth);
      return;
    }
    const ctx = ensureCtx();
    if (!ctx) return;
    if (ringerDeviceId && typeof (ctx as any).setSinkId === "function") {
      void (ctx as any).setSinkId(ringerDeviceId).catch(() => undefined);
    }
    ringtoneRef.current = startIncomingRingtone(ctx, 0.18 * ringerVol);
  }, [stopAll]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPreferenceChange = () => {
      if (!getWebRingerEnabled()) stopAll();
    };
    window.addEventListener(WEB_RINGER_ENABLED_EVENT, onPreferenceChange);
    return () => window.removeEventListener(WEB_RINGER_ENABLED_EVENT, onPreferenceChange);
  }, [stopAll]);

  /**
   * DTMF keypad tone — plays once for 120ms.
   * Should NOT start/stop ringback or ringtone.
   */
  const playDtmfTone = useCallback((digit: string) => {
    const freqs = DTMF_FREQS[digit.toUpperCase()];
    if (!freqs) return;
    const ctx = ensureCtx();
    if (!ctx) return;
    playToneBurst(ctx, freqs[0], freqs[1], 120, 0.15);
  }, []);

  /** Short disconnect chime when a call ends (user hangup or remote BYE). */
  const playCallEndChime = useCallback(() => {
    const ctx = ensureCtx();
    if (!ctx) return;
    playCallEndChimePattern(ctx);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAll();
      ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, [stopAll]);

  const resumeOutputAfterRingback = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => undefined);
    }
  }, []);

  return {
    startRingback,
    startUkLocalRingback,
    startEuropeanLocalRingback,
    stopLocalRingback,
    resumeOutputAfterRingback,
    startRingtone,
    playDtmfTone,
    playCallEndChime,
    stopAll,
  };
}
