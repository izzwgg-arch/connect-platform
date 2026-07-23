/**
 * Snapshot store (X1 spec §3.1/§3.2) — the "before photo" every modify/repair
 * write must capture BEFORE dispatch. Backed by AgentPbxSnapshot; every state is
 * checksummed so a corrupted/tampered snapshot is detected before any revert
 * trusts it.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../actions/bindings";

export interface CaptureInput {
  actionId: string;
  capabilityId: string;
  tenantId: string;
  objectType: string;
  objectId: string;
  state: unknown;
  source: "astdb" | "api" | "helper";
  simulated: boolean;
  retentionDays?: number;
}

export function snapshotChecksum(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export class SnapshotStore {
  constructor(private prisma: any) {}

  async capture(input: CaptureInput): Promise<{ id: string; checksum: string }> {
    const days = input.retentionDays ?? Number(process.env.AGENT_MODIFY_REVERT_DAYS ?? 7);
    const row = await this.prisma.agentPbxSnapshot.create({
      data: {
        actionId: input.actionId,
        capabilityId: input.capabilityId,
        tenantId: input.tenantId,
        objectType: input.objectType,
        objectId: input.objectId,
        stateJson: input.state as any,
        checksum: snapshotChecksum(input.state),
        source: input.source,
        simulated: input.simulated,
        expiresAt: new Date(Date.now() + days * 86400_000),
      },
    });
    return { id: row.id, checksum: row.checksum };
  }

  async getForAction(actionId: string): Promise<any | null> {
    return this.prisma.agentPbxSnapshot.findUnique({ where: { actionId } });
  }

  /** True when the stored state still matches its checksum (untampered). */
  integrityOk(row: { stateJson: unknown; checksum: string }): boolean {
    return snapshotChecksum(row.stateJson) === row.checksum;
  }

  async markRestored(id: string): Promise<void> {
    await this.prisma.agentPbxSnapshot.update({ where: { id }, data: { restoredAt: new Date() } });
  }
}
