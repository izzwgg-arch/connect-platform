/**
 * The decoder self-test canary (round 21 follow-up, 2026-09-17).
 *
 * WHY THIS EXISTS. Round 20 shipped an on-device barcode decoder; round 21 found the
 * portal CSP silently blocked WebAssembly.instantiate() under it, so the page fell back
 * to the slow photo path for a full day before anyone noticed -- because the only check
 * anyone ran was "does /zxing/zxing_reader.wasm download", and a wasm file that downloads
 * fine can still fail to COMPILE under a CSP lacking 'wasm-unsafe-eval'. A file existing
 * is not a decoder running. This module is the check that would have caught it: decode a
 * KNOWN image through the SAME zxing entry point the live scanner uses, at page load,
 * before the camera ever opens.
 *
 * Pure and DOM-independent so it stays unit-testable with a fake zxing object (expected
 * text, wrong text, a throw, or a promise that never resolves) -- no browser, no canvas.
 * readBarcodes() decodes an ENCODED image (PNG bytes) directly just as well as pixel
 * data -- the same wasm entry point a live camera frame goes through, the same compile
 * step, the same failure mode if the CSP ever regresses -- so no canvas round trip is
 * needed to exercise the real thing this canary exists to catch.
 */

/**
 * A tiny Code-128 PNG encoding "LOOPCOMSELFTEST", rendered once with bwip-js (the same
 * library and settings as labelBarcodes.test.ts's real-decode fixtures -- see that
 * file's comment: backgroundcolor "FFFFFF" is required or it decodes as nothing) and
 * committed as a data URI so the self-test needs no network fetch and no server round
 * trip.
 */
export const SELF_TEST_PNG =
  "data:image/png;base64,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";

export const SELF_TEST_EXPECTED_TEXT = "LOOPCOMSELFTEST";

/** Give the wasm this long to instantiate and decode before calling it dead. */
const SELF_TEST_TIMEOUT_MS = 4000;

export type SelfTestReason = "ok" | "wasm_failed" | "decode_mismatch" | "timeout";
export type SelfTestResult = { ok: boolean; reason: SelfTestReason };

/**
 * The slice of zxing-wasm/reader this module actually calls, kept narrow so a test can
 * hand in a fake without importing the real (large) wasm-backed module.
 * ⛔ `opts` is deliberately `any`, not the real module's `ReaderOptions`: TS checks
 * function-typed properties contravariantly, so a caller passing the REAL module
 * (whose `readBarcodes` takes the narrower `ReaderOptions`) would fail structural
 * assignment against a stricter options type here. This type only exists to let a
 * test hand in a fake; it is never used to validate what a caller passes zxing.
 */
export type ZxingReaderLike = {
  readBarcodes: (
    input: Uint8Array | ArrayBuffer | Blob | ImageData,
    opts?: any,
  ) => Promise<Array<{ text?: string | null }>>;
};

function pngBytesFromDataUri(dataUri: string): Uint8Array {
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  // atob is a browser global; Node (this module's test runner) has had it since v16, so
  // this works in both without a bundler-specific Buffer import inside browser code.
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Decode the embedded canary and say whether the on-device path actually works.
 * NEVER a gate on anything a customer scans -- this only decides which MODE the page
 * offers (device vs. photo). A forged or garbled real scan is still judged solely by
 * the server, exactly as round 20 and round 18 built it.
 */
export async function runDecoderSelfTest(
  zxing: ZxingReaderLike,
  opts: { timeoutMs?: number } = {},
): Promise<SelfTestResult> {
  const timeoutMs = opts.timeoutMs ?? SELF_TEST_TIMEOUT_MS;
  const bytes = pngBytesFromDataUri(SELF_TEST_PNG);

  const attempt = (async (): Promise<SelfTestResult> => {
    let results: Array<{ text?: string | null }>;
    try {
      results = await zxing.readBarcodes(bytes, {
        tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 1,
      });
    } catch {
      // A throw here IS the round-21 failure mode: WebAssembly.instantiate() rejecting
      // because the CSP script-src lacks 'wasm-unsafe-eval'.
      return { ok: false, reason: "wasm_failed" };
    }
    const text = String(results?.[0]?.text ?? "").trim();
    if (text === SELF_TEST_EXPECTED_TEXT) return { ok: true, reason: "ok" };
    return { ok: false, reason: "decode_mismatch" };
  })();

  const timeout = new Promise<SelfTestResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });

  return Promise.race([attempt, timeout]);
}
