/**
 * Provisioning allow-list (PBX_PROVISIONING_PLAN.md §2, §3).
 *
 * The Scoped Executor may ONLY dispatch operations defined here. Every entry is
 * CREATE-ONLY (or an owner-created-object edit, gated by the Ownership Ledger).
 * No blanket tenant PUT, no delete of pre-existing objects, ever appears here —
 * so those operations are physically undispatchable.
 *
 * `endpointKey` maps to packages/integrations endpointRegistry. Where the base
 * registry lacks a create endpoint (extensions/ivrs/inbound_routes/etc.), the
 * executor calls callEndpoint with an inline definition marked pbxConfigMutation
 * — still create-only, still gated by simulate/scoped-allow.
 */
import { z } from "zod";

export type ProvKind =
  | "tenant"
  | "inbound_number"
  | "apply_changes"
  | "extension"
  | "device"
  | "extension_features"
  | "ivr"
  | "inbound_route"
  | "outbound_route"
  | "ring_group"
  | "queue"
  | "time_condition"
  | "virtual_ext"
  | "ivr_prompt";

export interface ProvOp {
  id: string; // catalog id, e.g. "P1"
  kind: ProvKind;
  title: string;
  method: "POST" | "PATCH"; // never a blanket PUT/DELETE on pre-existing objects
  /** VitalPBX v2 path template. :tenant substituted at dispatch. */
  path: string;
  /** Creates a new object (writes to ledger) vs. mutates an owned object. */
  creates: boolean;
  /** For inbound_number: uses the DID sub-collection, never a tenant resource PUT. */
  subCollectionSafe?: boolean;
  schema: z.ZodTypeAny;
  /** How to read the created object id out of the API response. */
  idPath?: string;
}

const nonEmpty = z.string().min(1);

export const PROVISIONING_CATALOG: Record<string, ProvOp> = {
  P1: {
    id: "P1", kind: "tenant", title: "Create tenant", method: "POST", path: "/api/v2/tenants", creates: true,
    schema: z.object({ name: nonEmpty, description: z.string().optional(), plan: z.string().optional(), extensions_limit: z.number().int().positive().optional(), settings: z.record(z.string(), z.any()).optional() }),
    idPath: "id",
  },
  P2: {
    id: "P2", kind: "inbound_number", title: "Add inbound DID to tenant", method: "PATCH", path: "/api/v2/tenants/:tenantId/inbound_numbers", creates: true, subCollectionSafe: true,
    schema: z.object({ tenantId: nonEmpty, phone_number: nonEmpty, description: z.string().optional() }),
  },
  P3: {
    id: "P3", kind: "apply_changes", title: "Apply changes for an agent-created tenant", method: "PATCH", path: "/api/v2/tenants/:tenantId/apply_changes", creates: false,
    schema: z.object({ tenantId: nonEmpty }),
  },
  P4: {
    id: "P4", kind: "extension", title: "Create extension", method: "POST", path: "/api/v2/extensions", creates: true,
    schema: z.object({ tenantId: nonEmpty, extension: nonEmpty, name: nonEmpty, voicemail: z.boolean().optional(), device_profile: z.string().optional(), email: z.string().email().optional() }),
    idPath: "id",
  },
  P5: {
    id: "P5", kind: "device", title: "Create/attach device to an agent-created extension", method: "POST", path: "/api/v2/devices", creates: true,
    schema: z.object({ tenantId: nonEmpty, extensionId: nonEmpty, type: z.enum(["sip", "webrtc"]).default("sip"), label: z.string().optional() }),
    idPath: "id",
  },
  P6: {
    id: "P6", kind: "extension_features", title: "Set features on an agent-created extension", method: "PATCH", path: "/api/v2/extensions/:extensionId", creates: false,
    schema: z.object({ tenantId: nonEmpty, extensionId: nonEmpty, features: z.record(z.string(), z.any()) }),
  },
  P7: {
    id: "P7", kind: "ivr", title: "Create IVR", method: "POST", path: "/api/v2/ivrs", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, prompt: z.string().optional(), entries: z.array(z.object({ digit: nonEmpty, destination: nonEmpty })).optional() }),
    idPath: "id",
  },
  P8: {
    id: "P8", kind: "inbound_route", title: "Create inbound route (additive; never rebinds an existing DID)", method: "POST", path: "/api/v2/inbound_routes", creates: true,
    schema: z.object({ tenantId: nonEmpty, did: nonEmpty, destination: nonEmpty }),
    idPath: "id",
  },
  P9: {
    id: "P9", kind: "outbound_route", title: "Create outbound route (high-risk, extra confirmation)", method: "POST", path: "/api/v2/outbound_routes", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, pattern: nonEmpty, trunk: nonEmpty }),
    idPath: "id",
  },
  P10: {
    id: "P10", kind: "ring_group", title: "Create ring group", method: "POST", path: "/api/v2/ring_groups", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, extensions: z.array(nonEmpty).min(1), strategy: z.string().optional() }),
    idPath: "id",
  },
  P11: {
    id: "P11", kind: "queue", title: "Create queue", method: "POST", path: "/api/v2/queues", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, strategy: z.string().optional() }),
    idPath: "id",
  },
  P12: {
    id: "P12", kind: "time_condition", title: "Create time condition / time group", method: "POST", path: "/api/v2/time_conditions", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, ranges: z.array(z.record(z.string(), z.any())).optional(), matchDestination: nonEmpty.optional(), noMatchDestination: nonEmpty.optional() }),
    idPath: "id",
  },
  P13: {
    id: "P13", kind: "virtual_ext", title: "Create virtual ext / feature code / conference / parking lot", method: "POST", path: "/api/v2/virtual_extensions", creates: true,
    schema: z.object({ tenantId: nonEmpty, subtype: z.enum(["virtual_extension", "conference", "parking_lot", "feature_code"]), name: nonEmpty, config: z.record(z.string(), z.any()).optional() }),
    idPath: "id",
  },
  P14: {
    id: "P14", kind: "ivr_prompt", title: "Upload IVR prompt audio (Voice Studio)", method: "POST", path: "/api/v2/recordings", creates: true,
    schema: z.object({ tenantId: nonEmpty, name: nonEmpty, audioFileId: nonEmpty }),
    idPath: "id",
  },
};

/** Ledger object type for a provisioning op. */
export function ledgerType(op: ProvOp): string {
  return op.kind;
}
