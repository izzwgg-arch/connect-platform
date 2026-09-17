#!/usr/bin/env -S npx tsx
/**
 * Loopcom Yiddish fine-tune — smoke-test a RunPod serverless STT endpoint
 * (Lane B, §3.2.6). Sends one short clip and prints the text + timing back —
 * the thing that actually proves an endpoint is alive, as opposed to just
 * "created" in the RunPod dashboard.
 *
 * Payload shape copied from the platform's real Everett client
 * (apps/agent/src/transcription/everett.ts): POST
 * https://api.runpod.ai/v2/{endpointId}/runsync with
 * { input: { engine: "faster-whisper", model, transcribe_args: { blob,
 * language }, streaming: false } }, base64 audio under `blob` (≤ ~7MB —
 * runsync's request cap is ~10MB and base64 inflates 4/3), polling
 * /status/{id} if the job outlives runsync's wait.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE = process.env.EVERETT_BASE_URL || "https://api.runpod.ai/v2";
const MAX_BLOB_BYTES = 7 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 10 * 60_000;

export interface SmokeResult {
  ok: boolean;
  text?: string;
  language?: string;
  executionMs?: number;
  error?: string;
}

export interface SmokeDeps {
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/** Build the exact request body the real Everett client sends. Pure + testable. */
export function buildRequestBody(model: string, audioBase64: string, language = "yi"): string {
  return JSON.stringify({
    input: { engine: "faster-whisper", model, transcribe_args: { blob: audioBase64, language }, streaming: false },
  });
}

export function parseResponse(j: any): SmokeResult {
  if (j?.status !== "COMPLETED") return { ok: false, error: `status=${j?.status ?? "unknown"} ${j?.error ?? ""}`.trim() };
  const outputs = Array.isArray(j.output) ? j.output : [j.output];
  const texts: string[] = [];
  let language: string | undefined;
  for (const item of outputs) {
    const batches = Array.isArray(item?.result) ? item.result.flat() : [];
    for (const entry of batches) {
      if (entry?.type === "segments" && Array.isArray(entry.data)) {
        for (const s of entry.data) texts.push(String(s.text ?? ""));
      }
      if (entry?.language) language = entry.language;
    }
  }
  return { ok: true, text: texts.join("").trim(), language, executionMs: j.executionTime };
}

export async function smokeTranscribe(
  endpointId: string,
  apiKey: string,
  model: string,
  audioBuffer: Buffer,
  deps: SmokeDeps = {},
): Promise<SmokeResult> {
  if (audioBuffer.length > MAX_BLOB_BYTES) {
    return { ok: false, error: `clip is ${audioBuffer.length}b, over the ${MAX_BLOB_BYTES}b runsync blob limit — use a shorter clip` };
  }
  const f = deps.fetchFn ?? fetch;
  const sleep = deps.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const body = buildRequestBody(model, audioBuffer.toString("base64"));
  const res = await f(`${BASE}/${endpointId}/runsync`, { method: "POST", headers: headers(apiKey), body });
  if (!res.ok) return { ok: false, error: `runsync failed: ${res.status}` };
  let j: any = await res.json();

  const started = (deps.now ?? Date.now)();
  while (j.status === "IN_QUEUE" || j.status === "IN_PROGRESS") {
    if ((deps.now ?? Date.now)() - started > POLL_TIMEOUT_MS) return { ok: false, error: `timed out waiting for ${j.id}` };
    await sleep(POLL_INTERVAL_MS);
    const poll = await f(`${BASE}/${endpointId}/status/${encodeURIComponent(j.id)}`, { headers: headers(apiKey) });
    if (!poll.ok) return { ok: false, error: `status poll failed: ${poll.status}` };
    j = await poll.json();
  }
  return parseResponse(j);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const clipPath = argv[0];
  if (!clipPath) {
    console.error("usage: smoke-transcribe.ts <clip.wav|clip.mp3> [--endpoint <id>] [--model <hf repo>]");
    process.exit(1);
  }
  const idIdx = argv.indexOf("--endpoint");
  const modelIdx = argv.indexOf("--model");
  const endpointId = idIdx >= 0 ? argv[idIdx + 1] : process.env.EVERETT_ENDPOINT_ID;
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : process.env.EVERETT_MODEL || "ivrit-ai/yi-whisper-large-v3-turbo-ct2";
  const apiKey = process.env.RUNPOD_API_KEY || process.env.EVERETT_API_KEY;
  if (!endpointId) throw new Error("no endpoint id: pass --endpoint or set EVERETT_ENDPOINT_ID");
  if (!apiKey) throw new Error("no API key: set RUNPOD_API_KEY or EVERETT_API_KEY");

  const buffer = readFileSync(path.resolve(clipPath));
  console.log(`[smoke-transcribe] sending ${buffer.length} bytes to endpoint ${endpointId} (model ${model})…`);
  const started = Date.now();
  const result = await smokeTranscribe(endpointId, apiKey, model, buffer);
  const wallMs = Date.now() - started;
  if (!result.ok) {
    console.error(`[smoke-transcribe] FAILED: ${result.error}`);
    process.exit(1);
  }
  console.log(`[smoke-transcribe] OK in ${wallMs}ms (worker execution ${result.executionMs ?? "?"}ms), language=${result.language ?? "?"}`);
  console.log(`[smoke-transcribe] text: ${result.text}`);
}

const isDirectRun = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    console.error("[smoke-transcribe] fatal", err);
    process.exit(1);
  });
}
