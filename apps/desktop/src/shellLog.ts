/**
 * Shell log tail — a bounded read of the desktop app's own diagnostic log
 * (`userData/logs/connect.log`, written by main.ts's diag()) so the hosted
 * portal can attach the last lines to a call's client trace (`shell_log`).
 *
 * ⛔ WHY (2026-09-04): the shell's log records renderer crashes, the phone
 * engine window's console, power-save and audio events — none of which the
 * portal can see, and which until now only existed on the customer's disk.
 * Every headset ticket that went to a screen share ended with someone opening
 * this file by hand.
 *
 * ⛔ BOUNDS ARE THE SAFETY. The renderer is the hosted portal, so anything it
 * can express a compromised server can express: this reads ONE fixed file,
 * never a path the caller names; the caller may ask for at most MAX_LINES
 * lines, each cut to MAX_LINE_CHARS, and only from the last MAX_SINCE_MS.
 * Pure over the file system so it is testable without Electron.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const MAX_LINES = 60;
export const MAX_LINE_CHARS = 300;
export const MAX_SINCE_MS = 15 * 60 * 1000;
/** Read at most this much off the end of the file, whatever the request. */
const TAIL_BYTES = 256 * 1024;

export interface ShellLogTailRequest {
  /** Only lines stamped after this (ms epoch). Clamped to the last MAX_SINCE_MS. */
  sinceMs?: number;
  /** 1..MAX_LINES */
  maxLines?: number;
}

export interface ShellLogTail {
  lines: string[];
  /** Lines that were in range but did not fit maxLines. */
  truncated: number;
  fileBytes: number;
}

/** Bound a request so the renderer can never widen it. */
export function boundRequest(req: unknown, nowMs: number): { since: number; maxLines: number } {
  const r = (req && typeof req === "object" ? req : {}) as ShellLogTailRequest;
  const floor = nowMs - MAX_SINCE_MS;
  const since = typeof r.sinceMs === "number" && Number.isFinite(r.sinceMs) ? Math.max(r.sinceMs, floor) : floor;
  const maxLines = typeof r.maxLines === "number" && Number.isFinite(r.maxLines) ? Math.min(MAX_LINES, Math.max(1, Math.floor(r.maxLines))) : MAX_LINES;
  return { since, maxLines };
}

/** Log lines start `[2026-09-04T12:00:00.000Z] [tag] …`; anything else is a continuation. */
function lineTimeMs(line: string): number | null {
  if (!line.startsWith("[")) return null;
  const end = line.indexOf("]");
  if (end < 2) return null;
  const t = Date.parse(line.slice(1, end));
  return Number.isFinite(t) ? t : null;
}

/**
 * Tail the file. Reads only the last TAIL_BYTES, splits into lines, keeps
 * the ones stamped after `since` (a continuation line inherits the last
 * stamp), returns the LAST `maxLines` of those. Never throws — a missing file
 * is an empty tail.
 */
export function readShellLogTail(file: string, req: unknown, nowMs = Date.now()): ShellLogTail {
  const { since, maxLines } = boundRequest(req, nowMs);
  let fileBytes = 0;
  let text = "";
  try {
    const st = statSync(file);
    fileBytes = st.size;
    const start = Math.max(0, st.size - TAIL_BYTES);
    const len = st.size - start;
    if (len > 0) {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        text = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return { lines: [], truncated: 0, fileBytes };
  }
  const raw = text.split(/\r?\n/);
  // The first chunk may be a cut line from the middle of the file — drop it
  // unless we read from byte 0.
  if (fileBytes > TAIL_BYTES && raw.length > 0) raw.shift();
  const inRange: string[] = [];
  let lastStamp: number | null = null;
  for (const line of raw) {
    if (!line) continue;
    const t = lineTimeMs(line);
    if (t !== null) lastStamp = t;
    const stamp = t ?? lastStamp;
    if (stamp === null || stamp < since) continue;
    inRange.push(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line);
  }
  const truncated = Math.max(0, inRange.length - maxLines);
  return { lines: inRange.slice(-maxLines), truncated, fileBytes };
}
