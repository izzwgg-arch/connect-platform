/**
 * Per-route raw-body capture for signed webhook doors.
 *
 * ⛔ WHY THIS EXISTS (2026-09-18): server.ts registers `fastify-raw-body` with
 * `global: false`, which hands out `req.rawBody` through an `onRoute` hook — and
 * that hook only sees routes registered AFTER the plugin has loaded. Plugins load
 * at `ready()`, but every `app.post(...)` in server.ts runs synchronously before
 * that, so NO route ever got a raw body. Both Telnyx doors (`/webhooks/telnyx/sms`
 * and `/webhooks/telnyx/mobile`) answered 401 `unsigned` to every real delivery,
 * while their tests passed by faking `req.rawBody`. Found the morning
 * (845) 723-1213 ported to Telnyx and its inbound texts vanished.
 *
 * This hook depends on nothing but Fastify's own lifecycle: it buffers the
 * request stream once, stores the bytes on `req.rawBody` (the same field the
 * plugin would have used), and hands Fastify an equivalent stream to parse.
 * Attach it as `preParsing` on the route — it applies to that route only.
 */
import { Readable } from "node:stream";

export const RAW_BODY_FIELD = "rawBody";

export async function captureRawBodyPreParsing(req: any, _reply: any, payload: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  req[RAW_BODY_FIELD] = raw;
  const stream: any = Readable.from([raw]);
  // Fastify compares this against content-length when present.
  stream.receivedEncodedLength = raw.length;
  return stream;
}

/** Route options for a signed webhook door: raw body captured by this module, not the plugin. */
export const SIGNED_WEBHOOK_ROUTE_OPTIONS = { config: { rawBody: true }, preParsing: captureRawBodyPreParsing } as const;
