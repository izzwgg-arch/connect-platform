/**
 * ivrit.ai speech-to-text via RunPod serverless.
 *
 * This is the Hebrew/Yiddish-tuned Whisper model (whisper-large-v3-turbo-ct2)
 * that ivrit.ai publishes — the same engine family Yiddish Labs builds on. We
 * call the RunPod endpoint directly (the `ivrit` Python package's REST shape),
 * so the owner can A/B it against Yiddish Labs and OpenAI for the mic.
 *
 * Request:  POST /v2/{endpoint}/runsync  { input: { engine, model,
 *             transcribe_args: { blob | url } } }   (blob = base64 audio)
 * Response: { status, output: [ { result: [ [ {type:"segments",
 *             data:[{text,...}]} ] ] } ] }  (aggregated generator stream)
 *
 * Note: RunPod cold-starts a worker on first use (~15–60s); warm calls are fast.
 */
export interface IvritSttResult {
  text: string;
  ms: number;
  raw?: any;
}

const DEFAULT_MODEL = process.env.IVRIT_MODEL || "ivrit-ai/whisper-large-v3-turbo-ct2";
const DEFAULT_ENGINE = process.env.IVRIT_ENGINE || "faster-whisper";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten ivrit.ai's aggregated segment stream into a single transcript. */
export function extractIvritText(output: any): string {
  const parts: string[] = [];
  const items = Array.isArray(output) ? output : [output];
  for (const item of items) {
    const result = item?.result ?? item;
    if (!Array.isArray(result)) continue;
    for (const batch of result) {
      const entries = Array.isArray(batch) ? batch : [batch];
      for (const e of entries) {
        if (e?.type === "segments" && Array.isArray(e.data)) {
          for (const s of e.data) if (typeof s?.text === "string") parts.push(s.text);
        }
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export async function ivritTranscribe(
  apiKey: string,
  endpointId: string,
  file: Buffer,
  opts: { model?: string; engine?: string; timeoutMs?: number } = {},
): Promise<IvritSttResult> {
  if (!apiKey || !endpointId) throw new Error("ivrit_not_configured");
  const model = opts.model || DEFAULT_MODEL;
  const engine = opts.engine || DEFAULT_ENGINE;
  const base = `https://api.runpod.ai/v2/${endpointId}`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const body = JSON.stringify({ input: { engine, model, streaming: false, transcribe_args: { blob: file.toString("base64") } } });
  const timeout = opts.timeoutMs ?? 120000;
  const t0 = Date.now();

  // runsync waits inline; if the job is still queued/running when it returns,
  // fall back to polling /status until terminal.
  let res = await fetch(`${base}/runsync`, { method: "POST", headers, body });
  let j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ivrit_runpod_failed:${res.status}:${JSON.stringify(j).slice(0, 140)}`);

  const terminal = (s: string) => ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(s);
  while (j.status && !terminal(j.status)) {
    if (Date.now() - t0 > timeout) throw new Error("ivrit_timeout");
    await sleep(1000);
    const g = await fetch(`${base}/status/${j.id}`, { headers });
    j = await g.json().catch(() => ({}));
  }
  if (j.status && j.status !== "COMPLETED") throw new Error(`ivrit_${String(j.status).toLowerCase()}:${JSON.stringify(j.error ?? "").slice(0, 140)}`);

  return { text: extractIvritText(j.output), ms: Date.now() - t0, raw: j };
}
