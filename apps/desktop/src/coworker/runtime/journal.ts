/**
 * The task journal — what the Coworker did on this computer, kept HERE, on the
 * machine, as append-only JSONL under userData/coworker/. Every tool call gets a
 * row (decided / approved / denied / done / failed / cancelled) and every result
 * file the model registered gets an artifact row. `computer_task_history` reads
 * it; the Coworker window shows it; a restart does not lose it.
 *
 * ⛔ Arguments are stored REDACTED (policyCore.redactStructured) and bounded —
 * the journal is exactly the kind of place a password would otherwise end up.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { redactStructured } from "../policyCore";

export type JournalRow = {
  ts: string;
  kind: "call" | "artifact" | "task";
  taskId: string;
  callId?: string;
  tool?: string;
  verdict?: string;
  outcome?: "done" | "denied" | "failed" | "cancelled" | "timeout" | "approved" | "asked" | "started" | "ended";
  summary?: string;
  args?: unknown;
  durationMs?: number;
  artifact?: { path: string; label: string; sizeBytes?: number };
};

export class Journal {
  private file: string;
  private artifactsFile: string;
  constructor(private dir: string) {
    this.file = path.join(dir, "journal.jsonl");
    this.artifactsFile = path.join(dir, "artifacts.jsonl");
  }
  get directory() { return this.dir; }

  async append(row: JournalRow): Promise<void> {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const bounded = { ...row, args: row.args === undefined ? undefined : boundArgs(row.args), summary: row.summary?.slice(0, 400) };
      await fsp.appendFile(row.kind === "artifact" ? this.artifactsFile : this.file, JSON.stringify(bounded) + "\n", "utf8");
      // Keep the journal from growing forever: rotate at ~5 MB.
      const st = await fsp.stat(this.file).catch(() => null);
      if (st && st.size > 5 * 1024 * 1024) await fsp.rename(this.file, this.file + ".1").catch(() => {});
    } catch { /* the journal must never break a task */ }
  }

  async recent(limit = 30): Promise<{ calls: JournalRow[]; artifacts: JournalRow[] }> {
    const readTail = async (file: string, n: number) => {
      try {
        const text = await fsp.readFile(file, "utf8");
        const lines = text.split("\n").filter(Boolean);
        return lines.slice(-n).map((l) => { try { return JSON.parse(l) as JournalRow; } catch { return null; } }).filter((r): r is JournalRow => !!r).reverse();
      } catch { return []; }
    };
    return { calls: await readTail(this.file, Math.min(Math.max(1, limit), 200)), artifacts: await readTail(this.artifactsFile, 50) };
  }
}

function boundArgs(args: unknown): unknown {
  const red = redactStructured(args).value;
  let text: string;
  try { text = JSON.stringify(red); } catch { return "[unserializable]"; }
  if (text.length <= 2000) return red;
  return { truncated: true, preview: text.slice(0, 2000) };
}
