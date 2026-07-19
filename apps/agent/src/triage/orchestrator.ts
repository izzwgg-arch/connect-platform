/**
 * Triage Orchestrator (PLAN.md §4, §6, §8).
 *
 * Given a customer/owner message classified as an actionable intent, it:
 *   - DIAGNOSTIC → runs the certified diagnostics engine (own-tenant scoped),
 *     returns a plain-language reply, files the team report.
 *   - ACTION → maps to a catalog capability, runs the policy engine, and either
 *     drafts an approval-gated action or returns a polite escalation.
 *
 * Everything here respects the certified manifest + policy + tenant isolation.
 * It NEVER executes a PBX write directly — actions go through the ActionService
 * (approval + gated executor). Diagnosis is read-only.
 */
import type { Intent, ActionType } from "./intent";
import { evaluate, type TenantPolicy, type Role } from "../policy/policy";
import { capabilityById, executableCapabilities } from "../manifest/manifest";
import type { DiagnosticsEngine } from "../diag/engine";
import type { ActionService } from "../actions/service";

export interface TriageCtx {
  tenantId: string;
  clientUserId: string | null;
  role: Role;
  conversationId?: string;
}

export interface TriageOutcome {
  handled: boolean;
  reply?: string;
  yiddish?: string;
  diagReportId?: string;
  actionId?: string;
}

const ACTION_CAPABILITY: Record<ActionType, string | null> = {
  forward: "action.A1.temp_forward",
  dnd: "action.A7.dnd",
  ivr_switch: "action.A3.ivr_switch",
  vm_reset: "action.A5.vm_pin_reset",
  unknown: null,
};

export class TriageOrchestrator {
  constructor(
    private prisma: any,
    private diag: DiagnosticsEngine,
    private actions: ActionService,
    private loadPolicy: (tenantId: string) => Promise<TenantPolicy | null>,
  ) {}

  async handle(intent: Intent, ctx: TriageCtx, language: "en" | "yi"): Promise<TriageOutcome> {
    if (intent.kind === "chat") return { handled: false };

    if (intent.kind === "diagnostic") {
      // diag.full_diagnosis must be certified/executable.
      const cap = capabilityById("diag.full_diagnosis");
      if (!cap || !executableCapabilities().some((c) => c.id === cap.id)) return { handled: false };
      const extension = intent.extensionHint ?? (await this.resolveExtension(ctx));
      const report = await this.diag.run(ctx.tenantId, extension, intent.complaint, `${ctx.role}:${ctx.clientUserId ?? "?"}`);
      const top = report.hypotheses[0];
      const en = `Thanks — I ran a quick check${extension ? ` on extension ${extension}` : ""}. Most likely: ${top?.cause ?? "no clear fault found"}. ${top?.fixPath === "team" || top?.fixPath === "client_side" ? "I've sent the full details to our team, who'll follow up." : "I've logged the details for our team."}`;
      return {
        handled: true,
        reply: en,
        yiddish: language === "yi" ? `אַ דאַנק — איך האָב געמאַכט אַ שנעלע בדיקה. איך האָב איבערגעגעבן די פּרטים צו אונדזער טים.` : undefined,
        diagReportId: report.id,
      };
    }

    // intent.kind === "action"
    const capId = ACTION_CAPABILITY[intent.actionType];
    if (!capId) return { handled: false };
    const cap = capabilityById(capId);
    if (!cap) return { handled: false };

    const policy = await this.loadPolicy(ctx.tenantId);
    const decision = evaluate(cap, { role: ctx.role, tenantId: ctx.tenantId, targetTenantId: ctx.tenantId }, policy, {
      targetExtension: intent.extensionHint,
    });

    if (!decision.ok) {
      // Policy blocked → polite escalation, logged by the action layer separately.
      return {
        handled: true,
        reply: decision.message,
        yiddish: language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined,
      };
    }

    // Build a human summary and draft the action (approval-gated unless owner).
    const summary = this.summarize(intent);
    const action = await this.actions.create({
      tenantId: ctx.tenantId,
      capabilityId: capId,
      params: { extension: intent.extensionHint, target: intent.targetHint, until: intent.untilHint, raw: intent.raw },
      summary,
      requestedBy: ctx.clientUserId ?? "unknown",
      requestedRole: ctx.role,
      conversationId: ctx.conversationId,
      autoApprove: ctx.role === "owner",
      revertAfterHours: intent.untilHint ? undefined : undefined,
      riskTier: intent.actionType === "ivr_switch" ? "medium" : "low",
    });

    const submitted = action.status === "EXECUTED";
    return {
      handled: true,
      actionId: action.id,
      reply: submitted
        ? `Done — ${summary}.`
        : `Got it: ${summary}. I've submitted this for approval — I'll confirm here the moment it's live.`,
      yiddish:
        language === "yi"
          ? submitted
            ? `געטאָן — ${summary}.`
            : `איך האָב עס איבערגעגעבן פֿאַר אַפּרואוו. איך וועל אײַך לאָזן וויסן ווען עס איז גרייט.`
          : undefined,
    };
  }

  private async resolveExtension(ctx: TriageCtx): Promise<string | null> {
    if (!ctx.clientUserId) return null;
    try {
      const ext = await this.prisma.extension.findFirst({ where: { tenantId: ctx.tenantId, ownerUserId: ctx.clientUserId }, select: { extNumber: true } });
      return ext?.extNumber ?? null;
    } catch {
      return null;
    }
  }

  private summarize(intent: Extract<Intent, { kind: "action" }>): string {
    const ext = intent.extensionHint ? `ext ${intent.extensionHint}` : "your extension";
    switch (intent.actionType) {
      case "forward":
        return `forward ${ext} to ${intent.targetHint ? `ext ${intent.targetHint}` : "the requested number"}${intent.untilHint ? ` until ${intent.untilHint}` : ""}`;
      case "dnd":
        return `enable Do Not Disturb on ${ext}${intent.untilHint ? ` until ${intent.untilHint}` : ""}`;
      case "ivr_switch":
        return `switch the IVR${intent.untilHint ? ` until ${intent.untilHint}` : ""}`;
      case "vm_reset":
        return `reset the voicemail PIN on ${ext}`;
      default:
        return intent.raw;
    }
  }
}
