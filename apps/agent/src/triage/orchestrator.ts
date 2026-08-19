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
import { MOH_DEACTIVATE_RE, MOH_STATUS_Q_RE } from "./intent";
import { parseMohTiming, type MohTiming } from "./mohTiming";
import { extractMohRequest, type ExtractorLlm, type MohLlmResult } from "./mohLlmExtract";
import { extractPbxCfgRequest, type PbxCatalog, type PbxCfgOperation } from "./pbxCfgLlmExtract";
import { evaluate, type TenantPolicy, type Role } from "../policy/policy";
import { capabilityById, executableCapabilities } from "../manifest/manifest";
import { standingFromRole, type Standing } from "../channels/identityContext";
import type { DiagnosticsEngine } from "../diag/engine";
import type { ActionService } from "../actions/service";
import type { MohUploadApiClient } from "../pbx/mohUploadApiClient";

export interface TriageCtx {
  tenantId: string;
  clientUserId: string | null;
  role: Role;
  conversationId?: string;
}

/** Audio file uploaded through the chat widget (already on the agent's disk). */
export interface UploadedAudioFile {
  path: string;
  filename: string;
  sizeBytes: number;
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
  // Routing/IVR/queue config has its own catalog-grounded flow (handlePbxConfig):
  // M3 retarget_v2, M4 native IVR, M10 native queue. Never reaches this map.
  pbx_config: null,
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
// NOT anchored: the status answer ("Right now … Which hold music would you
// like?") re-asks the profile question mid-message and must stay resumable.
const MOH_CLARIFY_MARKER_RE = /Which hold music would you like\?|Should I change the hold music for the whole company|וועלכע האלט מוזיק ווילט איר/;
// Upload-offer message ("I've saved your music as hold-music profile "X" …") —
// the reply ("yes" / "whole company" / "not now") resumes via resumeUploadOffer.
const MOH_UPLOAD_OFFER_RE = /saved your music as (?:the )?hold-music profile "([^"]{1,80})"/;
const MOH_UPLOAD_DECLINE_RE = /\b(not now|no thanks?|nah|later|leave it|don'?t|nothing now|maybe later)\b/i;
const MOH_UPLOAD_ACCEPT_RE = /\b(yes|yeah|yep|sure|ok(?:ay)?|please|go ahead|do it|set it)\b/i;
/** Any hold-music assistant message — context for follow-ups like "change it back in 15 minutes". */
const MOH_CONTEXT_RE = /hold music|hold-music|האלט מוזיק/i;

/**
 * ⛔ A NEW QUESTION IS NOT AN ANSWER — the guard that ends the clarify trap.
 *
 * While "Which hold music would you like?" is the last assistant message, the
 * resume below treats anything scope-shaped as the answer, and the scope test
 * matches the bare words "extension" and "company". So an unrelated question
 * that merely contains one of them ("Can you tell me where calls to my
 * EXTENSION go when I don't answer?") was swallowed as a hold-music scope
 * reply — and because the reply to it is the SAME clarify question, the state
 * re-armed itself every turn. Self-sustaining: once entered, every later
 * message containing those words was eaten too.
 *
 * Measured live 2026-08-18 (Ezra's trainer session): EIGHT consecutive
 * unrelated questions — call forwarding, no-answer routing, restoring a setup,
 * routing to a non-existent extension — each answered with the hold-music
 * question, across a conversation boundary.
 *
 * The rule: a message that OPENS like a fresh request and never mentions hold
 * music is a fresh request. Real answers ("Main", "the whole company", "just
 * mine", "back to the regular schedule") do not open with an interrogative,
 * and a genuine hold-music question still resumes because it names the thing.
 */
const MOH_NEW_REQUEST_RE =
  /^\s*(?:can|could|would|will|should|do|does|did|is|are|was|were|what|where|when|why|how|which|who|tell me|show me|explain|please tell)\b/i;

/** How many times we may ask the same clarifying question before giving up and
 *  letting the ordinary path answer. Belt to the braces above: no clarify state
 *  in this orchestrator may survive indefinitely. */
const MOH_MAX_CONSECUTIVE_CLARIFIES = 3;

/**
 * Another part of the phone system, named outright. The MOH status question is
 * deliberately anaphoric — "which one am I on right now?" names nothing, which
 * is exactly why it has to be recognised from context. The cost is that
 * `MOH_STATUS_Q_RE` also matches "what … currently …" about ANY subject, so
 * mid-clarification "What teams or ring groups are currently configured?" was
 * answered with the hold-music status (2026-08-18, live). A question that names
 * a different subject is about that subject.
 *
 * ⛔ "extension" and "schedule" are deliberately NOT here: an extension is the
 * scope of a hold-music setting, and "the regular schedule" is hold-music's own
 * wording for its default state.
 */
const MOH_OTHER_SUBJECT_RE =
  /\b(?:teams?|ring ?groups?|ivr|menus?|voicemails?|forward(?:ing)?|holidays?|business hours|contacts?|greetings?|recordings?|do not disturb|dnd|caller ?id)\b/i;

// Scope ANSWERS (kept narrow so ordinary chat like "all good thanks" never matches).
const MOH_ANSWER_TENANT_RE = /\bwhole\b|\bcompany\b|\beveryone\b|\beverybody\b|\bentire\b|\btenant\b|\ball (?:extensions?|phones?|users?)\b/i;
const MOH_ANSWER_EXT_RE = /\bextension\b|\bjust me\b|\bonly me\b|\bjust mine\b|\bonly mine\b|\bmy (?:extension|phone|line)\b|\bmine\b/i;

// PBX-config clarifying questions (M3/M4/M10) — exact phrasings handlePbxConfig
// emits, so a bare reply ("the sales queue", "extension 102") resumes the flow.
const PBXCFG_CLARIFY_MARKER_RE =
  /Which phone number\?|Which queue\?|Which IVR menu\?|Which menu option|Where should (?:calls|option)|Which extension should I|Which recording should|Which hold music should queue|I couldn't find (?:an IVR menu|a queue|a recording|hold music called)|in your phone system/;

/** Any minimal API-door client (route/ivr/queue) the orchestrator can call. */
export interface PbxDoorClient {
  call(body: Record<string, unknown>): Promise<any>;
}

export class TriageOrchestrator {
  constructor(
    private prisma: any,
    private diag: DiagnosticsEngine,
    private actions: ActionService,
    private loadPolicy: (tenantId: string) => Promise<TenantPolicy | null>,
    /** LLM-first request understanding (owner directive 2026-07-27). Null ⇒ regex-only. */
    private llm: ExtractorLlm | null = null,
    /** MOH upload door (chat MP3 → hold-music profile). Null ⇒ uploads escalate. */
    private mohUpload: MohUploadApiClient | null = null,
    /** M3/M4/M10 doors (owner directive 2026-07-28). Null ⇒ pbx-config requests escalate. */
    private routeApi: PbxDoorClient | null = null,
    private ivrApi: PbxDoorClient | null = null,
    private queueApi: PbxDoorClient | null = null,
    /** M11 extension-feature door — used READ-ONLY here (`action:"get"`) to
     *  answer "is DND on?" without writing. Null ⇒ we say we couldn't check. */
    private extFeatureApi: PbxDoorClient | null = null,
  ) {}

  async handle(intent: Intent | ({ kind: "audio_upload" } & Record<string, unknown>), ctx: TriageCtx, language: "en" | "yi"): Promise<TriageOutcome> {
    if (intent.kind === "audio_upload") {
      return this.handleAudioUpload(
        { raw: String((intent as any).raw ?? ""), files: ((intent as any).files ?? []) as UploadedAudioFile[] },
        ctx,
        language,
      );
    }

    if (intent.kind === "chat") {
      // The reply may answer our own upload offer ("Should I set it now —
      // whole company or your extension?") — resolve that first because the
      // offer message embeds the exact profile name to act on.
      const uploadResume = await this.resumeUploadOffer(intent, ctx, language);
      if (uploadResume) {
        if ("outcome" in uploadResume) return uploadResume.outcome;
        intent = uploadResume.intent;
      } else {
        // A plain-chat message may be the ANSWER to our own pending clarifying
        // question (e.g. we asked "Which hold music would you like?" and the
        // user replied just "Main"). Resume that flow instead of dropping the
        // reply into the LLM (2026-07-26 live failure: the LLM answered "I'll
        // pass the request to the team" and nothing executed).
        const resumed = await this.resumeMohClarification(intent, ctx);
        if (!resumed) {
          const cfgResumed = await this.resumePbxCfgClarification(intent, ctx);
          if (!cfgResumed) return { handled: false };
          intent = cfgResumed;
        } else {
          intent = resumed;
        }
      }
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

    // "DND status?" is a QUESTION. Answering it by switching DND on is the
    // single most-repeated defect in the trainer logs (2026-07-26 → 08-07).
    // Read-only, and it never files an action.
    if (intent.actionType === "dnd" && intent.statusQuery) {
      return this.answerDndStatus(intent, ctx, language);
    }

    // M3/M4/M10 — inbound routing, IVR menus, queue config (owner directive
    // 2026-07-28). Legacy ivr_switch phrasings ("holiday menu") get first crack
    // at the real IVR flow; when it declines they fall through to the old path.
    if (intent.actionType === "pbx_config" || intent.actionType === "ivr_switch") {
      const cfgOutcome = await this.handlePbxConfig(intent, ctx, language);
      if (cfgOutcome.handled || intent.actionType === "pbx_config") return cfgOutcome;
    }

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

  /**
   * Read-only answer to "is Do Not Disturb on?".
   *
   * Uses the SAME door the M11 executor uses for its before-snapshot
   * (`action: "get"`), so what we report is the live AstDB diversion state, not
   * an inference from the last action row. When the door isn't wired or the
   * read fails we say we couldn't check — we never fall back to guessing, and
   * we never "check" by writing.
   */
  private async answerDndStatus(
    intent: Extract<Intent, { kind: "action" }>,
    ctx: TriageCtx,
    language: "en" | "yi",
  ): Promise<TriageOutcome> {
    const ext = intent.extensionHint ?? (await this.resolveExtension(ctx));
    const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
    const where = ext ? `extension ${ext}` : "your extension";

    if (!this.extFeatureApi || !pbxTenantId || !ext) {
      return {
        handled: true,
        reply: `I couldn't read the live Do Not Disturb setting for ${where} just now. I haven't changed anything — tell me if you'd like it turned on or off.`,
        yiddish:
          language === "yi"
            ? `איך האָב נישט געקענט איבערלייענען דעם "נישט שטערן" סטאַטוס. איך האָב גאָרנישט געביטן.`
            : undefined,
      };
    }

    try {
      const resp = await this.extFeatureApi.call({
        tenantId: String(pbxTenantId),
        action: "get",
        extension: String(ext),
        feature: "DND",
        agentActionId: "status-read",
      });
      const on = String(resp?.state?.enable ?? "no") === "yes";
      return {
        handled: true,
        reply: on
          ? `Do Not Disturb is currently ON for ${where} — calls go straight to voicemail. Say "turn off DND" and I'll clear it.`
          : `Do Not Disturb is currently OFF for ${where} — calls ring normally.`,
        yiddish:
          language === "yi"
            ? on
              ? `"נישט שטערן" איז יעצט אָנגעצונדן אויף ${where}.`
              : `"נישט שטערן" איז יעצט אויסגעשאלטן אויף ${where}.`
            : undefined,
      };
    } catch {
      return {
        handled: true,
        reply: `I couldn't reach the phone system to read Do Not Disturb for ${where} just now. I haven't changed anything — try again in a moment.`,
        yiddish:
          language === "yi"
            ? `איך האָב נישט געקענט דערגרייכן דעם סיסטעם. איך האָב גאָרנישט געביטן.`
            : undefined,
      };
    }
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
    // 300 not 120: frustrated rephrasings run long ('I asked you to change it
    // to "Main" for twenty minutes—not "Default" …', 170 chars, live
    // 2026-07-27 — the old guard dropped it to the LLM, which then invented a
    // confirmation). The profile/verb checks below still gate what resumes.
    if (!text || text.length > 300 || !ctx.conversationId) return null;
    try {
      const thread = await this.collectMohClarifyThread(ctx);
      if (!thread) return null;
      const t = text.toLowerCase();
      // "Which one am I on right now?" mid-clarification is a STATUS question,
      // not an answer — route it to the read-only status reply (2026-07-26 live
      // failure: it fell to the LLM, which claimed it cannot check hold music).
      // Tested against the CURRENT reply only, never the combined thread text.
      // ⛔ …but only when it is about hold music. The pattern is anaphoric by
      // design ("which one am I on?"), so it also matches a question about a
      // completely different subject — see MOH_OTHER_SUBJECT_RE.
      if (MOH_STATUS_Q_RE.test(t) && (!MOH_OTHER_SUBJECT_RE.test(t) || MOH_CONTEXT_RE.test(t))) {
        return { kind: "action", actionType: "moh", enableHint: "yes", statusQuery: true, raw: text };
      }
      const profiles = await this.listMohProfiles(ctx.tenantId);
      const isProfileAnswer = profiles.some((p) => {
        const n = String(p.name ?? "").toLowerCase();
        return !!n && (n.includes(t) || t.includes(n));
      });
      const isScopeAnswer = MOH_ANSWER_TENANT_RE.test(t) || MOH_ANSWER_EXT_RE.test(t) || /^\d{2,5}$/.test(t);
      const isDeactivateAnswer = MOH_DEACTIVATE_RE.test(t);
      if (thread.kind === "clarify") {
        if (!isProfileAnswer && !isScopeAnswer && !isDeactivateAnswer) return null;
        // A fresh question that never mentions hold music is a NEW request,
        // however scope-shaped its wording. Without this, "Can you remove the
        // forwarding and restore my original setup?" resumes as a hold-music
        // answer (it contains "remove", so it reads as "turn it off").
        if (MOH_NEW_REQUEST_RE.test(text) && !MOH_CONTEXT_RE.test(t) && !isProfileAnswer) return null;
        // And if we have already asked this same question three times running,
        // stop asking: the user is plainly not answering it.
        if (thread.consecutiveAsks >= MOH_MAX_CONSECUTIVE_CLARIFIES) return null;
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
  private async collectMohClarifyThread(ctx: TriageCtx): Promise<{ kind: "clarify" | "context"; priorUserText: string; consecutiveAsks: number } | null> {
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
      return MOH_CONTEXT_RE.test(textOf(msgs[i])) ? { kind: "context", priorUserText: "", consecutiveAsks: 0 } : null;
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
    return { kind: "clarify", priorUserText: parts.filter(Boolean).join(". "), consecutiveAsks: pairs };
  }

  /**
   * The user replied to our upload offer ("I've saved your music as hold-music
   * profile "X". Should I set it now …"). The offer message itself carries the
   * exact profile name, so the reply resolves without any guessing:
   *   - decline ("not now") → friendly ack, profile stays saved;
   *   - scope/accept ("whole company", "just mine", "yes") → synthesize the
   *     normal MOH set request and run it through handleMoh's full gate chain.
   * Anything else returns null and falls through to the regular resume/LLM.
   */
  private async resumeUploadOffer(
    intent: Extract<Intent, { kind: "chat" }>,
    ctx: TriageCtx,
    language: "en" | "yi",
  ): Promise<{ outcome: TriageOutcome } | { intent: Extract<Intent, { kind: "action" }> } | null> {
    const text = (intent.raw ?? "").trim();
    if (!text || text.length > 300 || !ctx.conversationId) return null;
    try {
      const msgs: Array<{ role: string; content: string | null; contentEn: string | null }> = await this.prisma.agentMessage.findMany({
        where: { conversationId: ctx.conversationId },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { role: true, content: true, contentEn: true },
      });
      let i = 0;
      while (i < msgs.length && msgs[i].role !== "assistant") i++; // skip the just-stored user reply
      if (i >= msgs.length) return null;
      const lastAssistant = String(msgs[i].contentEn ?? msgs[i].content ?? "");
      const m = lastAssistant.match(MOH_UPLOAD_OFFER_RE);
      if (!m) return null;
      const profileName = m[1];
      const t = text.toLowerCase();

      if (MOH_UPLOAD_DECLINE_RE.test(t) && !MOH_ANSWER_TENANT_RE.test(t) && !MOH_ANSWER_EXT_RE.test(t)) {
        return {
          outcome: {
            handled: true,
            reply: `No problem — "${profileName}" is saved with your hold-music options. Whenever you want it, just say: set the hold music to "${profileName}".`,
            yiddish: language === "yi" ? `גוט — "${profileName}" איז אָפּגעהיטן. ווען איר ווילט עס, זאָגט: טוישט די האלט מוזיק צו "${profileName}".` : undefined,
          },
        };
      }

      const isScope = MOH_ANSWER_TENANT_RE.test(t) || MOH_ANSWER_EXT_RE.test(t) || /^\d{2,5}$/.test(t);
      const isAccept = MOH_UPLOAD_ACCEPT_RE.test(t);
      if (!isScope && !isAccept) return null;
      const scopePart = /^\d{2,5}$/.test(t) ? `extension ${t}` : text;
      return {
        intent: {
          kind: "action",
          actionType: "moh",
          enableHint: "yes",
          raw: `change the hold music to "${profileName}". ${scopePart}`,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Chat-widget audio upload → hold-music profile (owner request 2026-07-27).
   * Stores the file(s) through the api's MOH pipeline (transcode + PBX sync
   * manifest), auto-creates the profile, then either offers to set it (reply
   * resumes via resumeUploadOffer) or — when the message already says what to
   * do ("use this as our hold music for the whole company") — chains straight
   * into handleMoh's fully gated set flow.
   */
  private async handleAudioUpload(
    input: { raw: string; files: UploadedAudioFile[] },
    ctx: TriageCtx,
    language: "en" | "yi",
  ): Promise<TriageOutcome> {
    const yiTeam = language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined;
    if (input.files.length === 0) return { handled: false };

    // Disambiguation (owner directive 2026-07-28): audio that's clearly an IVR
    // greeting / announcement / system recording goes to the native recording
    // pipeline (M4), NOT hold music. Ambiguous audio stays MOH (the original
    // upload feature) — we never guess a config write from silence.
    const mentionsRecordingUse = /\b(greeting|announcement|ivr|auto.?attendant|menu|recording)\b/i.test(input.raw);
    const mentionsMoh = /\bhold[- ]?music\b|\bmusic on hold\b|\bwaiting music\b/i.test(input.raw);
    if (mentionsRecordingUse && !mentionsMoh && this.ivrApi) {
      return this.handleRecordingUpload(input, ctx, language);
    }

    if (!this.mohUpload) {
      return {
        handled: true,
        reply: "I received your audio file, but music uploads aren't switched on for this account yet — I've passed it to our team.",
        yiddish: yiTeam,
      };
    }
    const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
    if (!pbxTenantId) {
      return {
        handled: true,
        reply: "Your account isn't linked to the phone system yet, so I can't set up hold music from this file — I've flagged it for our team.",
        yiddish: yiTeam,
      };
    }

    // Name: an explicit `named/called "X"` in the message wins; otherwise the
    // first filename, cleaned up. The api door uniquifies on collision.
    const named = input.raw.match(/\b(?:name(?:d)?|call(?:ed)?|title(?:d)?)\s+(?:it\s+)?["'“”]?([^"'“”\n,.]{2,60})["'“”]?/i)?.[1]?.trim();
    const fromFile = String(input.files[0].filename || "")
      .replace(/\.[a-z0-9]{1,5}$/i, "")
      .replace(/[_\-.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const name = (named || fromFile || "Uploaded music").slice(0, 60);

    let uploaded: { profile: { id: string; name: string }; tracks: number };
    try {
      uploaded = await this.mohUpload.upload({
        tenantId: ctx.tenantId,
        name,
        requestedBy: `agent:${ctx.conversationId ?? "chat"}`,
        files: input.files.map((f) => ({ path: f.path, filename: f.filename })),
      });
    } catch (err) {
      return {
        handled: true,
        reply: `Sorry — I couldn't process ${input.files.length > 1 ? "those audio files" : "that audio file"} into hold music (the file may be corrupted or in a format I can't convert). Please try a standard MP3 or WAV, or I can pass it to our team.`,
        yiddish: yiTeam,
      };
    }

    const savedLine = `I've saved your music as hold-music profile "${uploaded.profile.name}"${
      uploaded.tracks > 1 ? ` — a playlist of ${uploaded.tracks} tracks playing in order` : ""
    }.`;

    // Message already says to set it? Chain into the normal, fully gated flow.
    if (/\b(set|use|make|play|put|switch|change|activate)\b/i.test(input.raw)) {
      const chained = await this.handleMoh(
        { kind: "action", actionType: "moh", enableHint: "yes", raw: `change the hold music to "${uploaded.profile.name}". ${input.raw}` },
        ctx,
        language,
      );
      if (chained.handled && chained.reply) {
        return { ...chained, reply: `${savedLine} ${chained.reply}` };
      }
    }

    const standing = await this.resolveStanding(ctx);
    const isAdmin = standing !== "tenant_user";
    const ownExt = await this.resolveExtension(ctx);
    const ask = isAdmin
      ? ownExt
        ? `Should I set it now — for the whole company, or just your extension (${ownExt})? You can also say "not now".`
        : `Should I set it as the company hold music now? You can also say "not now".`
      : ownExt
        ? `Want me to set it as your extension (${ownExt})'s hold music now? You can also say "not now".`
        : `It's ready in your hold-music options — your account admin can set it live.`;
    return { handled: true, reply: `${savedLine} ${ask}` };
  }

  /**
   * Chat audio upload that is an IVR greeting / announcement (not hold music):
   * transcode + store it as a native VitalPBX recording via the api door, then
   * — when the message already says where it goes ("use this as the greeting
   * on the main menu") — chain straight into the fully gated M4 flow.
   */
  private async handleRecordingUpload(
    input: { raw: string; files: UploadedAudioFile[] },
    ctx: TriageCtx,
    language: "en" | "yi",
  ): Promise<TriageOutcome> {
    const yiTeam = language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined;
    const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
    if (!pbxTenantId || !this.ivrApi) {
      return {
        handled: true,
        reply: "Your account isn't linked to the phone system yet, so I can't store this recording — I've flagged it for our team.",
        yiddish: yiTeam,
      };
    }
    // Recordings are tenant-level config — same fence as the other config writes.
    const standing = await this.resolveStanding(ctx);
    if (standing === "tenant_user") {
      return {
        handled: true,
        reply: "Uploading phone-system recordings (greetings/announcements) needs a company admin. I can pass this to them for you.",
        yiddish: yiTeam,
      };
    }

    const named = input.raw.match(/\b(?:name(?:d)?|call(?:ed)?|title(?:d)?)\s+(?:it\s+)?["'“”]?([^"'“”\n,.]{2,60})["'“”]?/i)?.[1]?.trim();
    const fs = await import("node:fs/promises");
    const uploaded: Array<{ id: string; name: string }> = [];
    for (const f of input.files) {
      if (f.sizeBytes > 24 * 1024 * 1024) {
        return {
          handled: true,
          reply: `"${f.filename}" is too large for a phone-system recording (max 24 MB). Greetings and announcements are usually well under a minute — could you send a smaller file?`,
          yiddish: yiTeam,
        };
      }
      const fromFile = String(f.filename || "")
        .replace(/\.[a-z0-9]{1,5}$/i, "")
        .replace(/[_\-.]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const name = ((input.files.length === 1 && named) || fromFile || "Chat recording").slice(0, 60);
      try {
        const audioBase64 = (await fs.readFile(f.path)).toString("base64");
        const resp = await this.ivrApi.call({
          action: "native_upload_recording",
          tenantId: pbxTenantId,
          recordingName: name,
          audioFilename: f.filename,
          audioBase64,
          agentActionId: `chat-upload:${ctx.conversationId ?? "chat"}`,
        });
        uploaded.push({ id: String(resp.recording?.id ?? ""), name: String(resp.recording?.name ?? name) });
      } catch {
        return {
          handled: true,
          reply: `Sorry — I couldn't convert "${f.filename}" into a phone-system recording (the file may be corrupted or in a format I can't process). Please try a standard MP3 or WAV.`,
          yiddish: yiTeam,
        };
      }
    }

    const names = uploaded.map((u) => `"${u.name}"`).join(", ");
    const savedLine = `I've added ${uploaded.length > 1 ? `${uploaded.length} recordings (${names})` : `the recording ${names}`} to your phone system.`;

    // Message already says where it goes? Chain into the fully gated M4/M10 flow.
    if (/\b(set|use|make|play|put|switch|change|attach|assign)\b/i.test(input.raw)) {
      const chained = await this.handlePbxConfig(
        { kind: "action", actionType: "pbx_config", raw: `${input.raw}. The recording is named "${uploaded[0].name}".` },
        ctx,
        language,
      );
      if (chained.handled && chained.reply) {
        return { ...chained, reply: `${savedLine} ${chained.reply}` };
      }
    }

    const catalog = await this.fetchPbxCatalog(pbxTenantId);
    const ivrHint = catalog?.ivrs.length
      ? ` To use it, say for example: set the greeting on "${catalog.ivrs[0].description}" to "${uploaded[0].name}"${catalog.queues.length ? `, or: set the queue announcement to "${uploaded[0].name}"` : ""}.`
      : "";
    return { handled: true, reply: `${savedLine}${ivrHint}` };
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

  /** Active per-extension MOH override for this user's extension (null = none). */
  private async currentMohExtOverride(
    connectTenantId: string,
    extension: string,
  ): Promise<{ mohProfileId: string | null; vitalPbxMohClassName?: string | null } | null> {
    try {
      const o = await this.prisma.mohExtensionOverride.findFirst({
        where: { tenantId: connectTenantId, extension, enabled: true },
        select: { mohProfileId: true, vitalPbxMohClassName: true },
      });
      return o ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Read-only "what's playing right now?" answer, straight from the Connect
   * mirror (extension override > tenant override > regular schedule default).
   * Ends with the exact profile clarify question so a bare follow-up like
   * "Main" resumes into the normal change flow.
   */
  private async answerMohStatus(ctx: TriageCtx, ownExt: string | null, tz: string, language: "en" | "yi"): Promise<TriageOutcome> {
    const profiles = await this.listMohProfiles(ctx.tenantId);
    const nameOf = (id: string | null | undefined) => (id ? profiles.find((p) => p.id === id)?.name ?? null : null);
    const fmtTime = (d: Date | string) =>
      new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(d));

    const parts: string[] = [];
    let extOverridden = false;
    if (ownExt) {
      const extOv = await this.currentMohExtOverride(ctx.tenantId, ownExt);
      if (extOv) {
        extOverridden = true;
        const label = nameOf(extOv.mohProfileId) ?? extOv.vitalPbxMohClassName ?? "a custom class";
        parts.push(`Your extension ${ownExt} has its own hold music right now: "${label}".`);
      }
    }

    let ov: { isActive?: boolean; profileId?: string | null; expiresAt?: Date | null } | null = null;
    try {
      ov = await this.prisma.mohOverrideState.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { isActive: true, profileId: true, expiresAt: true },
      });
    } catch {
      ov = null;
    }
    if (ov?.isActive && ov.profileId) {
      const until = ov.expiresAt ? ` until ${fmtTime(ov.expiresAt)}` : "";
      parts.push(`The company-wide hold music is "${nameOf(ov.profileId) ?? "a custom profile"}"${until} (a manual change, not the schedule).`);
    } else {
      let defName: string | null = null;
      try {
        const cfg = await this.prisma.mohScheduleConfig.findUnique({ where: { tenantId: ctx.tenantId }, select: { defaultProfileId: true } });
        defName = nameOf(cfg?.defaultProfileId);
      } catch {
        defName = null;
      }
      parts.push(
        defName
          ? `The company-wide hold music is on the regular schedule — the default is "${defName}".`
          : "The company-wide hold music is on the regular schedule.",
      );
    }
    if (ownExt && !extOverridden) {
      parts.push(`Your extension ${ownExt} follows the company hold music.`);
    }

    const names = profiles.map((p) => p.name).filter(Boolean).join(", ");
    const tail = names
      ? ` If you'd like to change it — ${MOH_Q_PROFILE} Your available options are: ${names}. (You can also say "back to the regular schedule".)`
      : "";
    return {
      handled: true,
      reply: parts.join(" ") + tail,
      yiddish: language === "yi" ? parts.join(" ") : undefined,
    };
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
    const profiles = await this.listMohProfiles(ctx.tenantId);

    // ── LLM-first understanding (owner directive 2026-07-27) ──
    // The frontier model reads the request against verified context (real
    // profile names, own extension, local time) and returns validated JSON.
    // It only ever FILLS IN the same fields the regexes below produce — every
    // policy/scope/ownership gate still runs on the result, and a null (model
    // down, low confidence, hallucinated profile, bad shape) falls back to the
    // deterministic parser. See mohLlmExtract.ts.
    const llmRead: MohLlmResult | null = intent.statusQuery
      ? null
      : await extractMohRequest(this.llm, {
          text: raw,
          profiles: profiles.map((p) => String(p.name ?? "")).filter(Boolean),
          ownExt,
          isAdmin,
          tz,
          conversationId: ctx.conversationId,
        });

    // Status question ("which one am I on right now?") — read-only answer, no
    // action. Flag is set by detectIntent (fresh message), the clarify-resume
    // path (mid-conversation), or the LLM read of the message.
    if (intent.statusQuery || llmRead?.operation === "status") return this.answerMohStatus(ctx, ownExt, tz, language);

    const timing: MohTiming = llmRead ? llmRead.timing : parseMohTiming(raw, tz);

    // ── scope ──
    let scope: "tenant" | "extension" | null = null;
    let targetExt: string | null = null;
    if (llmRead) {
      scope = llmRead.scope;
      if (llmRead.extension) {
        scope = "extension";
        targetExt = llmRead.extension;
      } else if (scope === "extension") {
        targetExt = ownExt;
      }
    } else {
      const extNum = raw.match(MOH_EXT_NUM_RE)?.[1] ?? null;
      if (MOH_TENANT_SCOPE_RE.test(t)) scope = "tenant";
      else if (extNum) {
        scope = "extension";
        targetExt = extNum;
      } else if (MOH_EXT_SCOPE_RE.test(t) || MOH_ANSWER_EXT_RE.test(t)) {
        scope = "extension";
        targetExt = ownExt;
      }
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
      } else if (llmRead ? llmRead.operation === "restore" : intent.enableHint === "no") {
        // "Change it back (in 15 minutes)" — infer the scope from what is
        // actually overridden instead of asking: the user's own extension
        // override if one is active, else the tenant-wide override. Asking
        // "whole company or your extension?" about a REVERT is noise.
        const extOv = await this.currentMohExtOverride(ctx.tenantId, ownExt);
        if (extOv) {
          scope = "extension";
          targetExt = ownExt;
        } else {
          scope = "tenant";
        }
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

    // Target profile. LLM path: the validated profile name from the model.
    // Regex fallback: a profile explicitly named as a TARGET ("to Main",
    // "into Main") beats the deactivate heuristic — the EARLIEST such mention
    // wins, and a mention right after back/return/revert/restore ("then back
    // to Classic") is NEVER the target (live misparse 2026-07-27: "into main
    // till 8:45 then … back to classic" set Classic — "into" wasn't accepted
    // and "back to classic" won). The revert itself is handled by the M1/M2
    // snapshot restore automatically.
    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isRevertMention = (idx: number) => /\b(?:back|return|revert|restore)[\s,]*$/.test(t.slice(Math.max(0, idx - 24), idx));
    let targetProfile: { id: string; name: string } | null = null;
    if (llmRead?.profileName) {
      const want = llmRead.profileName.toLowerCase();
      targetProfile = profiles.find((p) => String(p.name ?? "").toLowerCase() === want) ?? null;
    } else if (!llmRead) {
      let bestIdx = Number.POSITIVE_INFINITY;
      let bestLen = -1;
      for (const p of profiles) {
        const n = String(p.name ?? "").toLowerCase();
        if (!n) continue;
        const re = new RegExp(String.raw`\b(?:in|on)?to\s+(?:the\s+)?["'“”]?` + escapeRe(n) + String.raw`\b`, "gi");
        for (const m of t.matchAll(re)) {
          const idx = m.index ?? -1;
          if (idx < 0 || isRevertMention(idx)) continue;
          if (idx < bestIdx || (idx === bestIdx && n.length > bestLen)) {
            bestIdx = idx;
            bestLen = n.length;
            targetProfile = p;
          }
        }
      }
    }

    const deactivate = llmRead ? llmRead.operation === "restore" && !targetProfile : intent.enableHint === "no" && !targetProfile;
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
      // (ownership re-checked by scope fence + op snapshot + api door). An
      // explicit "to <profile>" target wins; otherwise longest name mentioned
      // ANYWHERE EXCEPT as a revert descriptor ("then back to Classic" is not
      // a pick of Classic). The LLM path never fuzzy-guesses: the model
      // already read the message, so a null profile means it truly wasn't
      // stated and we ask.
      const mentionedAsPick = (p: { name: unknown }) => {
        const n = String(p.name ?? "").toLowerCase();
        if (!n) return false;
        for (const m of t.matchAll(new RegExp(escapeRe(n), "g"))) {
          const idx = m.index ?? 0;
          const before = t.slice(Math.max(0, idx - 34), idx);
          if (/\b(?:back|return|revert|restore)\b[\s,]*(?:(?:in|on)?to\s+)?(?:the\s+)?["'“”]?$/.test(before)) continue;
          return true;
        }
        return false;
      };
      const matches = llmRead
        ? []
        : profiles.filter(mentionedAsPick).sort((a, b) => String(b.name).length - String(a.name).length);
      const chosen =
        targetProfile ??
        (matches.length === 1 || (matches.length > 1 && String(matches[0].name).length > String(matches[1].name).length) ? matches[0] : null);
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
          // If another manual override is playing RIGHT NOW, the timer must
          // restore IT (action revert = snapshot restore), not the schedule —
          // "Main for 20 minutes then back to Classic" (live 2026-07-27).
          const cur = await this.currentMohOverride(ctx.tenantId);
          if (cur?.isActive && cur.profileId && cur.profileId !== chosen.id) {
            const curName = profiles.find((p) => p.id === cur.profileId)?.name ?? null;
            params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: chosen.id, reason: "chat request (timed; revert restores previous override)" };
            revertAfterMinutes = minutesFromTiming;
            summary = `switch the hold music to "${chosen.name}" ${timingPhrase}, then back to ${curName ? `"${curName}"` : "the previous music"}`;
          } else {
            params = { tenantId: pbxTenantId, objectId: pbxTenantId, action: "activate", profileId: chosen.id, reason: "chat request", expiresMinutes: minutesFromTiming };
            summary = `switch the hold music to "${chosen.name}" ${timingPhrase}, then back to the regular schedule`;
          }
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

  // ── M3 / M4 / M10: inbound routing, IVR menus, queue configuration ────────

  /** Live tenant inventory from the PBX (via the api door). Null on any failure. */
  private async fetchPbxCatalog(pbxTenantId: string): Promise<PbxCatalog | null> {
    if (!this.routeApi) return null;
    try {
      const resp = await this.routeApi.call({ action: "list_catalog", tenantId: pbxTenantId, agentActionId: "triage-catalog" });
      return (resp?.catalog ?? null) as PbxCatalog | null;
    } catch {
      return null;
    }
  }

  /** Tenant hold-music profiles WITH their Asterisk class (for queue set_moh). */
  private async listMohProfilesWithClass(connectTenantId: string): Promise<Array<{ name: string; mohClass: string }>> {
    try {
      const rows = await this.prisma.mohProfile.findMany({
        where: { tenantId: connectTenantId, isActive: true },
        select: { name: true, vitalPbxMohClassName: true },
      });
      return (rows ?? [])
        .filter((r: any) => r.name && r.vitalPbxMohClassName)
        .map((r: any) => ({ name: String(r.name), mohClass: String(r.vitalPbxMohClassName) }));
    } catch {
      return [];
    }
  }

  /**
   * PBX configuration flow (owner directive 2026-07-28): the LLM reads the
   * request against the tenant's LIVE inventory (DIDs + current targets, IVRs +
   * entries, queues + members, recordings, hold-music profiles); deterministic
   * code re-resolves every name against that same inventory and builds fully
   * formed M3/M4/M10 params. Status questions are answered read-only from the
   * catalog. Everything else flows through ActionService → the gated executor
   * (ownership re-verified ON the PBX, snapshot, verify, revert).
   */
  private async handlePbxConfig(intent: Extract<Intent, { kind: "action" }>, ctx: TriageCtx, language: "en" | "yi"): Promise<TriageOutcome> {
    const yiTeam = language === "yi" ? "דאָס איז עפּעס וואָס איך וועל איבערגעבן צו אונדזער טים." : undefined;
    if (!this.routeApi) return { handled: false };
    const pbxTenantId = await this.resolvePbxTenantId(ctx.tenantId);
    if (!pbxTenantId) {
      return {
        handled: true,
        reply: "Your account isn't linked to the phone system yet, so I can't change call routing — I've flagged it for our team.",
        yiddish: yiTeam,
      };
    }

    const catalog = await this.fetchPbxCatalog(pbxTenantId);
    if (!catalog) {
      return {
        handled: true,
        reply: "I couldn't reach your phone system's configuration just now. Please try again in a minute — if it keeps happening I'll pass it to our team.",
        yiddish: yiTeam,
      };
    }
    const mohProfiles = await this.listMohProfilesWithClass(ctx.tenantId);

    const extracted = await extractPbxCfgRequest(this.llm, {
      text: intent.raw,
      catalog,
      mohProfiles,
      conversationId: ctx.conversationId,
    });

    // Not actually a routing/IVR/queue request (e.g. "what's on the menu at
    // lunch") — let the conversation LLM answer it as plain chat.
    if (extracted?.kind === "not_pbx_config") return { handled: false };

    // Config changes are company-level: regular users get a polite fence
    // BEFORE any clarify loop (same policy the M-ops enforce downstream).
    const standing = await this.resolveStanding(ctx);
    if (standing === "tenant_user") {
      return {
        handled: true,
        reply: "Changing call routing, IVR menus, or queue settings needs a company admin. I can pass your request to them, or an admin on your account can ask me directly.",
        yiddish: yiTeam,
      };
    }

    if (!extracted) {
      // Model down / low confidence — never guess a write. Say what we CAN do,
      // grounded in their real inventory, and let them restate.
      const bits: string[] = [];
      if (catalog.routes.length) bits.push(`where your number${catalog.routes.length > 1 ? "s" : ""} (${catalog.routes.map((r) => r.did).join(", ")}) route`);
      if (catalog.ivrs.length) bits.push(`your IVR menu${catalog.ivrs.length > 1 ? "s" : ""} (${catalog.ivrs.map((i) => `"${i.description}"`).join(", ")}) — greetings and what each key does`);
      if (catalog.queues.length) bits.push(`your queue${catalog.queues.length > 1 ? "s" : ""} (${catalog.queues.map((q) => `"${q.description}"`).join(", ")}) — members, hold music, announcements`);
      return {
        handled: true,
        reply: `I wasn't 100% sure what to change, and I never guess with call routing. I can change ${bits.join("; ")}. Could you say it once more with the specific number/menu/queue and where it should go?`,
        yiddish: yiTeam,
      };
    }

    if (extracted.kind === "clarify") {
      return { handled: true, reply: extracted.question, yiddish: yiTeam ? extracted.question : undefined };
    }

    const op = extracted.op;

    // ── Read-only status answers straight from the live catalog ──
    if (op.op === "status") {
      return { handled: true, reply: this.answerPbxCfgStatus(op, catalog), yiddish: undefined };
    }

    // ── Build fully formed M3/M4/M10 params ──
    let capId: string;
    let params: Record<string, unknown>;
    let summary: string;
    if (op.domain === "route") {
      capId = "pbx.M3";
      if (op.op === "restore") {
        params = { tenantId: pbxTenantId, objectId: op.did, action: "restore", reason: intent.raw.slice(0, 400) };
        summary = `restore ${op.did} to its original routing`;
      } else {
        params = {
          tenantId: pbxTenantId,
          objectId: op.did,
          action: "retarget_v2",
          targetType: op.target.type,
          targetId: op.target.id,
          targetLabel: op.target.label,
          reason: intent.raw.slice(0, 400),
        };
        summary = `route ${op.did} to ${op.target.label}`;
      }
    } else if (op.domain === "ivr") {
      capId = "pbx.M4";
      if (op.op === "set_welcome") {
        params = { tenantId: pbxTenantId, objectId: `ivr:${op.ivrId}:welcome`, action: "native_set_welcome", ivrId: String(op.ivrId), recordingId: String(op.recordingId) };
        summary = `set the greeting on IVR "${op.ivrName}" to recording "${op.recordingName}"`;
      } else if (op.op === "clear_entry") {
        params = { tenantId: pbxTenantId, objectId: `ivr:${op.ivrId}:${op.option}`, action: "native_clear_entry", ivrId: String(op.ivrId), option: op.option };
        summary = `remove option ${op.option} from IVR "${op.ivrName}"`;
      } else {
        params = {
          tenantId: pbxTenantId,
          objectId: `ivr:${op.ivrId}:${op.option}`,
          action: "native_set_entry",
          ivrId: String(op.ivrId),
          option: op.option,
          targetType: op.target.type,
          targetId: op.target.id,
          targetLabel: op.target.label,
        };
        summary = `point option ${op.option} on IVR "${op.ivrName}" to ${op.target.label}`;
      }
    } else {
      capId = "pbx.M10";
      const base = { tenantId: pbxTenantId, objectId: op.queueExtension, queueLabel: `${op.queueExtension} ("${op.queueName}")` };
      if (op.op === "set_announcement") {
        params = { ...base, action: "set_announcement", slot: op.slot, recordingId: op.recordingId != null ? String(op.recordingId) : null };
        summary = op.recordingName
          ? `set queue "${op.queueName}" ${op.slot} announcement to recording "${op.recordingName}"`
          : `clear queue "${op.queueName}" ${op.slot} announcement`;
      } else if (op.op === "set_moh") {
        params = { ...base, action: "set_moh", mohClass: op.mohClass };
        summary = `set queue "${op.queueName}" hold music to "${op.mohLabel}"`;
      } else {
        params = { ...base, action: op.op === "add_member" ? "member_add" : "member_remove", extension: op.extension };
        summary = `${op.op === "add_member" ? "add" : "remove"} extension ${op.extension} ${op.op === "add_member" ? "to" : "from"} queue "${op.queueName}"`;
      }
    }

    const action = await this.actions.create({
      tenantId: pbxTenantId,
      capabilityId: capId,
      params,
      summary,
      requestedBy: ctx.clientUserId ?? "unknown",
      requestedRole: ctx.role,
      conversationId: ctx.conversationId,
      autoApprove: ctx.role === "owner",
      riskTier: "medium",
    });

    const submitted = action.status === "EXECUTED";
    const failed = action.status === "FAILED" || action.status === "DENIED";
    return {
      handled: true,
      actionId: action.id,
      reply: submitted
        ? `Done — ${summary}. The change is live on your phone system now.`
        : failed
          ? `I tried to ${summary}, but it didn't go through — I've passed the details to our team.`
          : `I've submitted this for approval: ${summary}. I'll let you know once it's live.`,
      yiddish:
        language === "yi"
          ? submitted
            ? `פֿאַרטיק — די ענדערונג איז שוין אַקטיוו.`
            : failed
              ? `עס האָט זיך נישט אײַנגעגעבן — איך האָב עס איבערגעגעבן צו אונדזער טים.`
              : `איך האָב עס איבערגעגעבן פֿאַר אַפּרואוו.`
          : undefined,
    };
  }

  /** Read-only status text for route/IVR/queue questions, from the live catalog. */
  private answerPbxCfgStatus(op: Extract<PbxCfgOperation, { op: "status" }>, catalog: PbxCatalog): string {
    const fmtT = (t: { type: string; targetId: string | null; label: string | null } | null) =>
      t ? `${t.type.replace(/_/g, " ")} ${t.label ?? t.targetId ?? "?"}`.trim() : "(not set)";
    if (op.domain === "route") {
      if (!catalog.routes.length) return "I don't see any phone numbers set up on your account yet.";
      const lines = catalog.routes.map((r) => `${r.did}${r.description ? ` ("${r.description}")` : ""} → ${fmtT(r.target)}`);
      return `Here's where your number${catalog.routes.length > 1 ? "s" : ""} currently route${catalog.routes.length > 1 ? "" : "s"}: ${lines.join("; ")}. Want me to change any of them?`;
    }
    if (op.domain === "ivr") {
      if (!catalog.ivrs.length) return "Your phone system doesn't have any IVR menus yet.";
      const lines = catalog.ivrs.map((i) => {
        const opts = i.entries.map((e) => `press ${e.option} → ${fmtT(e.target)}`).join(", ");
        return `"${i.description}" — greeting: ${i.welcomeRecordingName ? `"${i.welcomeRecordingName}"` : "none"}; ${opts || "no options set"}`;
      });
      return `Your IVR menu${catalog.ivrs.length > 1 ? "s" : ""}: ${lines.join(" | ")}. I can change the greeting or any option — just tell me.`;
    }
    if (!catalog.queues.length) return "Your phone system doesn't have any call queues yet.";
    const lines = catalog.queues.map((q) => `queue ${q.extension} "${q.description}" — members: ${q.members.map((m) => m.extension).join(", ") || "none"}`);
    return `Your queue${catalog.queues.length > 1 ? "s" : ""}: ${lines.join("; ")}. I can add/remove extensions, change the queue's hold music, or set announcements.`;
  }

  /**
   * The user replied to one of OUR pbx-config clarifying questions ("Which
   * queue? You have: …"). Combine the original ask with the answer and re-run
   * the full catalog-grounded flow — same pattern as the MOH clarify resume.
   */
  private async resumePbxCfgClarification(intent: Extract<Intent, { kind: "chat" }>, ctx: TriageCtx): Promise<Extract<Intent, { kind: "action" }> | null> {
    const text = (intent.raw ?? "").trim();
    if (!text || text.length > 300 || !ctx.conversationId) return null;
    try {
      const msgs: Array<{ role: string; content: string | null; contentEn: string | null }> = await this.prisma.agentMessage.findMany({
        where: { conversationId: ctx.conversationId },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { role: true, content: true, contentEn: true },
      });
      let i = 0;
      while (i < msgs.length && msgs[i].role !== "assistant") i++; // skip the just-stored user reply
      if (i >= msgs.length) return null;
      const textOf = (m: { content: string | null; contentEn: string | null }) => String(m.contentEn ?? m.content ?? "");
      if (!PBXCFG_CLARIFY_MARKER_RE.test(textOf(msgs[i]))) return null;
      // Collect the user messages before our question (the original request).
      i++;
      const prior: string[] = [];
      while (i < msgs.length && msgs[i].role !== "assistant") {
        prior.push(textOf(msgs[i]));
        i++;
      }
      const combined = [...prior.reverse(), text].filter(Boolean).join(". ");
      return { kind: "action", actionType: "pbx_config", raw: combined };
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
