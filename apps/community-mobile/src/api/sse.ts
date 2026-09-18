/**
 * Pure Server-Sent Events helpers — no imports, so they're testable under
 * plain Node (src/api/sse.test.ts). Two independent pieces:
 *
 * 1. `parseSseChunk` splits a buffered SSE byte stream (as decoded text) into
 *    complete `event:`/`data:` frames plus whatever incomplete tail should be
 *    kept and prepended to the next chunk. This is the wire format
 *    GET /realtime/stream writes (see apps/community-api/src/core/routes.ts)
 *    and what a raw-fetch/ReadableStream consumer would need to parse by
 *    hand. src/api/realtime.ts's actual runtime client uses the
 *    `react-native-sse` library, which parses its own XHR responseText
 *    internally, so this function isn't on that hot path — it documents the
 *    wire format precisely and is kept ready for any consumer (a test, a
 *    debug tool, a future non-library client) that reads the raw stream.
 *
 * 2. `parseSseData` safely JSON-decodes one frame's `data` field — every
 *    event this app cares about (`hello`, `notification`, `message`,
 *    `thread`, `typing`, `ping`) is a JSON object, but a malformed or
 *    non-JSON payload should never throw and take the stream down with it.
 */
export type SseFrame = { event: string; data: string; id: string | null };

/**
 * Splits `buffer` on the SSE frame delimiter (a blank line — `\n\n`, or
 * `\r\n\r\n` normalized first). Returns the complete frames found and `rest`,
 * the trailing partial frame (possibly empty) the caller should prepend to
 * the next chunk it reads. Lines starting with `:` are comments (used for
 * keep-alive pings by some servers) and are ignored, matching the SSE spec.
 * A frame with no `data:` line at all (e.g. only a comment) is dropped, but
 * an explicit `data:` with an empty value is kept (a valid empty-string
 * event some servers send).
 */
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const raw of parts) {
    if (!raw.trim()) continue;
    const lines = raw.split("\n").filter((l) => !l.startsWith(":"));
    const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
    if (!dataLines.length) continue;
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const idLine = lines.find((l) => l.startsWith("id:"));
    frames.push({
      event: eventLine ? eventLine.slice(6).replace(/^ /, "").trim() || "message" : "message",
      data: dataLines.join("\n"),
      id: idLine ? idLine.slice(3).replace(/^ /, "").trim() : null,
    });
  }
  return { frames, rest };
}

/** JSON.parse that falls back to the raw string on malformed input — never throws. */
export function parseSseData<T = unknown>(data: string): T | string {
  if (!data) return data;
  try {
    return JSON.parse(data) as T;
  } catch {
    return data;
  }
}
