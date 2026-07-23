/**
 * ivrit.ai (RunPod) keep-warm pinger.
 *
 * RunPod serverless scales to zero when idle, so the first transcription after a
 * lull pays a ~15–60s cold start. This sends a tiny throwaway job on an interval
 * so a worker stays spun up during active hours — turning cold starts into warm
 * ~2s calls.
 *
 * IMPORTANT: this only keeps a worker alive if the endpoint's **Idle Timeout**
 * (RunPod console) is >= the ping interval. Set idle timeout to a few minutes and
 * ping a bit under that. Off by default; enable with AGENT_IVRIT_KEEPWARM=1.
 *
 * Cost: each ping is a ~1s transcription (a fraction of a cent) plus the GPU
 * staying warm during your active window. Far cheaper than 24/7 Active Workers,
 * near-instant during business hours.
 */

/** 1-second 8kHz mono WAV (near-silent tone), base64 — enough to spin a worker. */
function tinyWavBase64(): string {
  const rate = 8000, secs = 1, n = rate * secs;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(200 * Math.sin((2 * Math.PI * 110 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]).toString("base64");
}

export interface KeepWarmOpts {
  apiKey: () => string | null;
  endpointId: () => string | null;
  model: string;
  intervalSec: number;
  /** [startHour, endHour) local time, 24h. Omit for always-on while enabled. */
  hours?: [number, number];
  audit?: { record: (e: any) => Promise<boolean> };
}

function inHours(hours?: [number, number]): boolean {
  if (!hours) return true;
  const h = new Date().getHours();
  const [a, b] = hours;
  return a <= b ? h >= a && h < b : h >= a || h < b; // supports overnight windows
}

/** Start the pinger. Returns a stop() function. */
export function startIvritKeepWarm(opts: KeepWarmOpts): () => void {
  const blob = tinyWavBase64();
  let pings = 0;
  const ping = async () => {
    if (!inHours(opts.hours)) return;
    const key = opts.apiKey();
    const ep = opts.endpointId();
    if (!key || !ep) return;
    try {
      // fire-and-forget async submit; we don't await the transcript
      await fetch(`https://api.runpod.ai/v2/${ep}/run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: { engine: "faster-whisper", model: opts.model, streaming: false, transcribe_args: { blob, language: "yi" } } }),
      });
      pings++;
      if (opts.audit && pings % 20 === 1) await opts.audit.record({ actor: "system", event: "ivrit.keepwarm_ping", payload: { pings } });
    } catch {
      /* ignore — best-effort warmth */
    }
  };
  void ping();
  const t = setInterval(ping, Math.max(30, opts.intervalSec) * 1000);
  (t as any).unref?.();
  return () => clearInterval(t);
}
