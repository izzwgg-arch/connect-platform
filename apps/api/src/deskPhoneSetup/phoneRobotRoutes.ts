/**
 * The office wizard's OpenAI-powered improviser — round 23, 2026-09-17.
 *
 * Izzy, verbatim: "a robot and a browser hidden inside the wizard… From now on, the
 * actual AI agent (OpenAI) runs the wizard and is taught everything, and should be
 * able to improvise." This is that door: when a web op on the office machine reports
 * a screen the scripted ladder does not recognise, the driver posts a SNAPSHOT here
 * (labelled text and elements only — never a screenshot, never a password value)
 * together with the goal and the history of what has already been tried, and this
 * route asks the agent container what to do next.
 *
 * ⛔⛔ SERVER-SIDE FENCE, DEFENSE IN DEPTH. The desktop enforces its own copy of this
 * rule too, but nothing the model proposes reaches the office machine unless it ALSO
 * passes here: the only URL any `fill` action may ever type is THIS tenant's own
 * provisioning folder — never a different address, never a shortened link, never a
 * plausible-looking guess. A violation replaces the whole answer with `give_up` and
 * is audited by name (`DESK_PHONE_ROBOT_FENCE_TRIPPED`) — this is the one failure
 * mode the whole feature exists to prevent, so it is never left to a single layer.
 *
 * ⛔ Same guards, same audit, same wizard as every other route in this area: ownership
 * resolved before anything else (`ownRun`), the permission asked after (`allowedToSetUp`),
 * no tenant ever taken from the request body. `deskPhoneRouteOrder.test.ts` holds this
 * file to the same rule as `deviceCloudRoutes.ts`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DeskPhoneDeps } from "./deskPhoneRoutes";

const actionSchema = z.union([
  z.object({ kind: z.literal("goto"), path: z.string().max(300) }),
  z.object({ kind: z.literal("fill"), ref: z.string().max(80), text: z.string().max(500) }),
  z.object({ kind: z.literal("click"), ref: z.string().max(80) }),
  z.object({ kind: z.literal("read") }),
]);

// ⛔ The snapshot's SHAPE is loose on purpose (the desktop's own contract owns the
// exact fields) — this route's job is the size cap and the URL fence, not re-litigating
// what a snapshot looks like. `.passthrough()` so an extra field never 400s a real call.
const snapshotSchema = z
  .object({
    url: z.string().max(2000).optional(),
    title: z.string().max(500).optional(),
    text: z.string().max(1200).optional(),
    elements: z
      .array(
        z
          .object({
            ref: z.string().max(80),
            tag: z.string().max(40).optional(),
            type: z.string().max(40).optional(),
            name: z.string().max(200).optional(),
            id: z.string().max(200).optional(),
            label: z.string().max(400).optional(),
            value: z.string().max(400).optional(),
            options: z.array(z.string().max(200)).max(50).optional(),
          })
          .passthrough(),
      )
      .max(300)
      .optional(),
  })
  .passthrough();

const bodySchema = z.object({
  goal: z.enum(["provision", "reset", "identify"]),
  snapshot: snapshotSchema,
  history: z
    .array(
      z.object({
        actions: z.array(z.unknown()).max(20),
        outcome: z.string().max(200),
      }),
    )
    .max(20)
    .default([]),
});

export type AgentAdviseResult = {
  verdict: "actions" | "done" | "give_up";
  actions?: Array<Record<string, unknown>>;
  customerHint?: string;
  reason?: string;
  /** provider:model, for the audit only — never shown to a customer. */
  model?: string;
};

export type PhoneRobotRouteContext = {
  deps: DeskPhoneDeps;
  db: any;
  ownRun: (req: any, reply: any) => Promise<{ user: { sub: string; tenantId: string; email: string; role: string }; run: any } | null>;
  allowedToSetUp: (user: any, reply: any) => Promise<boolean>;
  provisioningUrlFor: (tenantId: string) => Promise<string | null>;
  /**
   * Injectable for tests. The real default calls the agent container over HTTP,
   * exactly the way `POST /ui/translate` already does (see server.ts) — the ONE
   * established pattern for api → agent calls in this codebase: a shared secret in
   * `x-agent-internal-secret`, `AGENT_BASE_URL` (default `http://agent:3920`), never
   * fabricate on failure.
   */
  askAgent?: (body: {
    goal: "provision" | "reset" | "identify";
    snapshot: unknown;
    history: Array<{ actions: unknown[]; outcome: string }>;
    allowedUrl: string | null;
  }) => Promise<AgentAdviseResult | null>;
};

