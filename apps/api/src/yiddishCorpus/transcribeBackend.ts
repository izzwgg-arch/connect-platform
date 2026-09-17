/**
 * Yiddish corpus — transcription backends.
 *
 * The `transcribe` stage handler (jobs.ts) needs Yiddish speech-to-text from
 * SOME source. Until now that was only Everett (ivrit.ai's RunPod serverless
 * faster-whisper endpoint, ~3-4c/audio hour — see everettClient.ts). Owner
 * decision 2026-09-17: labelling must ALSO be able to run for $0 on the
 * office PC's own CPU with faster-whisper running locally, so audio can be
 * transcribed on days the RunPod key or the paid budget is unavailable, or
 * simply for free.
 *
 * Both backends implement the same `TranscribeBackend` interface, so the
 * `transcribe` handler never needs to know or care which one is answering.
 * `resolveTranscribeBackend()` decides which backend to use from the
 * environment; `setTranscribeBackendForTests` lets a test replace it outright
 * (mirrors `setYiddish24Fetch` in `yiddish24Adapter.ts`).
 *
 * ⛔ This module must never import or reference Yiddish Labs, in any form. A
 * guard test reads this file's source for exactly that.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EverettClient } from "./everettClient";

// ── the shared shape every backend answers in ───────────────────────────────

export interface TranscribeWord {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface TranscribeSegment {
  start: number;
  end: number;
  text: string;
  avgLogprob?: number | null;
  noSpeechProb?: number | null;
  words?: TranscribeWord[];
}

export interface TranscribeChunkInput {
  /** Audio bytes for the chunk. */
  file: Buffer;
  /** When given, this file on disk is used instead of writing `file` to a temp file (local backend only). */
  path?: string;
}

export interface TranscribeChunkResult {
  status: "completed" | "failed";
  language?: string;
  segments: TranscribeSegment[];
}

export interface TranscribeBackend {
  readonly name: "everett" | "local" | "none";
  readonly model: string;
  readonly configured: boolean;
  readonly costCentsPerMinute: number;
  transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeChunkResult>;
}

/** ivrit.ai serverless list price is ≈3–4¢/audio hour; 0.07¢/min ≈ 4.2¢/hour. */
export const YC_EVERETT_CENTS_PER_AUDIO_MINUTE = Number(process.env.YC_EVERETT_CENTS_PER_AUDIO_MINUTE) || 0.07;

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Everett (ivrit.ai, RunPod serverless — paid) ────────────────────────────

/** Wraps the existing `EverettClient` behind the shared `TranscribeBackend` shape. */
export class EverettBackend implements TranscribeBackend {
  readonly name = "everett" as const;
  private readonly client: EverettClient;

  /** Reads env fresh via `EverettClient.fromEnv()` unless a client is injected for a test. */
  constructor(client: EverettClient = EverettClient.fromEnv()) {
    this.client = client;
  }

  get model(): string {
    return this.client.model;
  }

  get configured(): boolean {
    return this.client.configured;
  }

  get costCentsPerMinute(): number {
    return YC_EVERETT_CENTS_PER_AUDIO_MINUTE;
  }

  async transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeChunkResult> {
    const result = await this.client.transcribeChunk({ file: input.file });
    return {
      status: result.status === "completed" ? "completed" : "failed",
      language: result.language,
      segments: (result.segments ?? []).map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text,
        avgLogprob: s.avgLogprob ?? null,
        noSpeechProb: s.noSpeechProb ?? null,
        words: s.words,
      })),
    };
  }
}

// ── local faster-whisper on the office PC's own CPU — $0 ───────────────────

const DEFAULT_LOCAL_MODEL = "ivrit-ai/yi-whisper-large-v3-turbo-ct2";
const DEFAULT_LOCAL_COMPUTE = "int8";
const DEFAULT_LOCAL_THREADS = 8;
const DEFAULT_LOCAL_TIMEOUT_MS = 45 * 60_000;

export interface LocalFasterWhisperBackendOptions {
  /** Path to the python interpreter that has faster-whisper installed. Defaults to YC_LOCAL_WHISPER_PYTHON. */
  pythonPath?: string | null;
  /** Overridable so a test can point this at a tiny stub script instead of the real local_whisper.py. */
  scriptPath?: string;
  model?: string;
  compute?: string;
  threads?: number;
  timeoutMs?: number;
}

/**
 * Spawns the python interpreter at `pythonPath` running `local_whisper.py`
 * (bundled alongside this file) on a chunk's audio, on the box's own CPU.
 * $0 per minute — the only cost is wall time.
 */
export class LocalFasterWhisperBackend implements TranscribeBackend {
  readonly name = "local" as const;
  private readonly pythonPath: string | null;
  private readonly scriptPath: string;
  private readonly modelName: string;
  private readonly compute: string;
  private readonly threads: number;
  private readonly timeoutMs: number;

