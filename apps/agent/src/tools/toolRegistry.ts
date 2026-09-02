/**
 * Tool registry — the surface the MODEL is allowed to reach for.
 *
 * ⛔ THE ONE RULE THIS FILE EXISTS TO ENFORCE:
 * `tenantId` is NEVER a model-supplied argument. It is bound at execution time
 * from the server-verified ToolContext. No tool's JSON schema may declare it,
 * and `execute()` strips any tenant-ish key the model invents before the args
 * ever reach a query.
 *
 * Why this is not paranoia: Connect has already shipped a cross-tenant leak
 * (2026-08-02, 116 call records filed under the wrong company) whose root cause
 * was exactly this — trusting a caller-supplied tenant id. Before tools, the
 * agent was safe because it was powerless: code fetched scoped data and pasted
 * it into the prompt. The moment the model can ASK for data, that protection is
 * gone and enforcement has to live here instead.
 *
 * Role gating is the second rule: a customer-facing conversation gets a strict
 * subset. Adding a tool without a `minRole` is a compile error, not a default.
 */
import type { ReadTools } from "./readTools";

/**
 * Who is on the other end.
 *   "customer" — the untrusted, tenant-locked end user (a plain USER).
 *   "internal" — admin MODE for THIS tenant: SUPER_ADMIN *or* TENANT_ADMIN (the
 *                customer's own administrator). Gets the tenant-scoped internal
 *                tools (call_quality, the prepare_* provisioning/grant drafts).
 *   "staff"    — Connect staff (SUPER_ADMIN) ONLY. Gets tools that are NOT
 *                tenant-scoped and could read across the whole platform — today
 *                that is `investigate`, which runs raw SQL against both
 *                databases. ⛔ A TENANT_ADMIN is "internal", never "staff": the
 *                agent maps TENANT_ADMIN → admin mode (2026-08-06), and treating
 *                that as Connect-staff would hand 9 customer admins a cross-tenant
 *                read of production. The two questions are separated by
 *                `isPlatformStaff` (authRoles.ts).
 */
export type ToolRole = "customer" | "internal" | "staff";

export interface ToolContext {
  /** SERVER-VERIFIED tenant. Never read from model output or chat text. */
  tenantId: string;
  role: ToolRole;
  clientUserId?: string | null;
  /** Which portal page the person is on; the coworker_task tool refuses unless it is the desktop Coworker bubble. */
  viewingPath?: string;
  /** The conversation this turn belongs to — stamped on a drafted AgentAction so its card can be traced back. */
  conversationId?: string;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /**
   * "customer" = safe for an untrusted end user; "internal" = admin mode for the
   * caller's OWN tenant (tenant-scoped); "staff" = Connect staff only, for tools
   * that are NOT tenant-scoped and could reach across the platform.
   */
  minRole: ToolRole;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/**
 * Keys the model must never be able to set. If a model emits one (hallucination
 * or injection), it is dropped before execution and the drop is surfaced to the
 * caller for auditing — silently ignoring it would hide an attack in progress.
 */
const FORBIDDEN_ARG_KEYS = new Set([
  "tenantid", "tenant_id", "tenant", "companyid", "company_id",
  "clientuserid", "client_user_id", "userid", "user_id", "role",
]);

export function stripForbiddenArgs(
  args: Record<string, unknown>,
): { clean: Record<string, unknown>; dropped: string[] } {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (FORBIDDEN_ARG_KEYS.has(k.toLowerCase().replace(/[^a-z_]/g, ""))) dropped.push(k);
    else clean[k] = v;
  }
  return { clean, dropped };
}

/** Coerce a model-supplied extension to a safe, bounded string (or undefined). */
function asExtension(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  // Extensions are short numeric-ish tokens. Anything else is not an extension.
  return /^[0-9]{1,10}$/.test(s) ? s : undefined;
}

/** Clamp a model-supplied window to something a query can survive. */
function asWindowHours(v: unknown, fallback = 48): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), 24 * 30);
}

export interface BuildToolsDeps {
  readTools: ReadTools;
  /** Prisma client — used only for the tenant-scoped quality read. */
  prisma: any;
}

/**
 * The full catalogue. `toolsForRole()` is what callers should use — it applies
 * the role filter. Note every `run` ignores any tenant the model tried to pass
 * and uses `ctx.tenantId`.
 */