/**
 * ⛔ Customers never see "AI", "agent", "robot", "OpenAI", "ChatGPT" or "Claude" on
 * screen (the non-negotiable rule for this whole feature). The model is TOLD this in
 * its system prompt, but a hint is customer-facing copy and this is the layer that
 * actually owns what reaches the screen — so it is enforced here too, not trusted to
 * the prompt alone.
 */
const FORBIDDEN_IN_CUSTOMER_COPY = /\b(ai|artificial intelligence|open\s*ai|chat\s*gpt|gpt-\d|robot|claude)\b/i;
const SAFE_FALLBACK_HINT = "Working on this phone…";

/** Round-23 hardening — same rule, same words as the desktop's looksLikeServerTarget:
 * "://" alone was bypassable by a bare hostname (Yealink prepends a default scheme
 * to a schemeless server value), so anything host-shaped counts. */
function looksLikeServerTarget(text: string): boolean {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return false;
  if (t.includes("://")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}([:/].*)?$/.test(t)) return true;
  if (/^([a-z0-9_-]+\.)+[a-z]{2,}([:/].*)?$/.test(t)) return true;
  return false;
}
const SERVER_FIELD_RE = /(url|server|provision|autop|dhcp|option|tftp)/i;

function sanitizeCustomerHint(hint: unknown): string {
  const s = String(hint ?? "").trim().slice(0, 400);
  if (!s) return SAFE_FALLBACK_HINT;
  return FORBIDDEN_IN_CUSTOMER_COPY.test(s) ? SAFE_FALLBACK_HINT : s;
}