  constructor(opts: LocalFasterWhisperBackendOptions = {}) {
    this.pythonPath = opts.pythonPath ?? process.env.YC_LOCAL_WHISPER_PYTHON ?? null;
    this.scriptPath = opts.scriptPath ?? path.join(__dirname, "local_whisper.py");
    this.modelName = opts.model ?? process.env.YC_LOCAL_WHISPER_MODEL ?? DEFAULT_LOCAL_MODEL;
    this.compute = opts.compute ?? process.env.YC_LOCAL_WHISPER_COMPUTE ?? DEFAULT_LOCAL_COMPUTE;
    this.threads = opts.threads ?? (Number(process.env.YC_LOCAL_WHISPER_THREADS) || DEFAULT_LOCAL_THREADS);
    this.timeoutMs = opts.timeoutMs ?? (Number(process.env.YC_LOCAL_WHISPER_TIMEOUT_MS) || DEFAULT_LOCAL_TIMEOUT_MS);
  }

  get model(): string {
    return `local:${this.modelName}`;
  }

  /** A python path alone proves nothing if the file is not actually there — never throws. */
  get configured(): boolean {
    if (!this.pythonPath) return false;
    try {
      return existsSync(this.pythonPath);
    } catch {
      return false;
    }
  }

  get costCentsPerMinute(): number {
    return 0;
  }

  async transcribeChunk(input: TranscribeChunkInput): Promise<TranscribeChunkResult> {
    if (!this.configured || !this.pythonPath) throw new Error("local_whisper_not_configured");

    let audioPath = input.path ?? null;
    let ownsTempFile = false;
    if (!audioPath) {
      if (!input.file || !input.file.length) throw new Error("local_whisper_no_audio");
      audioPath = path.join(tmpdir(), `yc-local-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}.audio`);
      await writeFile(audioPath, input.file);
      ownsTempFile = true;
    }

    try {
      const args = [
        this.scriptPath,
        "--model",
        this.modelName,
        "--compute",
        this.compute,
        "--threads",
        String(this.threads),
        "--language",
        "yi",
        audioPath,
      ];
      const { stdout } = await this.run(args);
      let parsed: any;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (err) {
        throw new Error(`local_whisper_bad_json: ${(err as Error).message}`);
      }
      const segments: TranscribeSegment[] = Array.isArray(parsed?.segments)
        ? parsed.segments.map((s: any) => ({
            start: Number(s.start) || 0,
            end: Number(s.end) || 0,
            text: s.text ?? "",
            avgLogprob: numOrNull(s.avg_logprob),
            noSpeechProb: numOrNull(s.no_speech_prob),
            words: Array.isArray(s.words)
              ? s.words.map((w: any) => ({
                  word: w.word ?? "",
                  start: Number(w.start) || 0,
                  end: Number(w.end) || 0,
                  probability: typeof w.probability === "number" ? w.probability : undefined,
                }))
              : undefined,
          }))
        : [];
      return { status: "completed", language: parsed?.language ?? "yi", segments };
    } finally {
      if (ownsTempFile && audioPath) unlink(audioPath).catch(() => {});
    }
  }

  private run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const pythonPath = this.pythonPath as string;
    const timeoutMs = this.timeoutMs;
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(pythonPath, args, { windowsHide: true });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`local_whisper_timeout after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`local_whisper_exit_${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

// ── none: nothing is configured, and it says so honestly ───────────────────

export class NoneBackend implements TranscribeBackend {
  readonly name = "none" as const;
  readonly model = "none";
  readonly configured = false;
  readonly costCentsPerMinute = 0;

  async transcribeChunk(_input: TranscribeChunkInput): Promise<TranscribeChunkResult> {
    throw new Error(
      "no transcription backend configured (set YC_TRANSCRIBE_BACKEND / YC_LOCAL_WHISPER_PYTHON or EVERETT_ENDPOINT_ID)",
    );
  }
}

// ── resolution + test seam ──────────────────────────────────────────────────

let backendOverride: TranscribeBackend | null = null;

/** Tests replace the backend outright. Mirrors `setYiddish24Fetch` in yiddish24Adapter.ts. */
export function setTranscribeBackendForTests(b: TranscribeBackend | null): void {
  backendOverride = b;
}

/**
 * Which backend serves the `transcribe` stage right now.
 *
 *  - `YC_TRANSCRIBE_BACKEND=local` forces the local, free, CPU backend.
 *  - `YC_TRANSCRIBE_BACKEND=everett` forces Everett (ivrit.ai / RunPod, paid).
 *  - Unset: local when `YC_LOCAL_WHISPER_PYTHON` is set, else Everett when
 *    `EVERETT_ENDPOINT_ID` is set, else an honestly-unconfigured `NoneBackend`
 *    (never a silent crash — the handler SKIPs on `!configured`).
 *
 * A test override set via `setTranscribeBackendForTests` always wins, so the
 * handler never has to know it is under test.
 */
export function resolveTranscribeBackend(env: NodeJS.ProcessEnv = process.env): TranscribeBackend {
  if (backendOverride) return backendOverride;

  const forced = String(env.YC_TRANSCRIBE_BACKEND || "").trim().toLowerCase();
  if (forced === "local") return new LocalFasterWhisperBackend();
  if (forced === "everett") return new EverettBackend();

  if (env.YC_LOCAL_WHISPER_PYTHON) return new LocalFasterWhisperBackend();
  if (env.EVERETT_ENDPOINT_ID) return new EverettBackend();
  return new NoneBackend();
}
