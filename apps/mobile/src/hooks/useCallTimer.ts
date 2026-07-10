import { useEffect, useState } from 'react';

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
 * Wall-clock call timer anchored to `connectedAt` (epoch ms) — the moment the
 * call was answered — rather than a local counter that increments from zero.
 * Elapsed time is always derived as `Date.now() - connectedAt`, so it reflects
 * the call's real duration even after the component unmounts/remounts (e.g.
 * the user leaves the ActiveCall screen — backgrounding the app or navigating
 * away — and comes back later). A counter-based timer would restart at zero
 * on every fresh mount since its state is local to the component instance;
 * this can't, because it has no state to lose — only `connectedAt` matters.
 */
export function useCallTimer(
  connectedAt: number | null,
  active: boolean = true
): { elapsed: number; formatted: string } {
  const [nowTs, setNowTs] = useState(() => Date.now());

  useEffect(() => {
    if (!active || !connectedAt) return undefined;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, connectedAt]);

  const elapsed =
    active && connectedAt ? Math.max(0, Math.floor((nowTs - connectedAt) / 1000)) : 0;

  return {
    elapsed,
    formatted: formatDuration(elapsed),
  };
}