async function defaultAskAgent(body: {
  goal: "provision" | "reset" | "identify";
  snapshot: unknown;
  history: Array<{ actions: unknown[]; outcome: string }>;
  allowedUrl: string | null;
}): Promise<AgentAdviseResult | null> {
  const secret = process.env.AGENT_INTERNAL_SECRET;
  const base = process.env.AGENT_BASE_URL || "http://agent:3920";
  if (!secret) return null;
  try {
    const resp = await fetch(`${base}/agent/phone-robot/advise`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-internal-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as AgentAdviseResult;
  } catch {
    // Never fabricate a plan. An unreachable agent is exactly one more reason to
    // give up gracefully, never a reason to guess at what the model would have said.
    return null;
  }
}

// ⛔ ≤30 advise calls per phone per hour, in-memory (this process; a restart clears
// it, which only ever makes the cap MORE generous, never less). A phone that needs
// more than that is not going to be solved by asking a 31st time — Loopcom Support
// finishes it instead.
const ADVISE_RATE_LIMIT = 30;
const ADVISE_RATE_WINDOW_MS = 60 * 60 * 1000;
const adviseCallLog = new Map<string, number[]>();

function rateLimited(phoneId: string, nowMs: number): boolean {
  const recent = (adviseCallLog.get(phoneId) ?? []).filter((t) => nowMs - t < ADVISE_RATE_WINDOW_MS);
  recent.push(nowMs);
  adviseCallLog.set(phoneId, recent);
  return recent.length > ADVISE_RATE_LIMIT;
}

/** Test-only: the rate log is process-lifetime state and must not leak between tests. */
export function __resetPhoneRobotRateLimitForTests(): void {
  adviseCallLog.clear();
}

/**
 * The whole request body, computed once so both the fence and the audit use the
 * exact same figure for "how big was this snapshot".
 */
function bodyTooLarge(raw: unknown): boolean {
  try {
    return JSON.stringify((raw as any)?.snapshot ?? {}).length > 64 * 1024;
  } catch {
    return true; // unserializable input is refused, never guessed at
  }
}

export function registerPhoneRobotRoutes(app: FastifyInstance, ctx: PhoneRobotRouteContext): void {
  const { deps, db, ownRun, allowedToSetUp, provisioningUrlFor, askAgent = defaultAskAgent } = ctx;

  app.post("/desk-phones/runs/:id/phones/:phoneId/robot-advise", async (req: any, reply: any) => {
    // ⛔ Ownership before anything else — see ownRun()'s own comment in deskPhoneRoutes.ts.
    const owned = await ownRun(req, reply);
    if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    if (bodyTooLarge(req.body)) return reply.status(400).send({ error: "snapshot_too_large" });
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    if (rateLimited(phone.id, Date.now())) {
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_ROBOT_ADVISED", entityType: "desk_phone_setup_phone",
        entityId: phone.id, actorUserId: user.sub,
        metadata: { round: parsed.data.history.length, verdict: "give_up", actionKinds: [], model: null, reason: "rate_limited" },
      }).catch(() => null);
      return reply.send({
        ok: true, verdict: "give_up",
        customerHint: "Loopcom Support will finish this one with you.",
        reason: "advise_rate_limited",
      });
    }

    let allowedUrl: string | null = null;
    try { allowedUrl = await provisioningUrlFor(user.tenantId); } catch { allowedUrl = null; }

    let result: AgentAdviseResult | null = null;
    try {
      result = await askAgent({
        goal: parsed.data.goal, snapshot: parsed.data.snapshot, history: parsed.data.history, allowedUrl,
      });
    } catch { result = null; }

    if (!result || !["actions", "done", "give_up"].includes(result.verdict)) {
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_ROBOT_ADVISED", entityType: "desk_phone_setup_phone",
        entityId: phone.id, actorUserId: user.sub,
        metadata: { round: parsed.data.history.length, verdict: "give_up", actionKinds: [], model: null, reason: "agent_unreachable_or_malformed" },
      }).catch(() => null);
      return reply.send({
        ok: true, verdict: "give_up",
        customerHint: "Loopcom Support will finish this one with you.",
      });
    }

    let verdict = result.verdict;
    let actions = verdict === "actions" && Array.isArray(result.actions) ? result.actions.slice(0, 20) : [];
    let fenceTripped = false;

    // ⛔⛔ THE ONE RULE THAT CANNOT BE DELEGATED TO THE MODEL, round-23 HARDENED:
    // any `fill.text` that is host-shaped (scheme'd OR a bare hostname/IP — Yealink
    // prepends a default scheme to schemeless server values, so "evil.example/x"
    // is as dangerous as "https://evil.example/x"), and ANY non-empty fill into an
    // element the snapshot itself names as a server/URL field, must be EXACTLY this
    // tenant's own provisioning folder — nothing else is ever typed into a
    // customer's phone from here.
    if (verdict === "actions") {
      const elements: any[] = Array.isArray((parsed.data.snapshot as any)?.elements)
        ? (parsed.data.snapshot as any).elements : [];
      const serverishRef = (ref: unknown) => {
        const el = elements.find((e) => e && e.ref === ref);
        if (!el) return false;
        return SERVER_FIELD_RE.test([el.name, el.id, el.label].filter(Boolean).join(" "));
      };
      for (const a of actions) {
        if ((a as any)?.kind !== "fill") continue;
        const text = (a as any)?.text;
        if (typeof text !== "string") continue;
        const sensitive = looksLikeServerTarget(text) || (serverishRef((a as any).ref) && text.trim() !== "");
        if (sensitive && (!allowedUrl || text.trim() !== allowedUrl.trim())) { fenceTripped = true; break; }
      }
    }
    if (fenceTripped) {
      verdict = "give_up";
      actions = [];
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_ROBOT_FENCE_TRIPPED", entityType: "desk_phone_setup_phone",
        entityId: phone.id, actorUserId: user.sub,
        metadata: { round: parsed.data.history.length },
      }).catch(() => null);
    }

    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_ROBOT_ADVISED", entityType: "desk_phone_setup_phone",
      entityId: phone.id, actorUserId: user.sub,
      metadata: {
        round: parsed.data.history.length,
        verdict,
        actionKinds: actions.map((a) => (a as any)?.kind).filter(Boolean),
        model: result.model ?? null,
      },
    }).catch(() => null);

    return reply.send({
      ok: true,
      verdict,
      ...(verdict === "actions" ? { actions } : {}),
      customerHint: sanitizeCustomerHint(result.customerHint),
      ...(fenceTripped ? { reason: "fenced_url_refused" } : result.reason ? { reason: String(result.reason).slice(0, 300) } : {}),
    });
  });
}
