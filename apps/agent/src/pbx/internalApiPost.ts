/**
 * Shared POST for the agent's internal API doors (moh/route/ivr/queue/
 * extfeature), with a short retry on TRANSPORT-level failures only.
 *
 * Live incident 2026-07-27: a single "TypeError: fetch failed" (connection
 * blip between the agent and api containers) failed a fully-approved,
 * correctly-parsed MOH action with "No retry — outcome recorded for review".
 *
 * Retry policy:
 *   - A thrown fetch (no HTTP response at all: DNS, refused, reset, timeout)
 *     is retried up to `attempts` times with a short backoff. The internal
 *     endpoints are idempotent sets, so a replay cannot double-apply.
 *   - Any HTTP response — success or error — is returned as-is, never
 *     retried: the request reached the API and was answered.
 */
export async function postInternalApi(opts: {
  url: string;
  secret: string;
  body: Record<string, unknown>;
  timeoutMs: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await doFetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-internal-secret": opts.secret },
        body: JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(500 * (i + 1)); // 500ms, 1s
    }
  }
  throw lastErr;
}
