/**
 * useTelephonyAudio
 *
 * Synthesises all telephony audio client-side using the Web Audio API.
 * No audio files required — tones are generated from pure oscillators.
 *
 * Provides:
 *  - US ringback tone  (440 + 480 Hz, 2s on / 4s off cadence)
 *  - Incoming ringtone (480 + 440 Hz double-ring, NANP cadence)
 *  - DTMF keypad tones (standard ITU-T frequencies, 120 ms)
 */

import { useCallback, useEffect, useRef } from "react";
import { getWebIncomingRingtone } from "./telephonyAudioPreferences";

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
        try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.005); } catch { /* ignore */ }
      });
      activeOscillators.forEach((o) => {
        try { o.stop(t + 0.02); } catch { /* ignore */ }
      });
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
function startIncomingRingtone(ctx: AudioContext): ToneHandle {
  // Double-ring pattern: 0.4s on, 0.2s off, 0.4s on, 3s off
  let stopped = false;
  let timeoutId: ReturnType<typeof setTimeout>;
  const volume = 0.18;

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

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTelephonyAudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const ringbackRef = useRef<ToneHandle | null>(null);
  const ringtoneRef = useRef<ToneHandle | null>(null);
  const ringtoneAudioRef = useRef<HTMLAudioElement | null>(null);

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

  /** US ringback: 440+480 Hz, 2s on / 4s off. */
  const startRingback = useCallback(() => {
    stopAll();
    const ctx = ensureCtx();
    if (!ctx) return;
    ringbackRef.current = startCadenceTone(ctx, 440, 480, 2000, 4000, 0.12);
  }, [stopAll]);

  /** Incoming ringtone: double-ring pattern. */
  const startRingtone = useCallback(() => {
    stopAll();
    const ringtonePreference = getWebIncomingRingtone();
    if (ringtonePreference === "connect-default" && typeof Audio !== "undefined") {
      const audio = new Audio("/ringtones/connect-default-ringtone.mp4");
      audio.loop = true;
      audio.volume = 1;
      ringtoneAudioRef.current = audio;
      audio.play().catch(() => {
        ringtoneAudioRef.current = null;
      });
      return;
    }
    const ctx = ensureCtx();
    if (!ctx) return;
    ringtoneRef.current = startIncomingRingtone(ctx);
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopAll();
      ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, [stopAll]);

  return { startRingback, startRingtone, playDtmfTone, stopAll };
}
