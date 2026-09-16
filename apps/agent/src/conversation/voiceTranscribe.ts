import type { FastifyInstance } from "fastify";
import { setTimeout as delay } from "node:timers/promises";
import { verifyPortalJwt } from "../auth";
import { YiddishLabsClient } from "../transcription/yiddishlabs";

/** Dedicated live-call STT: Yiddish Labs only, bounded audio, no silent fallback.
 * Audio remains in memory; no local recording or training-corpus write. */
export function registerVoiceTranscribe(app: FastifyInstance, deps: {
  keys: { yiddishLabsApiKey?: string | null };
  glossaryContext: () => Promise<string>;
  client?: (key: string) => Pick<YiddishLabsClient, "submitSync" | "get">;
}) {
  const active = new Set<string>();
  app.post("/agent/chat/voice-transcribe", { bodyLimit: 1_400_000 }, async (req, reply) => {
    const auth = req.headers.authorization;
    const identity = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
    if (!identity) return reply.code(403).send({ ok: false, error: "forbidden" });
    const encoded = (req.body as any)?.audioBase64;
    if (typeof encoded !== "string" || encoded.length > 1_350_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return reply.code(400).send({ ok: false, error: "bad_audio" });
    const audio = Buffer.from(encoded, "base64");
    // Our browser emits canonical mono 16-bit PCM WAV at 16kHz, <=30 seconds.
    if (audio.length < 3244 || audio.length > 960_044 || audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 16) !== "WAVEfmt " || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 ||
      audio.readUInt16LE(34) !== 16 || audio.toString("ascii", 36, 40) !== "data" ||
      audio.readUInt32LE(40) !== audio.length - 44 || audio.readUInt32LE(4) !== audio.length - 8) {
      return reply.code(400).send({ ok: false, error: "bad_audio" });
    }
    const key = deps.keys.yiddishLabsApiKey;
    if (!key) return reply.code(503).send({ ok: false, error: "yiddishlabs_not_configured" });
    const caller = JSON.stringify([identity.tenantId, identity.clientUserId]);
    if (active.has(caller) || active.size >= 8) return reply.code(429).send({ ok: false, error: "transcription_busy" });
    active.add(caller);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45_000);
    const disconnected = () => { if (!reply.raw.writableFinished) abort.abort(); };
    reply.raw.on("close", disconnected);
    const started = Date.now();
    try {
      const client = deps.client?.(key) ?? new YiddishLabsClient(key);
      const context = await deps.glossaryContext();
      let result = await client.submitSync({ file: audio, filename: "laybel.wav", language: "auto", context, rapid: true }, abort.signal);
      while (result.status === "queued" || result.status === "processing") {
        await delay(750, undefined, { signal: abort.signal });
        result = await client.get(result.id, false, abort.signal);
      }
      const text = result.text?.replace(/⟦[^⟧]*⟧/g, " ").replace(/[⟦⟧]/g, " ").trim();
      if (result.status !== "completed" || !text) throw new Error("empty_or_failed");
      const ms = Date.now() - started;
      req.log.info({ event: "laybel.stt", engine: "yiddishlabs", ms, bytes: audio.length, language: YiddishLabsClient.normalizeLanguage(result) }, "Laybel transcription completed");
      return { ok: true, engine: "yiddishlabs", text, language: YiddishLabsClient.normalizeLanguage(result), ms };
    } catch {
      // Never expose provider response bodies, keys, or an alternative transcript.
      req.log.warn({ event: "laybel.stt_failed", ms: Date.now() - started, timedOut: abort.signal.aborted }, "Laybel Yiddish Labs transcription failed");
      return reply.code(502).send({ ok: false, error: "yiddishlabs_transcription_unavailable" });
    } finally { active.delete(caller); clearTimeout(timer); reply.raw.off("close", disconnected); }
  });
}
