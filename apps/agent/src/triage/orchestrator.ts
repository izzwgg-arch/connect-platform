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
  // DND routes to the M11 modify capability (live AstDB diversion via the helper,
  // full gate chain + Izzy-bound approval). The retired action.A7 handler is dead.
  dnd: "pbx.M11",
  // Tenant hold-music routes to the M1 modify capability (portal MOH door,
  // full gate chain; auto-executes per the 2026-07-26 owner mandate).
  moh: "pbx.M1",
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
    if (intent.kind === "chat") {
      // A plain-chat message may be the ANSWER to our own pending clarifying
      // question (e.g. we asked "Which hold music would you like?" and the
      // user replied just "Main"). Resume that flow instead of dropping the
      // reply into the LLM (2026-07-26 live failure: the LLM answered "I'll
      // pass the request to the team" and nothing executed).
      const resumed = await this.resumeMohClarification(intent, ctx);
      if (!resumed) return { handled: false };
      intent = resumed;
    }

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
    let summary = this.summarize(intent);
    // Modify-executor capabilities (pbx.M*) use the single-object contract keyed
    // by the PBX tenant id + extension, not the legacy {extension,target,...} shape.
    let params: Record<string, unknown>;
    // M-series binding contract: the AgentAction row AND its params-hash are
    // keyed by the VITAL tenant number (params.tenantId, e.g. "21") — the
    // executor's G8 gate recomputes the hash from params.tenantId and requires
    // action.tenantId to equal it. Creating the row with the Connect cuid
    // breaks G8 with "Params-hash mismatch" (2026-07-26 live failure).
    let actionTenantId = ctx.tenantId;
    if (capId === "pbx.M11") {
      const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
      const ext = intent.extensionHint ?? (await this.resolveExtension(ctx));
      if (!pbxTenantId || !ext) {
        return {
          handled: true,
          reply: "I couldn't tell which extension to set Do Not Disturb on. Tell me the extension number and I'll take care of it.",
          yiddish: language === "yi" ? "איך האָב נישט געקענט וויסן וועלכע עקסטענשן איר מיינט. ביטע זאָגט מיר די עקסטענשן נומער." : undefined,
        };
      }
      params = { tenantId: pbxTenantId, objectId: String(ext), feature: "DND", enable: intent.enableHint ?? "yes" };
      actionTenantId = pbxTenantId;
    } else if (capId === "pbx.M1") {
      const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
      if (!pbxTenantId) {
        return {
          handled: true,
          reply: "Your account isn't linked to the phone system yet, so I can't change the hold music — I've flagged it for our team.",
          yiddish: language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined,
        };
      }
      if (intent.enableHint === "no") {
        params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "deactivate", reason: "chat request" };
        summary = "set the hold music back to the regular schedule";
      } else {
        // Resolve the requested profile by name from the tenant's OWN MOH
        // profiles (ownership re-checked by the scope fence + M1 snapshot +
        // api door). Most-specific (longest) name wins; ambiguous → ask.
        const profiles = await this.listMohProfiles(ctx.tenantId);
        const t = intent.raw.toLowerCase();
        const matches = profiles
          .filter((p) => p.name && t.includes(String(p.name).toLowerCase()))
          .sort((a, b) => String(b.name).length - String(a.name).length);
        const chosen = matches.length === 1 || (matches.length > 1 && String(matches[0].name).length > String(matches[1].name).length) ? matches[0] : null;
        if (!chosen) {
          const names = profiles.map((p) => p.name).filter(Boolean).join(", ");
          return {
            handled: true,
            reply: profiles.length
              ? `Which hold music would you like? Your available options are: ${names}. (You can also say "back to the regular schedule".)`
              : "I don't see any hold-music profiles set up for your account yet — I've let our team know.",
            yiddish: language === "yi" ? "וועלכע האלט מוזיק ווילט איר? זאָגט מיר דעם נאָמען." : undefined,
          };
        }
        params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: chosen.id, reason: "chat request" };
        summary = `switch the hold music to "${chosen.name}"`;
      }
      actionTenantId = pbxTenantId;
    } else {
      params = { extension: intent.extensionHint, target: intent.targetHint, until: intent.untilHint, raw: intent.raw };
    }
    const action = await this.actions.create({
      tenantId: actionTenantId,
      capabilityId: capId,
      params,
      summary,
      requestedBy: ctx.clientUserId ?? "unknown",
      requestedRole: ctx.role,
      conversationId: ctx.conversationId,
      autoApprove: ctx.role === "owner",
      revertAfterHours: intent.untilHint ? undefined : undefined,
      riskTier: intent.actionType === "ivr_switch" ? "medium" : "low",
    });

    const submitted = action.status === "EXECUTED";
    const failed = action.status === "FAILED" || action.status === "DENIED";
    return {
      handled: true,
      actionId: action.id,
      reply: submitted
        ? `Done — ${summary}.`
        : failed
          ? `Sorry — I tried to ${summary}, but it didn't go through. I've flagged it for our team to look at.`
          : `Got it: ${summary}. I've submitted this for approval — I'll confirm here the moment it's live.`,
      yiddish:
        language === "yi"
          ? submitted
            ? `געטאָן — ${summary}.`
            : failed
              ? `עס האָט זיך נישט אײַנגעגעבן — איך האָב עס איבערגעגעבן צו אונדזער טים.`
              : `איך האָב עס איבערגעגעבן פֿאַר אַפּרואוו. איך וועל אײַך לאָזן וויסן ווען עס איז גרייט.`
          : undefined,
    };
  }

  /** Map a Connect tenant id → its VitalPBX tenant number (what M-ops key on). */
  private async resolvePbxTenantId(connectTenantId: string): Promise<string | null> {
    try {
      const link = await this.prisma.tenantPbxLink.findUnique({ where: { tenantId: connectTenantId }, select: { pbxTenantId: true } });
      return link?.pbxTenantId != null ? String(link.pbxTenantId) : null;
    } catch {
      return null;
    }
  }

  /**
   * If the previous assistant message in this conversation was our MOH
   * clarifying question, interpret the user's reply as the answer: a profile
   * name (activate) or schedule words (deactivate). Conservative: anything
   * that doesn't clearly resolve returns null and falls through to the LLM.
   */
  private async resumeMohClarification(intent: Extract<Intent, { kind: "chat" }>, ctx: TriageCtx): Promise<Extract<Intent, { kind: "action" }> | null> {
    const text = (intent.raw ?? "").trim();
    if (!text || text.length > 80 || !ctx.conversationId) return null;
    try {
      const last = await this.prisma.agentMessage.findFirst({
        where: { conversationId: ctx.conversationId, role: "assistant" },
        orderBy: { createdAt: "desc" },
        select: { content: true, contentEn: true },
      });
      const lastText = String(last?.contentEn ?? last?.content ?? "");
      if (!/^Which hold music would you like\?|וועלכע האלט מוזיק ווילט איר/.test(lastText)) return null;
      const t = text.toLowerCase();
      if (/\b(schedule|normal|default|regular)\b/.test(t)) {
        return { kind: "action", actionType: "moh", enableHint: "no", raw: text };
      }
      const profiles = await this.listMohProfiles(ctx.tenantId);
      const matches = profiles
        .filter((p) => {
          const n = String(p.name ?? "").toLowerCase();
          return !!n && (n.includes(t) || t.includes(n));
        })
        .sort((a, b) => String(b.name).length - String(a.name).length);
      const chosen = matches.length === 1 || (matches.length > 1 && String(matches[0].name).length > String(matches[1].name).length) ? matches[0] : null;
      if (!chosen) return null;
      // raw = the full profile name so the pbx.M1 branch resolves it exactly.
      return { kind: "action", actionType: "moh", enableHint: "yes", raw: String(chosen.name) };
    } catch {
      return null;
    }
  }

  /** The tenant's own active MOH profiles (Connect mirror; empty on error). */
  private async listMohProfiles(connectTenantId: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const rows = await this.prisma.mohProfile.findMany({
        where: { tenantId: connectTenantId, isActive: true },
        select: { id: true, name: true },
      });
      return rows ?? [];
    } catch {
      return [];
    }
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
        return `${intent.enableHint === "no" ? "disable" : "enable"} Do Not Disturb on ${ext}${intent.untilHint ? ` until ${intent.untilHint}` : ""}`;
      case "moh":
        // Overridden in the pbx.M1 branch once the profile is resolved.
        return intent.enableHint === "no" ? "set the hold music back to the regular schedule" : "change the hold music";
      case "ivr_switch":
        return `switch the IVR${intent.untilHint ? ` until ${intent.untilHint}` : ""}`;
      case "vm_reset":
        return `reset the voicemail PIN on ${ext}`;
      default:
        return intent.raw;
    }
  }
}
