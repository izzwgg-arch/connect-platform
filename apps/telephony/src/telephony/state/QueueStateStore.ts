import { EventEmitter } from "events";
import type { NormalizedQueueState, QueueMember, QueueMemberStatus } from "../types";

export declare interface QueueStateStore {
  on(event: "queueUpsert", listener: (queue: NormalizedQueueState) => void): this;
}

export class QueueStateStore extends EventEmitter {
  private queues = new Map<string, NormalizedQueueState>();

  getAll(): NormalizedQueueState[] {
    return [...this.queues.values()];
  }

  getByName(name: string): NormalizedQueueState | undefined {
    return this.queues.get(name);
  }

  onCallerJoin(params: {
    queue: string;
    tenantId: string | null;
  }): void {
    const q = this.getOrCreate(params.queue, params.tenantId);
    q.callerCount = Math.max(0, q.callerCount + 1);
    q.updatedAt = new Date().toISOString();
    this.queues.set(params.queue, q);
    this.emit("queueUpsert", { ...q, members: [...q.members] });
  }

  onCallerLeave(params: {
    queue: string;
    tenantId: string | null;
  }): void {
    const q = this.getOrCreate(params.queue, params.tenantId);
    q.callerCount = Math.max(0, q.callerCount - 1);
    q.updatedAt = new Date().toISOString();
    this.queues.set(params.queue, q);
    this.emit("queueUpsert", { ...q, members: [...q.members] });
  }

  onMemberStatus(params: {
    queue: string;
    memberName: string;
    interface: string;
    status: string;
    paused: string;
    pausedReason: string;
    callsTaken: string;
    lastCall: string;
    tenantId: string | null;
  }): void {
    const q = this.getOrCreate(params.queue, params.tenantId);

    const memberStatus = amiMemberStatusToQueueMemberStatus(params.status, params.paused);

    const existing = q.members.findIndex((m) => m.interface === params.interface);
    const member: QueueMember = {
      name: params.memberName,
      interface: params.interface,
      status: memberStatus,
      paused: params.paused === "1",
      callsTaken: parseInt(params.callsTaken, 10) || 0,
      lastCall: parseInt(params.lastCall, 10) || 0,
    };

    if (existing >= 0) {
      q.members[existing] = member;
    } else {
      q.members.push(member);
    }

    q.memberCount = q.members.length;
    q.updatedAt = new Date().toISOString();
    this.queues.set(params.queue, q);
    this.emit("queueUpsert", { ...q, members: [...q.members] });
  }

  onMemberPaused(params: {
    queue: string;
    interface: string;
    paused: string;
    pausedReason: string;
  }): void {
    const q = this.queues.get(params.queue);
    if (!q) return;

    const idx = q.members.findIndex((m) => m.interface === params.interface);
    if (idx >= 0) {
      const m = q.members[idx];
      if (m) {
        m.paused = params.paused === "1";
        if (m.paused) m.status = "paused";
        else m.status = "idle";
      }
    }

    q.updatedAt = new Date().toISOString();
    this.queues.set(params.queue, q);
    this.emit("queueUpsert", { ...q, members: [...q.members] });
  }

  private getOrCreate(name: string, tenantId: string | null): NormalizedQueueState {
    return (
      this.queues.get(name) ?? {
        queueName: name,
        tenantId,
        callerCount: 0,
        memberCount: 0,
        members: [],
        updatedAt: new Date().toISOString(),
      }
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function amiMemberStatusToQueueMemberStatus(
  status: string,
  paused: string,
): QueueMemberStatus {
  if (paused === "1") return "paused";
  switch (status) {
    case "0": return "unavailable";
    case "1": return "idle";
    case "2": return "inuse";
    case "3": return "busy";
    case "4": return "unavailable";
    case "5": return "unavailable";
    case "6": return "ringing";
    case "7": return "ringing"; // ring + inuse
    case "8": return "onhold";
    default: return "unknown";
  }
}