export function buildTools(deps: BuildToolsDeps): ToolSpec[] {
  return [
    {
      name: "extension_status",
      description:
        "Registration state of this account's phone extensions: whether each is registered, its status, contact address, user agent, and when it was last seen. Use this first for any 'my phone isn't ringing' or 'calls go straight to voicemail' question.",
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          extension: { type: "string", description: "Optional extension number, e.g. '101'. Omit for all extensions." },
        },
        additionalProperties: false,
      },
      run: (args, ctx) => deps.readTools.extensionStatus(ctx.tenantId, asExtension(args.extension)),
    },
    {
      name: "call_history",
      description:
        "Summary of this account's recent calls: totals answered/missed/failed, the count of very short answered calls (a one-way-audio signature), and the ten most recent calls. Use for 'did the call come through', 'we're missing calls', or to confirm whether a reported problem shows up in the record.",
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          extension: { type: "string", description: "Optional extension number to filter to." },
          windowHours: { type: "number", description: "How far back to look, in hours. Default 48, max 720." },
        },
        additionalProperties: false,
      },
      run: (args, ctx) =>
        deps.readTools.cdrHistory(ctx.tenantId, asExtension(args.extension), asWindowHours(args.windowHours)),
    },
    {
      name: "voicemails",
      description:
        "This account's voicemail inbox, newest first: who called, when, how long, whether it was heard, and the transcript where one exists. Use for 'do I have voicemails', 'summarize my voicemails', or 'who left me a message'. Summarize from the transcripts; where a message has no transcript say so rather than guessing what it contains. Read-only — it never marks anything heard.",
      minRole: "customer",
      parameters: {
        type: "object",
        properties: {
          extension: { type: "string", description: "Optional mailbox extension number to filter to." },
          limit: { type: "number", description: "How many recent messages to return. Default 15, max 25." },
        },
        additionalProperties: false,
      },
      run: (args, ctx) =>
        deps.readTools.voicemailSummary(
          ctx.tenantId,
          asExtension(args.extension),
          typeof args.limit === "number" ? args.limit : 15,
        ),
    },
    {
      name: "call_quality",
      description:
        "Measured audio quality for this account, bucketed by hour: round-trip time, jitter, packet loss in both directions, and how many calls were poor. Broken out by user, direction, codec, network type, and whether the call used a relay. Use to answer 'the audio was bad' with evidence, or to compare relay vs direct for a specific person.",
      minRole: "internal",
      parameters: {
        type: "object",
        properties: {
          windowHours: { type: "number", description: "How far back to look, in hours. Default 168 (7 days), max 720." },
        },
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        const hours = asWindowHours(args.windowHours, 168);
        const rows = await deps.prisma.callQualityHourly.findMany({
          where: { tenantId: ctx.tenantId, hourStart: { gte: new Date(Date.now() - hours * 3600 * 1000) } },
          orderBy: { hourStart: "desc" },
          take: 500,
        });
        return { windowHours: hours, buckets: rows.length, rows };
      },
    },
  ];
}

/**
 * Tools this role may see. Customers never learn an internal tool exists, and a
 * tenant admin ("internal") never learns a staff tool exists.
 *   staff    → everything
 *   internal → customer + internal tiers, but NOT staff-only tools
 *   customer → customer tier only
 * ⛔ The `internal` case must exclude `staff`: a TENANT_ADMIN is "internal", and
 * `staff`-tier tools (e.g. `investigate`) are not tenant-scoped.
 */
export function toolsForRole(all: ToolSpec[], role: ToolRole): ToolSpec[] {
  if (role === "staff") return all;
  if (role === "internal") return all.filter((t) => t.minRole !== "staff");
  return all.filter((t) => t.minRole === "customer");
}

export interface ToolExecutionResult {
  ok: boolean;
  /** JSON-serialisable payload handed back to the model. */
  content: unknown;
  droppedArgs: string[];
}

/**
 * Execute one model-requested tool call. Refuses unknown names and any tool the
 * role may not use — a refusal is returned to the model as an error result
 * rather than thrown, so the loop can continue and the model can adjust.
 */
export async function executeTool(
  all: ToolSpec[],
  name: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const visible = toolsForRole(all, ctx.role);
  const spec = visible.find((t) => t.name === name);
  if (!spec) {
    return { ok: false, content: { error: `Unknown or unavailable tool: ${name}` }, droppedArgs: [] };
  }
  const { clean, dropped } = stripForbiddenArgs(rawArgs);
  try {
    const content = await spec.run(clean, ctx);
    return { ok: true, content, droppedArgs: dropped };
  } catch (err) {
    return { ok: false, content: { error: String((err as Error)?.message ?? err) }, droppedArgs: dropped };
  }
}
