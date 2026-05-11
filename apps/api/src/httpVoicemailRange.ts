import type { FastifyReply, FastifyRequest } from "fastify";

/** Parse a single Range: bytes=... header; returns inclusive start/end or null. */
export function parseBytesRangeHeader(rangeHeader: string | undefined, bodyLength: number): { start: number; end: number } | null {
  if (!rangeHeader || bodyLength <= 0) return null;
  const raw = String(rangeHeader).trim();
  if (!raw.startsWith("bytes=")) return null;
  const spec = raw.slice("bytes=".length).split(",")[0]?.trim();
  if (!spec) return null;
  const mClosed = /^(\d+)-(\d+)$/.exec(spec);
  if (mClosed) {
    const start = parseInt(mClosed[1]!, 10);
    const end = parseInt(mClosed[2]!, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= bodyLength) return null;
    return { start, end: Math.min(end, bodyLength - 1) };
  }
  const mOpen = /^(\d+)-$/.exec(spec);
  if (mOpen) {
    const start = parseInt(mOpen[1]!, 10);
    if (!Number.isFinite(start) || start >= bodyLength) return null;
    return { start, end: bodyLength - 1 };
  }
  const mSuffix = /^-(\d+)$/.exec(spec);
  if (mSuffix) {
    const suffix = parseInt(mSuffix[1]!, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const len = Math.min(suffix, bodyLength);
    return { start: bodyLength - len, end: bodyLength - 1 };
  }
  return null;
}

/**
 * Send full body or 206 partial when Range is valid; 416 when unsatisfiable.
 */
export function sendBufferWithOptionalRange(
  req: FastifyRequest,
  reply: FastifyReply,
  buf: Buffer,
  contentType: string,
): void {
  const range = req.headers.range;
  const parsed = parseBytesRangeHeader(Array.isArray(range) ? range[0] : range, buf.length);
  if (!parsed) {
    reply.header("Content-Type", contentType);
    reply.header("Content-Length", String(buf.byteLength));
    reply.header("Accept-Ranges", "bytes");
    reply.send(buf);
    return;
  }
  const { start, end } = parsed;
  if (start >= buf.length || start > end) {
    reply.header("Content-Range", `bytes */${buf.length}`);
    reply.code(416).send();
    return;
  }
  const chunk = buf.subarray(start, end + 1);
  reply.code(206);
  reply.header("Content-Type", contentType);
  reply.header("Content-Length", String(chunk.byteLength));
  reply.header("Content-Range", `bytes ${start}-${end}/${buf.length}`);
  reply.header("Accept-Ranges", "bytes");
  reply.send(chunk);
}
