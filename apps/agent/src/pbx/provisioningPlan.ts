/**
 * Provisioning Plan (owner bulk onboarding). Turns a single owner request —
 * "create tenant Feldman Medical with extensions: Moshe <moshe@x>, Rivky
 * <rivky@x>, ..." — into an ordered, approval-gated sequence of catalog ops:
 *
 *   1) P1 create tenant (API)            → yields the new tenant id
 *   2) P4 create extension × N (helper)  → one per {name, email, ext?}
 *
 * The plan is built + validated here (pure logic, fully testable). Execution
 * runs each step through the ActionService/Scoped Executor, so every step is
 * ledgered, audited, and — until PW-2 + liveEnabled — runs in SIMULATION with
 * zero PBX contact. Extension steps carry feasibility "helper": live execution
 * is refused by the executor until the create-extension helper is enabled in an
 * owner window.
 */
import { z } from "zod";

export const ExtensionSpec = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  extension: z.string().regex(/^\d{2,6}$/).optional(), // auto-assigned if omitted
  /** Voicemail-to-email: send voicemails to this extension's email. Default on
   *  when an email is present. Ignored (with a warning) when no email. */
  voicemailToEmail: z.boolean().optional(),
  /** Attach the audio file to the voicemail email (default true). */
  voicemailAttach: z.boolean().optional(),
  /** AI-transcribe voicemails (VitalPBX ai_transcription). Default off. */
  voicemailTranscribe: z.boolean().optional(),
});
export type ExtensionSpec = z.infer<typeof ExtensionSpec>;

export const ProvisioningPlanInput = z.object({
  tenantName: z.string().min(1),
  tenantEmail: z.string().email().optional(),
  plan: z.string().optional(),
  extensionsLimit: z.number().int().positive().optional(),
  extensions: z.array(ExtensionSpec).max(500).default([]),
  /** starting number when auto-assigning extensions (default 101). */
  startExtension: z.number().int().min(10).max(99999).default(101),
});
export type ProvisioningPlanInput = z.infer<typeof ProvisioningPlanInput>;

export interface PlanStep {
  seq: number;
  opId: string; // "P1" | "P4"
  summary: string;
  params: Record<string, unknown>;
  /** step that must complete first (e.g. extensions depend on the tenant). */
  dependsOn?: number;
  feasibility: "api" | "helper" | "db";
}

export interface BuiltPlan {
  ok: boolean;
  steps: PlanStep[];
  warnings: string[];
  error?: string;
}

export function buildProvisioningPlan(raw: unknown): BuiltPlan {
  const parsed = ProvisioningPlanInput.safeParse(raw);
  if (!parsed.success) return { ok: false, steps: [], warnings: [], error: JSON.stringify(parsed.error.issues) };
  const input = parsed.data;
  const warnings: string[] = [];

  // Assign extension numbers, honoring explicit ones, filling gaps sequentially.
  const used = new Set<string>();
  for (const e of input.extensions) if (e.extension) used.add(e.extension);
  let next = input.startExtension;
  const nextFree = (): string => {
    while (used.has(String(next))) next++;
    const n = String(next);
    used.add(n);
    next++;
    return n;
  };

  const steps: PlanStep[] = [];
  steps.push({
    seq: 1,
    opId: "P1",
    summary: `Create tenant "${input.tenantName}"${input.extensions.length ? ` with ${input.extensions.length} extension(s)` : ""}`,
    params: { name: input.tenantName, description: input.tenantEmail ? `Primary contact: ${input.tenantEmail}` : undefined, plan: input.plan, extensions_limit: input.extensionsLimit },
    feasibility: "api",
  });

  input.extensions.forEach((e, i) => {
    const ext = e.extension ?? nextFree();
    // Voicemail-to-email defaults ON when an email exists; impossible without one.
    const vmToEmail = e.email ? (e.voicemailToEmail ?? true) : false;
    if (!e.email) warnings.push(`Extension ${ext} (${e.name}) has no email — voicemail-to-email won't be set.`);
    else if (e.voicemailToEmail === false) warnings.push(`Extension ${ext} (${e.name}) has voicemail-to-email disabled by request.`);
    steps.push({
      seq: i + 2,
      opId: "P4",
      summary: `Create extension ${ext} — ${e.name}${e.email ? ` <${e.email}>` : ""}${vmToEmail ? " · voicemail→email" : ""}${vmToEmail && e.voicemailTranscribe ? " (AI transcribed)" : ""}`,
      params: {
        extension: ext,
        name: e.name,
        email: e.email,
        voicemail: true,
        voicemailToEmail: vmToEmail,
        voicemailAttach: vmToEmail ? (e.voicemailAttach ?? true) : false,
        voicemailTranscribe: vmToEmail ? (e.voicemailTranscribe ?? false) : false,
      },
      dependsOn: 1, // the tenant step; tenantId injected at execution time
      feasibility: "helper",
    });
  });

  return { ok: true, steps, warnings };
}
