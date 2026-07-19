/**
 * Capability Manifest loader + gate.
 *
 * OWNER MANDATE (PLAN.md §13a): the agent may only offer what it has proven it
 * can execute. This module is the enforcement point: tools whose capability is
 * not `certified` or `live` are NOT loaded into the runtime registry — they do
 * not exist for the model. Suspension (a failed certification/regression) makes
 * a capability vanish at the next registry build.
 */
import { z } from "zod";
import rawManifest from "./capabilities.json";

export const CapabilityStatus = z.enum(["planned", "built", "certified", "live", "suspended"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const Capability = z.object({
  id: z.string().min(1),
  kind: z.enum(["read", "action", "monitor", "pipeline", "owner"]),
  roles: z.array(z.enum(["owner", "customer"])).min(1),
  title: z.string(),
  status: CapabilityStatus,
  defaultLimits: z.record(z.string(), z.number()).optional(),
  defaultCustomerMode: z.enum(["allowed", "ask_owner", "blocked"]).optional(),
  /** True for PBX-write capabilities. */
  pbxWrite: z.boolean().optional(),
  /** Certified in simulation does NOT authorize live PBX writes. liveEnabled
   *  must be independently flipped (after PW-2 live validation + owner action). */
  liveEnabled: z.boolean().optional(),
});
export type Capability = z.infer<typeof Capability>;

const Manifest = z.object({
  manifestVersion: z.number(),
  capabilities: z.array(Capability),
});

export function loadManifest(): Capability[] {
  const parsed = Manifest.parse(rawManifest);
  const ids = new Set<string>();
  for (const c of parsed.capabilities) {
    if (ids.has(c.id)) throw new Error(`Duplicate capability id in manifest: ${c.id}`);
    ids.add(c.id);
  }
  return parsed.capabilities;
}

/** Capabilities the runtime may expose. Everything else is absent, not hidden. */
export function executableCapabilities(all = loadManifest()): Capability[] {
  return all.filter((c) => c.status === "certified" || c.status === "live");
}

export function capabilityById(id: string, all = loadManifest()): Capability | undefined {
  return all.find((c) => c.id === id);
}
