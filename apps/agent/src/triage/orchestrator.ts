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
import { MOH_DEACTIVATE_RE } from "./intent";
import { parseMohTiming, type MohTiming } from "./mohTiming";
import { evaluate, type TenantPolicy, type Role } from "../policy/policy";
import { capabilityById, executableCapabilities } from "../manifest/manifest";
import { standingFromRole, type Standing } from "../channels/identityContext";
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
  // Hold music has its own scope-aware flow (handleMoh): tenant-wide → pbx.M1,
  // single extension → pbx.M2. Both auto-execute per the 2026-07-26 mandate.
  moh: "pbx.M1",
  ivr_switch: "action.A3.ivr_switch",
  vm_reset: "action.A5.vm_pin_reset",
  unknown: null,
};

// ── MOH scope detection (owner mandate 2026-07-26 #3): tenant admins choose
// whole-company vs their extension; regular users are always extension-scoped.
const MOH_TENANT_SCOPE_RE =
  /\bwhole (?:company|tenant|office|account|organi[sz]ation|system)\b|\bentire (?:company|tenant|office|system)\b|\beveryone\b|\beverybody\b|\ball (?:extensions?|phones?|users?)\b|\bcompany[- ]?wide\b|\btenant[- ]?wide\b|\bfor the (?:whole )?company\b/i;
const MOH_EXT_SCOPE_RE =
  /\bmy extension\b|\bmy (?:own )?(?:phone|line|desk ?phone)\b|\bjust (?:for )?me\b|\bonly (?:for )?me\b|\b(?:just|only) mine\b|\bfor me only\b/i;
/** Extension number ONLY with an explicit ext/extension prefix — a bare number
 *  in a MOH sentence is usually a time ("in 15 minutes"), never guess. */
const MOH_EXT_NUM_RE = /\bext(?:ension)?\.?\s*(\d{2,5})\b/i;

// Clarifying questions this orchestrator asks (resume markers — exact prefixes).
const MOH_Q_PROFILE = "Which hold music would you like?";
const MOH_Q_SCOPE = "Should I change the hold music for the whole company, or just your extension";
const MOH_CLARIFY_MARKER_RE = /^Which hold music would you like\?|^Should I change the hold music for the whole company|וועלכע האלט מוזיק ווילט איר/;
/** Any hold-music assistant message — context for follow-ups like "change it back in 15 minutes". */
const MOH_CONTEXT_RE = /hold music|hold-music|האלט מוזיק/i;

