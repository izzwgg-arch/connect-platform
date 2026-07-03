// Pure, React-Native-free helpers for dndStore's best-effort server-side DND
// report. Extracted so the retry/error-swallowing contract is unit-testable
// without a React Native runtime — dndStore.ts itself imports react-native
// and expo-secure-store and cannot be executed under plain `tsx --test`,
// matching this repo's existing convention of testing extracted pure logic
// (e.g. apps/mobile/src/sip/mobileWakeRegistration.ts).

export type DndReportPayload = { dnd: boolean };

export function buildDndReportPayload(dnd: boolean): DndReportPayload {
  return { dnd };
}

export type ReportDndRetryOptions = {
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Runs `report` up to `maxAttempts` times with a short fixed delay between
 * attempts, but NEVER throws — DND reporting is best-effort telemetry, not a
 * call-handling dependency. Returns true iff some attempt succeeded, false if
 * every attempt failed (including zero attempts, e.g. maxAttempts <= 0).
 */
export async function reportDndWithBoundedRetry(
  report: () => Promise<void>,
  opts: ReportDndRetryOptions = {},
): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? 2;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await report();
      return true;
    } catch {
      // Swallowed deliberately: DND reporting must never throw into the
      // SIP/call-handling code path that calls setDnd()/hydrateDnd().
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }
  return false;
}
