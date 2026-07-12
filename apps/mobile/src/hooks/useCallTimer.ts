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
 * Wall-clock call timer anchored to `connectedAt` (epoch ms). Elapsed is always
 * derived as `Date.now() - connectedAt`, so it reflects real call duration even
 * across backgrounding / screen remounts. If the call is active but the session
 * has not populated `connectedAt` yet (state-store lag vs sip.callState), we
 * anchor to the first active render so the timer starts immediately instead of
 * sitting at 00:00; the real `connectedAt` takes precedence as soon as it lands.
 * An AppState listener forces an immediate recompute on return to foreground.
 */
export function useCallTimer(
  connectedAt: number | null,
  active: boolean = true
): { elapsed: number; formatted: string } {
  const [nowTs, setNowTs] = useState(() => Date.now());
  const fallbackStartRef = useRef<number | null>(null);

  if (active) {
    if (connectedAt == null && fallbackStartRef.current == null) {
      fallbackStartRef.current = Date.now();
    }
  } else if (fallbackStartRef.current != null) {
    fallbackStartRef.current = null;
  }
  const effectiveStart = connectedAt ?? fallbackStartRef.current;

  useEffect(() => {
    if (!active || !effectiveStart) return undefined;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setNowTs(Date.now());
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [active, effectiveStart]);

  const elapsed =
    active && effectiveStart ? Math.max(0, Math.floor((nowTs - effectiveStart) / 1000)) : 0;

  return {
    elapsed,
    formatted: formatDuration(elapsed),
  };
}
