import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Call timer. Accepts EITHER an absolute start timestamp in ms (preferred) OR a
 * boolean `running` (legacy). With a timestamp, elapsed is ALWAYS computed as
 * (now - startAt), so the timer auto-starts on connect (no "stuck at 00:00"),
 * shows TRUE elapsed time even after the app was backgrounded (a tick-counter
 * would freeze in the background and resume behind), and recomputes immediately
 * when the app returns to the foreground.
 */
export function useCallTimer(
  runningOrStartAt: boolean | number | null,
): { elapsed: number; formatted: string; reset: () => void } {
  const boolStartRef = useRef<number | null>(null);

  let startAt: number | null;
  if (typeof runningOrStartAt === 'number') {
    startAt = runningOrStartAt;
    boolStartRef.current = null;
  } else if (runningOrStartAt === true) {
    if (boolStartRef.current == null) boolStartRef.current = Date.now();
    startAt = boolStartRef.current;
  } else {
    boolStartRef.current = null;
    startAt = null;
  }

  const computeFrom = (base: number | null): number =>
    base != null ? Math.max(0, Math.floor((Date.now() - base) / 1000)) : 0;

  const [elapsed, setElapsed] = useState<number>(() => computeFrom(startAt));

  useEffect(() => {
    if (startAt == null) {
      setElapsed(0);
      return;
    }
    const base = startAt;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') tick();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [startAt]);

  return {
    elapsed,
    formatted: formatDuration(elapsed),
    reset: () => setElapsed(0),
  };
}