// Scope ANSWERS (kept narrow so ordinary chat like "all good thanks" never matches).
const MOH_ANSWER_TENANT_RE = /\bwhole\b|\bcompany\b|\beveryone\b|\beverybody\b|\bentire\b|\btenant\b|\ball (?:extensions?|phones?|users?)\b/i;
const MOH_ANSWER_EXT_RE = /\bextension\b|\bjust me\b|\bonly me\b|\bjust mine\b|\bonly mine\b|\bmy (?:extension|phone|line)\b|\bmine\b/i;

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
    if (intent.actionType === "moh") return this.handleMoh(intent, ctx, language);

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
   * If the previous assistant message in this conversation was one of OUR MOH
   * clarifying questions (profile / scope), interpret the user's reply as the
   * answer and rebuild the FULL request by combining every user message in the
   * clarify thread (original ask + all answers) — so scope, timing, and profile
   * survive across multiple questions. Also resumes plain follow-ups to a
   * hold-music confirmation ("change it back in 15 minutes"). Conservative:
   * anything that doesn't clearly resolve returns null → falls to the LLM.
   */
  private async resumeMohClarification(intent: Extract<Intent, { kind: "chat" }>, ctx: TriageCtx): Promise<Extract<Intent, { kind: "action" }> | null> {
    let text = (intent.raw ?? "").trim();
    if (!text || text.length > 120 || !ctx.conversationId) return null;
    try {
      const thread = await this.collectMohClarifyThread(ctx);
      if (!thread) return null;
      const t = text.toLowerCase();
      const profiles = await this.listMohProfiles(ctx.tenantId);
      const isProfileAnswer = profiles.some((p) => {
        const n = String(p.name ?? "").toLowerCase();
        return !!n && (n.includes(t) || t.includes(n));
      });
      const isScopeAnswer = MOH_ANSWER_TENANT_RE.test(t) || MOH_ANSWER_EXT_RE.test(t) || /^\d{2,5}$/.test(t);
      const isDeactivateAnswer = MOH_DEACTIVATE_RE.test(t);
      if (thread.kind === "clarify") {
        if (!isProfileAnswer && !isScopeAnswer && !isDeactivateAnswer) return null;
      } else {
        // Context follow-up after a Done/confirmation: only clear revert/back
        // phrases or an explicit profile pick — never hijack small talk.
        if (!isDeactivateAnswer && !isProfileAnswer) return null;
        if (!isDeactivateAnswer && isProfileAnswer && !/\b(change|switch|set|make|play|use)\b/.test(t)) return null;
      }
      if (/^\d{2,5}$/.test(t)) text = `extension ${text}`; // bare number answer = extension number
      const combined = thread.priorUserText ? `${thread.priorUserText}. ${text}` : text;
      return {
        kind: "action",
        actionType: "moh",
        enableHint: MOH_DEACTIVATE_RE.test(combined.toLowerCase()) ? "no" : "yes",
        raw: combined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Inspect the tail of the conversation. Returns:
   *  - { kind: "clarify", priorUserText } when the last assistant message is one
   *    of our MOH clarifying questions — priorUserText is every user message in
   *    the clarify chain (oldest first), so nothing said earlier is lost;
   *  - { kind: "context", priorUserText: "" } when the last assistant message is
   *    any other hold-music message (Done/confirmation) — enough context for
   *    follow-ups like "change it back in 15 minutes";
   *  - null otherwise.
   */
  private async collectMohClarifyThread(ctx: TriageCtx): Promise<{ kind: "clarify" | "context"; priorUserText: string } | null> {
    const msgs: Array<{ role: string; content: string | null; contentEn: string | null }> = await this.prisma.agentMessage.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { role: true, content: true, contentEn: true },
    });
    let i = 0;
    while (i < msgs.length && msgs[i].role !== "assistant") i++; // skip the just-stored user reply
    if (i >= msgs.length) return null;
    const textOf = (m: { content: string | null; contentEn: string | null }) => String(m.contentEn ?? m.content ?? "");
    if (!MOH_CLARIFY_MARKER_RE.test(textOf(msgs[i]))) {
      return MOH_CONTEXT_RE.test(textOf(msgs[i])) ? { kind: "context", priorUserText: "" } : null;
    }
    const parts: string[] = [];
    let pairs = 0;
    while (i < msgs.length && pairs < 3 && msgs[i].role === "assistant" && MOH_CLARIFY_MARKER_RE.test(textOf(msgs[i]))) {
      i++; // past the clarify question
      const users: string[] = [];
      while (i < msgs.length && msgs[i].role !== "assistant") {
        users.push(textOf(msgs[i]));
        i++;
      }
      parts.unshift(...users.reverse());
      pairs++;
    }
    return { kind: "clarify", priorUserText: parts.filter(Boolean).join(". ") };
  }

  /** Portal-user standing: platform_owner / tenant_admin / tenant_user (fail-closed to tenant_user). */
  private async resolveStanding(ctx: TriageCtx): Promise<Standing> {
    if (ctx.role === "owner") return "platform_owner";
    if (!ctx.clientUserId) return "tenant_user";
    try {
      const u = await this.prisma.user.findUnique({ where: { id: ctx.clientUserId }, select: { role: true } });
      return u ? standingFromRole(String(u.role ?? "")) : "tenant_user";
    } catch {
      return "tenant_user";
    }
  }

  /** Tenant schedule timezone (drives "5pm" → UTC); defaults to America/New_York. */
  private async resolveMohTimezone(connectTenantId: string): Promise<string> {
    try {
      const cfg = await this.prisma.mohScheduleConfig.findUnique({ where: { tenantId: connectTenantId }, select: { timezone: true } });
      return cfg?.timezone || "America/New_York";
    } catch {
      return "America/New_York";
    }
  }

  private async currentMohOverride(connectTenantId: string): Promise<{ isActive: boolean; profileId: string | null } | null> {
    try {
      const o = await this.prisma.mohOverrideState.findUnique({ where: { tenantId: connectTenantId }, select: { isActive: true, profileId: true } });
      return o ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Hold-music flow (owner mandate 2026-07-26 #3). Scope-aware and time-aware:
   *   - tenant admins choose whole-company (pbx.M1) vs one extension (pbx.M2);
   *     asked explicitly when the request doesn't say.
   *   - regular users are ALWAYS scoped to their own extension.
   *   - "for 15 minutes" / "until 5pm"  → M1 expiresMinutes (worker reverts) or
   *     M2 + revertAt (action scheduler reverts).
   *   - "tomorrow 3pm to 5pm" / "every friday 3-5" → M1 schedule (worker plays
   *     the window and reverts after it — survives restarts).
   */
  private async handleMoh(intent: Extract<Intent, { kind: "action" }>, ctx: TriageCtx, language: "en" | "yi"): Promise<TriageOutcome> {
    const yiTeam = language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined;
    const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
    if (!pbxTenantId) {
      return {
        handled: true,
        reply: "Your account isn't linked to the phone system yet, so I can't change the hold music — I've flagged it for our team.",
        yiddish: yiTeam,
      };
    }
    const raw = intent.raw;
    const t = raw.toLowerCase();
    const standing = await this.resolveStanding(ctx);
    const isAdmin = standing !== "tenant_user";
    const ownExt = await this.resolveExtension(ctx);
    const tz = await this.resolveMohTimezone(ctx.tenantId);
    const timing: MohTiming = parseMohTiming(raw, tz);

    // ── scope ──
    let scope: "tenant" | "extension" | null = null;
    let targetExt: string | null = null;
    const extNum = raw.match(MOH_EXT_NUM_RE)?.[1] ?? null;
    if (MOH_TENANT_SCOPE_RE.test(t)) scope = "tenant";
    else if (extNum) {
      scope = "extension";
      targetExt = extNum;
    } else if (MOH_EXT_SCOPE_RE.test(t) || MOH_ANSWER_EXT_RE.test(t)) {
      scope = "extension";
      targetExt = ownExt;
    }

    if (!isAdmin) {
      // Regular users: own extension only — never tenant-wide, never another ext.
      if (scope === "tenant") {
        return {
          handled: true,
          reply: `Changing the hold music for the whole company needs your account admin. I CAN change it for your own extension${ownExt ? ` (${ownExt})` : ""} — just say "change my extension's hold music to …".`,
          yiddish: yiTeam,
        };
      }
      if (scope === "extension" && targetExt && ownExt && targetExt !== ownExt) {
        return {
          handled: true,
          reply: `I can only change the hold music for your own extension (${ownExt}) — changes to extension ${targetExt} need your account admin.`,
          yiddish: yiTeam,
        };
      }
      scope = "extension";
      targetExt = ownExt;
      if (!targetExt) {
        return {
          handled: true,
          reply: "I don't see an extension assigned to you, so I can't change your hold music — I've flagged it for our team.",
          yiddish: yiTeam,
        };
      }
    } else if (!scope) {
      if (!ownExt) {
        scope = "tenant"; // admin with no personal extension: only tenant scope makes sense
      } else {
        return {
          handled: true,
          reply: `${MOH_Q_SCOPE} (${ownExt})?`,
          yiddish: language === "yi" ? `זאָל איך טוישן די האלט מוזיק פֿאַר די גאנצע פירמע, אָדער נאָר פֿאַר אײַער עקסטענשן (${ownExt})?` : undefined,
        };
      }
    } else if (scope === "extension" && !targetExt) {
      targetExt = ownExt;
      if (!targetExt) {
        return {
          handled: true,
          reply: `I couldn't find an extension assigned to you — tell me the extension number (e.g. "extension 102") and I'll set its hold music.`,
          yiddish: language === "yi" ? "זאָגט מיר ביטע די עקסטענשן נומער." : undefined,
        };
      }
    }

    // Calendar windows are tenant-wide rules — no per-extension scheduling (yet).
    if (scope === "extension" && (timing.kind === "window" || timing.kind === "weekly")) {
      return {
        handled: true,
        reply: `I can't put a calendar schedule on a single extension yet — I can switch extension ${targetExt}'s hold music now (say "for 30 minutes" to make it temporary)${isAdmin ? `, or schedule it company-wide ("whole company ${timing.label}")` : ""}.`,
        yiddish: yiTeam,
      };
    }

    // ── capability + policy ──
    const capId = scope === "extension" ? "pbx.M2" : "pbx.M1";
    const cap = capabilityById(capId);
    if (!cap) return { handled: false };
    const policy = await this.loadPolicy(ctx.tenantId);
    const decision = evaluate(cap, { role: ctx.role, tenantId: ctx.tenantId, targetTenantId: ctx.tenantId }, policy, {
      targetExtension: targetExt ?? undefined,
    });
    if (!decision.ok) {
      return { handled: true, reply: decision.message, yiddish: yiTeam };
    }

    const deactivate = intent.enableHint === "no";
    const minutesFromTiming =
      timing.kind === "duration"
        ? timing.minutes
        : timing.kind === "until"
          ? Math.max(1, Math.ceil((timing.endAt.getTime() - Date.now()) / 60_000))
          : null;
    const timingPhrase = timing.kind === "duration" ? `for ${timing.label}` : timing.kind === "until" ? timing.label : "";

    let params: Record<string, unknown>;
    let summary: string;
    let revertAfterMinutes: number | undefined;
    let noteSuffix = "";

    if (deactivate) {
      if (scope === "tenant") {
        if (minutesFromTiming != null) {
          // "change it back in 15 minutes" = keep what's playing, expire it then.
          const o = await this.currentMohOverride(ctx.tenantId);
          if (!o?.isActive || !o.profileId) {
            return { handled: true, reply: "The hold music is already on the regular schedule — nothing to change back." };
          }
          params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: o.profileId, reason: "chat request (timed revert)", expiresMinutes: minutesFromTiming };
          summary = `set the hold music back to the regular schedule ${timing.kind === "duration" ? `in ${timing.label}` : timing.kind === "until" ? timing.label : ""}`.trimEnd();
        } else {
          params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "deactivate", reason: "chat request" };
          summary = "set the hold music back to the regular schedule";
        }
      } else {
        params = { tenantId: pbxTenantId, objectId: String(targetExt), action: "clear", reason: "chat request" };
        summary = `set extension ${targetExt}'s hold music back to the company default`;
        if (minutesFromTiming != null) noteSuffix = " (I cleared it right away — delayed clears aren't supported per-extension yet.)";
      }
    } else {
      // Activate — resolve the profile from the tenant's OWN active profiles
      // (ownership re-checked by scope fence + op snapshot + api door).
      const profiles = await this.listMohProfiles(ctx.tenantId);
      const matches = profiles
        .filter((p) => p.name && t.includes(String(p.name).toLowerCase()))
        .sort((a, b) => String(b.name).length - String(a.name).length);
      const chosen = matches.length === 1 || (matches.length > 1 && String(matches[0].name).length > String(matches[1].name).length) ? matches[0] : null;
      if (!chosen) {
        const names = profiles.map((p) => p.name).filter(Boolean).join(", ");
        return {
          handled: true,
          reply: profiles.length
            ? `${MOH_Q_PROFILE} Your available options are: ${names}. (You can also say "back to the regular schedule".)`
            : "I don't see any hold-music profiles set up for your account yet — I've let our team know.",
          yiddish: language === "yi" ? "וועלכע האלט מוזיק ווילט איר? זאָגט מיר דעם נאָמען." : undefined,
        };
      }

      if (scope === "tenant") {
        if (timing.kind === "window") {
          params = {
            tenantId: pbxTenantId, objectId: pbxTenantId, action: "schedule", profileId: chosen.id,
            startAt: timing.startAt.toISOString(), endAt: timing.endAt.toISOString(), reason: "chat request",
          };
          summary = `schedule "${chosen.name}" hold music ${timing.label}`;
        } else if (timing.kind === "weekly") {
          params = {
            tenantId: pbxTenantId, objectId: pbxTenantId, action: "schedule", profileId: chosen.id,
            weekday: timing.weekday, startTime: timing.startTime, endTime: timing.endTime, reason: "chat request",
          };
          summary = `play "${chosen.name}" hold music ${timing.label}`;
        } else if (minutesFromTiming != null) {
          params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: chosen.id, reason: "chat request", expiresMinutes: minutesFromTiming };
          summary = `switch the hold music to "${chosen.name}" ${timingPhrase}, then back to the regular schedule`;
        } else {
          params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: chosen.id, reason: "chat request" };
          summary = `switch the hold music to "${chosen.name}"`;
        }
        if (timing.kind === "window" || timing.kind === "weekly") {
          const o = await this.currentMohOverride(ctx.tenantId);
          if (o?.isActive) {
            noteSuffix = ' Heads-up: a manual hold-music override is active right now, and it outranks the schedule — say "set the hold music back to the regular schedule" so the scheduled music can play.';
          }
        }
      } else {
        params = { tenantId: pbxTenantId, objectId: String(targetExt), action: "set", profileId: chosen.id, reason: "chat request" };
        if (minutesFromTiming != null) {
          revertAfterMinutes = minutesFromTiming;
          summary = `switch extension ${targetExt}'s hold music to "${chosen.name}" ${timingPhrase}, then back automatically`;
        } else {
          summary = `switch extension ${targetExt}'s hold music to "${chosen.name}"`;
        }
      }
    }

    // M-series binding contract: the action row is keyed by the VITAL tenant id.
    const action = await this.actions.create({
      tenantId: pbxTenantId,
      capabilityId: capId,
      params,
      summary,
      requestedBy: ctx.clientUserId ?? "unknown",
      requestedRole: ctx.role,
      conversationId: ctx.conversationId,
      autoApprove: ctx.role === "owner",
      revertAfterMinutes,
      riskTier: "low",
    });

    const submitted = action.status === "EXECUTED";
    const failed = action.status === "FAILED" || action.status === "DENIED";
    return {
      handled: true,
      actionId: action.id,
      reply: submitted
        ? `Done — ${summary}.${noteSuffix}`
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
