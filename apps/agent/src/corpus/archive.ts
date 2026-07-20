/**
 * Archive Ingestor (YIDDISH_TUNING.md). Points the agent at a mounted drive of
 * audio (thousands of hours: comedy, kids' stories, spoken content) and works
 * through it 24/7: walk → transcribe → capture into the corpus, tagged by
 * collection, progress-tracked so it resumes and never re-does a file.
 *
 * Runs unattended in small batches (a scheduler drains it), so it never floods
 * the box or the STT provider. Transcription goes through the same Transcriber
 * (guarded until the STT key exists) — until then the ingestor still WALKS and
 * catalogs the archive so we know exactly what's there.
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CorpusService } from "./corpus";
import type { AuditLog } from "../audit/audit";

const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac", ".aac", ".wma", ".opus"]);

export interface Transcribe {
  transcribe(input: { recordingId: string; audioRef: string; languageHint?: "en" | "yi" | "auto" }): Promise<{ ok: boolean; text?: string; language?: string; provider?: string }>;
}

export interface ArchiveProgress {
  isDone(fileKey: string): Promise<boolean>;
  markDone(fileKey: string, meta: Record<string, unknown>): Promise<void>;
  stats(): Promise<{ processed: number }>;
}

/** Progress stored in AgentMemory (tenantId="__archive__") — no new table. */
export class MemoryArchiveProgress implements ArchiveProgress {
  constructor(private prisma: any) {}
  async isDone(fileKey: string): Promise<boolean> {
    try {
      const r = await this.prisma.agentMemory.findUnique({ where: { tenantId_key: { tenantId: "__archive__", key: fileKey } } });
      return !!r;
    } catch {
      return false;
    }
  }
  async markDone(fileKey: string, meta: Record<string, unknown>): Promise<void> {
    await this.prisma.agentMemory.upsert({
      where: { tenantId_key: { tenantId: "__archive__", key: fileKey } },
      update: { value: JSON.stringify(meta) },
      create: { tenantId: "__archive__", key: fileKey, value: JSON.stringify(meta) },
    });
  }
  async stats(): Promise<{ processed: number }> {
    try {
      return { processed: await this.prisma.agentMemory.count({ where: { tenantId: "__archive__" } }) };
    } catch {
      return { processed: 0 };
    }
  }
}

export function fileKey(absPath: string): string {
  return "arc_" + createHash("sha1").update(absPath).digest("hex").slice(0, 24);
}

/** Collection tag from the top folder under the archive root (comedy, kids…). */
export function collectionOf(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  const top = rel.split(path.sep)[0] ?? "misc";
  return top.toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "misc";
}

export class ArchiveIngestor {
  constructor(
    private corpus: CorpusService,
    private progress: ArchiveProgress,
    private transcriber: Transcribe | null,
    private audit: AuditLog,
  ) {}

  /** Recursively list audio files under root (bounded). */
  async listAudio(root: string, max = 100000): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      if (out.length >= max) return;
      let entries: any[] = [];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
      }
    };
    await walk(root);
    return out;
  }

  /** Process up to `batch` not-yet-done files. Called repeatedly by a scheduler
   *  so it runs continuously without flooding. Returns how many it handled. */
  async drain(root: string, batch = 20): Promise<{ processed: number; transcribed: number; walked: number }> {
    const files = await this.listAudio(root);
    let processed = 0;
    let transcribed = 0;
    for (const f of files) {
      if (processed >= batch) break;
      const key = fileKey(f);
      if (await this.progress.isDone(key)) continue;
      const collection = collectionOf(root, f);
      let text: string | undefined;
      let provider: string | undefined;
      if (this.transcriber) {
        try {
          const r = await this.transcriber.transcribe({ recordingId: key, audioRef: f, languageHint: "auto" });
          if (r.ok && r.text) {
            text = r.text;
            provider = r.provider;
          }
        } catch {
          /* leave untranscribed; still cataloged */
        }
      }
      if (text) {
        await this.corpus.capture({ recordingId: key, text, audioRef: f, model: provider, source: "bulk_import", confidence: 0.9, trainingEligible: false });
        transcribed++;
      }
      await this.progress.markDone(key, { path: f, collection, transcribed: !!text, at: new Date().toISOString() });
      processed++;
    }
    if (processed > 0) await this.audit.record({ actor: "agent", event: "archive.drain", payload: { root, processed, transcribed, totalFiles: files.length } });
    return { processed, transcribed, walked: files.length };
  }
}
