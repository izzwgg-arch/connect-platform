/**
 * M4 (AI agent) — IVR menu digit change: request schema + pure validation.
 * The agent's ONLY door into IVR option routing. Every hard rule from the M4
 * hardening matrix (spec §3) lives here as pure, unit-testable logic so the
 * per-type correctness can be exhaustively proven offline.
 *
 * Execution (upsert IvrOptionRoute + publish AstDB) happens in server.ts via the
 * existing IVR machinery; this module never touches the DB or the PBX.
 */
import { z } from "zod";

export const IVR_DESTINATION_TYPES = [
  "extension", "queue", "ring_group", "voicemail", "ivr",
  "announcement", "external_number", "terminate", "custom",
] as const;
export type IvrDestinationType = (typeof IVR_DESTINATION_TYPES)[number];

// AstDB-safe digit keys: 0-9, plus "star"/"hash" (AstDB keys can't hold * or #).
export const IVR_DIGIT_SCHEMA = z.enum(["0","1","2","3","4","5","6","7","8","9","star","hash"]);

/** M5 prompt slots → the IvrRouteProfile field each maps to. */
export const IVR_PROMPT_SLOTS = ["greeting", "invalid", "timeout", "retry"] as const;
export type IvrPromptSlot = (typeof IVR_PROMPT_SLOTS)[number];
export const IVR_PROMPT_SLOT_FIELD: Record<IvrPromptSlot, string> = {
  greeting: "pbxPromptRef",
  invalid: "pbxInvalidPromptRef",
  timeout: "pbxTimeoutPromptRef",
  retry: "pbxRetryPromptRef",
};

/** M6 exit slots → the IvrRouteProfile field pair each maps to. */
export const IVR_EXIT_SLOTS = ["timeout", "invalid"] as const;
export type IvrExitSlot = (typeof IVR_EXIT_SLOTS)[number];
export const IVR_EXIT_SLOT_FIELDS: Record<IvrExitSlot, { type: string; ref: string }> = {
  timeout: { type: "timeoutDestinationType", ref: "timeoutDestinationRef" },
  invalid: { type: "invalidDestinationType", ref: "invalidDestinationRef" },
};

/** M7 schedule payload (mirrors PUT /voice/ivr/schedule). */
export const IvrScheduleSchema = z.object({
  timezone: z.string().min(1).max(64),
  businessHoursRules: z.array(z.object({
    day: z.number().int().min(0).max(6),
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "open must be HH:MM"),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "close must be HH:MM"),
  })).max(50),
  holidayDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "holiday must be YYYY-MM-DD")).max(200),
  defaultProfileId: z.string().nullable().optional(),
  afterHoursProfileId: z.string().nullable().optional(),
  holidayProfileId: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});
export type IvrSchedulePayload = z.infer<typeof IvrScheduleSchema>;

export const AgentIvrActionRequest = z
  .object({
    tenantId: z.string().min(1),
    action: z.enum(["list", "set_option", "clear_option", "set_prompt", "set_exit", "set_schedule"]),
    schedule: IvrScheduleSchema.optional(),
    profileId: z.string().min(1).optional(),
    optionDigit: IVR_DIGIT_SCHEMA.optional(),
    destinationType: z.enum(IVR_DESTINATION_TYPES).optional(),
    destinationRef: z.string().min(1).max(200).optional(),
    label: z.string().max(60).nullable().optional(),
    // M5 (set_prompt):
    promptSlot: z.enum(IVR_PROMPT_SLOTS).optional(),
    promptRef: z.string().max(128).nullable().optional(), // null = clear to default
    // M6 (set_exit): destinationType/Ref reused; null both = clear to default.
    exitSlot: z.enum(IVR_EXIT_SLOTS).optional(),
    agentActionId: z.string().min(1),
  })
  .refine((v) => v.action === "list" || !!v.profileId, { message: "profileId required" })
  .refine((v) => v.action !== "set_option" || (!!v.optionDigit && !!v.destinationType && !!v.destinationRef), { message: "optionDigit, destinationType, destinationRef required for set_option" })
  .refine((v) => v.action !== "clear_option" || !!v.optionDigit, { message: "optionDigit required for clear_option" })
  .refine((v) => v.action !== "set_prompt" || !!v.promptSlot, { message: "promptSlot required for set_prompt" })
  .refine((v) => v.action !== "set_exit" || !!v.exitSlot, { message: "exitSlot required for set_exit" })
  .refine((v) => v.action !== "set_exit" || (!v.destinationType && !v.destinationRef) || (!!v.destinationType && !!v.destinationRef), { message: "set_exit needs both destinationType+destinationRef (or neither, to clear)" })
  .refine((v) => v.action !== "set_schedule" || !!v.schedule, { message: "schedule required for set_schedule" });

export type AgentIvrActionRequest = z.infer<typeof AgentIvrActionRequest>;

const E164 = /^\+?[1-9]\d{1,14}$/;
const CEP = /^[a-zA-Z0-9_\-]{1,64},[a-zA-Z0-9_\-+*#]{1,80},\d{1,4}$/;

/**
 * Allow-list of dialplan contexts a `custom` destination may target. Anything
 * else is REFUSED — the agent can NEVER point a digit at an arbitrary context
 * (M4 hardening: custom restricted to safe contexts only).
 */
export const CUSTOM_CONTEXT_ALLOWLIST = new Set<string>([
  "connect-default-fallback",
  "connect-tenant-ivr",
  "connect-exit-router",
  "connect-option-router",
]);

/**
 * Full per-type + structural validation for a proposed IVR option change.
 * Returns null when OK, else a short reason. Enforces the hardening matrix:
 *  - type must be known
 *  - ref shape must match the type (E.164 for external, CEP otherwise)
 *  - custom → context must be allow-listed
 *  - ivr → loop guard: a digit may not point at its OWN profile
 */
export function validateAgentIvrOption(input: {
  destinationType: string;
  destinationRef: string;
  profileId: string;
  /** Set of profileIds owned by this tenant, for the ivr (sub-menu) loop/ownership guard. */
  tenantProfileIds?: Set<string>;
}): string | null {
  const { destinationType: type, destinationRef, profileId, tenantProfileIds } = input;
  if (!(IVR_DESTINATION_TYPES as readonly string[]).includes(type)) {
    return `Unknown destination type '${type}'`;
  }
  const ref = (destinationRef ?? "").trim();
  if (type === "terminate") return null; // ref fixed/ignored
  if (!ref) return "destinationRef required";
  if (type === "external_number") {
    return E164.test(ref) ? null : "external_number must be a phone number (E.164)";
  }
  if (!CEP.test(ref)) return `${type} destination must be "context,exten,priority"`;

  const context = ref.split(",")[0];
  if (type === "custom" && !CUSTOM_CONTEXT_ALLOWLIST.has(context)) {
    return `custom destination context '${context}' is not allow-listed`;
  }
  if (type === "ivr") {
    // A sub-menu points at connect-tenant-ivr,<profileId>,1 — guard against a
    // digit that loops back to its OWN profile (inescapable menu), and require
    // the target profile to belong to this tenant.
    const targetProfileId = ref.split(",")[1];
    if (targetProfileId === profileId) return "a menu key cannot point at its own menu (loop)";
    if (tenantProfileIds && !tenantProfileIds.has(targetProfileId)) {
      return "sub-menu target must be one of this tenant's own menus";
    }
  }
  return null;
}
