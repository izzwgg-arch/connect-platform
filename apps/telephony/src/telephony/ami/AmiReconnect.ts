// Exponential-backoff reconnection scheduler.
// The caller owns the reconnect loop; this module just computes delays.

export interface ReconnectState {
  attempt: number;
  totalReconnects: number;
  aborted: boolean;
}

const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const JITTER_MAX_MS = 1_000;

export function createReconnectState(): ReconnectState {
  return { attempt: 0, totalReconnects: 0, aborted: false };
}

export function nextDelayMs(state: ReconnectState): number {
  const exp = Math.min(state.attempt, 10);
  const base = MIN_DELAY_MS * 2 ** exp;
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  return Math.min(base + jitter, MAX_DELAY_MS);
}

export function onConnected(state: ReconnectState): void {
  if (state.attempt > 0) state.totalReconnects++;
  state.attempt = 0;
}

export function onFailed(state: ReconnectState): void {
  state.attempt++;
}

export function abort(state: ReconnectState): void {
  state.aborted = true;
}

export function isAborted(state: ReconnectState): boolean {
  return state.aborted;
}
