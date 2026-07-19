/**
 * Append-only audit log (PLAN.md §5, §13).
 *
 * v0: JSONL to AGENT_AUDIT_DIR (survives with zero DB dependencies, works from
 * first boot). Once the agent_* Prisma migration lands, a DB sink is added and
 * BOTH sinks are written — the flat file remains the tamper-evidence copy.
 * Rule: an audit write failure must never crash the caller, but must be loudly
 * logged; and an action can proceed only if at least one sink accepted the row.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export type AuditActor = "agent" | "model" | "owner" | "customer" | "system" | "watchman";

export interface AuditEvent {
  ts?: string;
  actor: AuditActor;
  event: string;
  tenantId?: string;
  conversationId?: string;
  actionId?: string;
  capabilityId?: string;
  payload?: unknown;
}

export interface AuditSink {
  write(row: Required<Pick<AuditEvent, "ts">> & AuditEvent & { hash: string }): Promise<void>;
}

export class FileAuditSink implements AuditSink {
  constructor(private dir: string) {}
  async write(row: AuditEvent & { ts: string; hash: string }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `audit-${row.ts.slice(0, 10)}.jsonl`);
    await appendFile(file, JSON.stringify(row) + "\n", "utf8");
  }
}

export class AuditLog {
  private sinks: AuditSink[];
  constructor(sinks: AuditSink[]) {
    if (sinks.length === 0) throw new Error("AuditLog requires at least one sink");
    this.sinks = sinks;
  }

  /** Returns true if at least one sink accepted the row. */
  async record(ev: AuditEvent): Promise<boolean> {
    const ts = ev.ts ?? new Date().toISOString();
    const body = { ...ev, ts };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const row = { ...body, hash };
    let accepted = 0;
    for (const sink of this.sinks) {
      try {
        await sink.write(row);
        accepted++;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[audit] sink write failed:", err);
      }
    }
    return accepted > 0;
  }
}
