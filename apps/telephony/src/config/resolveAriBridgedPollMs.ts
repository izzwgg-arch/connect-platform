/**
 * Resolve ARI bridged poller interval (ms).
 * Normal: default 5000, minimum 3000.
 * Debug (`debug=true`): allow down to 1000 for tests / emergency only.
 */
export function resolveAriBridgedPollMs(input: { pollMs?: number; debug: boolean }): number {
  const raw = input.pollMs ?? 5000;
  if (input.debug) {
    return Math.min(120_000, Math.max(1_000, raw));
  }
  return Math.min(120_000, Math.max(3_000, raw));
}
