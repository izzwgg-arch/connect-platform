/**
 * THE RETURN HALF OF A SUPPORT TICKET.
 *
 *   Claude investigates  ->  technical report  ->  posted back here
 *        -> OpenAI rewrites it in plain English
 *        -> the safety gate decides whether a customer may see it
 *        -> the customer's widget shows a badge; they read it, test it, answer
 *
 * ⛔⛔ THE DIVISION THIS PRESERVES: Claude does the technical work and never
 * speaks to the customer; the customer-facing voice stays OpenAI's. That is
 * Izzy's design (plan doc §13-§19), and it is why the rewrite lives here rather
 * than being written by the agent that did the investigating.
 *
 * ⛔ `technicalReport` is OURS. It routinely names other tenants, file paths and
 * internal systems. It must never be returned by a customer-facing route — the
 * route layer selects fields explicitly for exactly this reason.
 */
import {
  reviewCustomerMessage,
  describeIssues,
  REWRITE_SYSTEM_PROMPT,
  type SafetyIssue,
} from "./customerUpdateSafety";

export type UpdateStatus = "draft" | "held" | "ready" | "delivered" | "answered";

/** Placeholder shapes that are SET in the environment and are not keys. */
const PLACEHOLDER = /^\(?paste|^your[_-]?|^changeme|^xxx+$|^</i;

/**
 * ⛔ `OPENAI_API_KEY` in the api container is literally "(paste..." — a
 * placeholder, verified 2026-08-31. The real key lives encrypted in AgentSecret,
 * written from the owner's Assistant settings page. Reading env first and
 * trusting it is how this silently never works. Store first, env only as a
 * fallback, and never a value that looks like a placeholder.
 */
export async function resolveOpenAiKey(db: any): Promise<string | null> {
  try {
    const sec = await import("@connect/security");
    if (sec.hasCredentialsMasterKey()) {
      const row = await db.agentSecret.findUnique({ where: { key: "openai_api_key" } });
      if (row?.valueEnc) {
        const v = String(sec.decryptJson<string>(row.valueEnc) ?? "").trim();
        if (v && !PLACEHOLDER.test(v)) return v;
      }
    }
  } catch {
    /* a missing master key or an absent row both mean "not configured" */
  }
  const env = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (env && !PLACEHOLDER.test(env)) return env;
  return null;
}

export type RewriteDeps = {
  db: any;
  /** Injected so the stress suite can drive every branch without a network. */
  callModel?: (args: { system: string; user: string; apiKey: string; model: string }) => Promise<string>;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
};

async function defaultCallModel(args: { system: string; user: string; apiKey: string; model: string }): Promise<string> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: args.apiKey });
  const res = await client.chat.completions.create({
    model: args.model,
    // Low temperature: this is a factual note to a customer, not a creative one.
    temperature: 0.2,
    max_tokens: 400,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  });
  return String(res.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Every live company on the platform, so the gate can refuse a message naming
 * one that is not this customer. ⛔ Without this list the cross-customer check
 * silently passes everything — the worst possible failure of this gate.
 */
async function liveTenantNames(db: any): Promise<string[]> {
  try {
    const rows = await db.tenant.findMany({
      where: { pbxRemovedAt: null },
      select: { name: true },
      take: 500,
    });
    return rows.map((r: any) => String(r.name ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Step 1 — the agent's report comes back from the watcher.
 *
 * Idempotent on `escalationId`: a retried post-back updates the row rather than
 * queueing a second message to the customer.
 *
 * ⛔ A platform alarm never becomes a customer update. Those escalations are our
 * own monitors talking to us; there is no person on the other end.
 */
export async function recordAgentReport(
  deps: RewriteDeps,
  input: { escalationId: string; ticketRef: string; report: string },
): Promise<{ ok: boolean; status?: UpdateStatus; reason?: string; updateId?: string }> {
  const { db } = deps;
  const esc = await db.agentEscalation.findUnique({
    where: { id: input.escalationId },
    select: { id: true, tenantId: true, tenantName: true, clientUserId: true, conversationId: true, userName: true },
  });
  if (!esc) return { ok: false, reason: "no such ticket" };

  // The same rule the watcher triages on, applied again at the point of writing
  // to a customer. Two gates, because this one is irreversible.
  if (!esc.clientUserId) {
    return { ok: false, reason: "platform alarm — there is no customer to tell" };
  }

  const existing = await db.supportUpdate.findUnique({ where: { escalationId: esc.id } });
  if (existing && (existing.status === "delivered" || existing.status === "answered")) {
    // ⛔ Never rewrite something the customer has already been shown.
    return { ok: true, status: existing.status as UpdateStatus, updateId: existing.id, reason: "already delivered" };
  }

  const row = await db.supportUpdate.upsert({
    where: { escalationId: esc.id },
    create: {
      escalationId: esc.id,
      tenantId: esc.tenantId,
      userId: esc.clientUserId,
      conversationId: esc.conversationId ?? null,
      ticketRef: input.ticketRef,
      technicalReport: input.report,
      status: "draft",
    },
    update: { technicalReport: input.report, status: "draft", heldReason: null, safetyIssues: undefined },
  });

  const out = await rewriteAndGate(deps, row.id);
  return { ok: true, status: out.status, updateId: row.id, reason: out.reason };
}

/**
 * Step 2 — OpenAI rewrites it, then the gate decides.
 *
 * ⛔ FAILS CLOSED IN EVERY DIRECTION. No key, a model error, an empty answer, or
 * anything the gate objects to all end in `held` — never in a message going out.
 * A held update waits for a person; nothing is lost, and nothing wrong is sent.
 */
export async function rewriteAndGate(
  deps: RewriteDeps,
  updateId: string,
): Promise<{ status: UpdateStatus; reason?: string }> {
  const { db, log } = deps;
  const row = await db.supportUpdate.findUnique({ where: { id: updateId } });
  if (!row) return { status: "held", reason: "the update disappeared" };

  const tenant = await db.tenant.findUnique({ where: { id: row.tenantId }, select: { name: true } }).catch(() => null);
  const tenantName = String(tenant?.name ?? "");

  const hold = async (reason: string, issues?: SafetyIssue[]) => {
    await db.supportUpdate.update({
      where: { id: row.id },
      data: { status: "held", heldReason: reason, safetyIssues: issues ? (issues as any) : undefined, plainMessage: null },
    });
    log?.warn?.({ updateId: row.id, ticket: row.ticketRef, reason }, "support-update: held for a human");
    return { status: "held" as const, reason };
  };

  const apiKey = await resolveOpenAiKey(db);
  if (!apiKey) return hold("No OpenAI key is configured, so the customer message could not be written.");

  let text = "";
  try {
    const call = deps.callModel ?? defaultCallModel;
    text = await call({
      system: REWRITE_SYSTEM_PROMPT,
      user: [
        `The customer's company: ${tenantName}`,
        `They reported: ${row.ticketRef}`,
        "",
        "Internal engineering report (NOT for the customer — rewrite it, never quote it):",
        row.technicalReport.slice(0, 12000),
      ].join("\n"),
      apiKey,
      model: process.env.SUPPORT_REWRITE_MODEL || "gpt-4o-mini",
    });
  } catch (err: any) {
    return hold(`The customer message could not be written: ${String(err?.message ?? err).slice(0, 200)}`);
  }

  if (!text.trim()) return hold("The rewrite came back empty.");

  const allTenantNames = await liveTenantNames(db);
  const verdict = reviewCustomerMessage({ text, tenantName, allTenantNames });
  if (!verdict.ok) return hold(describeIssues(verdict.issues), verdict.issues);

  await db.supportUpdate.update({
    where: { id: row.id },
    data: { status: "ready", plainMessage: text.trim(), heldReason: null, safetyIssues: undefined },
  });
  log?.info?.({ updateId: row.id, ticket: row.ticketRef }, "support-update: ready for the customer");
  return { status: "ready" };
}

/**
 * What the widget polls. ⛔ Selects fields explicitly — `technicalReport` must
 * never leave the building, and a `select: undefined` here would send it.
 */
export async function listUpdatesForUser(db: any, userId: string, tenantId: string) {
  const rows = await db.supportUpdate.findMany({
    where: { userId, tenantId, status: { in: ["ready", "delivered"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      ticketRef: true,
      plainMessage: true,
      status: true,
      createdAt: true,
      deliveredAt: true,
      readAt: true,
    },
  });
  return rows.filter((r: any) => typeof r.plainMessage === "string" && r.plainMessage.length > 0);
}

/** Stamped the first time the customer's widget actually served it to them. */
export async function markDelivered(db: any, ids: string[]) {
  if (!ids.length) return;
  await db.supportUpdate.updateMany({
    where: { id: { in: ids }, status: "ready" },
    data: { status: "delivered", deliveredAt: new Date() },
  });
}

/**
 * ── The follow-up loop for "No, still not right" ────────────────────────────
 *
 * ⛔⛔ THE BUG THIS CLOSES: the verdict route used to tell the customer "We've
 * reopened it and someone will pick it up" while `recordVerdict` only stamped
 * the row — no reopen, no re-queue, no notification. That is the exact
 * unearned-promise class the safety gate refuses, in our own route (found
 * 2026-09-01; two customers got it the day before). A not_fixed verdict now
 * CREATES a follow-up escalation, which the dispatcher texts to Izzy and the
 * watcher re-investigates — so "sent back to the team" is a fact.
 */
export const FOLLOWUP_PREFIX = "Customer says it is still not right";
/**
 * ⛔ THE LOOP CAP. A summary carrying this marker is for a HUMAN: the watcher's
 * triage skips it (it still reaches Izzy's phone via the dispatcher). Without
 * it, agent-investigates → customer says no → agent investigates the same thing
 * again would ping-pong forever.
 */
export const NEEDS_PERSON_MARKER = "[needs a person]";

export type FollowUpKind = "none" | "reinvestigate" | "needs_person";

/** PURE. Whether a verdict spawns a re-investigation, a hand-to-human, or nothing. */
export function decideVerdictFollowUp(input: {
  verdict: "fixed" | "not_fixed";
  escalationSummary: string;
}): FollowUpKind {
  if (input.verdict !== "not_fixed") return "none";
  const s = String(input.escalationSummary ?? "");
  // Already a follow-up (or already flagged for a person): one automatic
  // re-investigation is the budget. The second "still not right" goes to a human.
  if (s.startsWith(FOLLOWUP_PREFIX) || s.includes(NEEDS_PERSON_MARKER)) return "needs_person";
  return "reinvestigate";
}

/** ⛔ Plain ASCII, single line: one emoji flips the whole SMS to UCS-2. */
function asciiLine(s: string, max = 300): string {
  const flat = String(s).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}.` : flat;
}

/**
 * Creates the follow-up escalation. ⛔ Copies the ORIGINAL customer's identity
 * fields, so the watcher's classifier (which keys on userName) keeps it in the
 * customer lane, and the new ticket still names the right person.
 */
async function createFollowUpEscalation(
  db: any,
  args: { esc: any; ticketRef: string; note: string | null; kind: FollowUpKind },
): Promise<void> {
  const { esc, ticketRef, note, kind } = args;
  const said = note ? `Their note: "${String(note).slice(0, 400)}"` : "They left no note.";
  const marker = kind === "needs_person" ? `${NEEDS_PERSON_MARKER} ` : "";
  const secondLook =
    kind === "needs_person"
      ? "This has already had an automatic second look, so it now needs a person."
      : "Re-investigate it: read the previous report below, work out why the customer still sees the problem, and report again.";
  await db.agentEscalation.create({
    data: {
      conversationId: esc.conversationId ?? null,
      tenantId: esc.tenantId,
      tenantName: esc.tenantName,
      clientUserId: esc.clientUserId,
      userName: esc.userName,
      userEmail: esc.userEmail ?? null,
      requestSummary: `${marker}${FOLLOWUP_PREFIX} — ${ticketRef}: ${String(esc.requestSummary ?? "").slice(0, 400)}`,
      smsBody: asciiLine(
        `Loopcom: ${esc.tenantName} tested the fix for ${ticketRef} and says it is STILL NOT RIGHT. ${note ? "Note: " + note : ""}`,
      ),
      report: [
        `The customer tested the outcome of ticket ${ticketRef} and answered "No, still not right".`,
        said,
        "",
        secondLook,
        "",
        `Original request: ${String(esc.requestSummary ?? "")}`,
        "",
        "── The previous investigation's report ──",
        String(esc.previousReport ?? "(none recorded)").slice(0, 20000),
      ].join("\n"),
      // ⛔ Required column. `null` here is a PrismaClientValidationError that a
      // swallowed catch turns into an alarm that never fires.
      proposedFix: "",
      researchDegraded: false,
      status: "QUEUED",
    },
  });
}

/**
 * Step 3 — the customer tested it and said whether it worked.
 *
 * ⛔ Scoped to their own row by userId AND tenantId, and only from a state where
 * answering makes sense. A verdict on someone else's ticket must be impossible,
 * not merely unlikely.
 *
 * Returns `followUp` so the route can tell the customer THE TRUTH about what
 * happens next — "sent back to the team" only when a ticket really was.
 */
export async function recordVerdict(
  db: any,
  input: { updateId: string; userId: string; tenantId: string; verdict: "fixed" | "not_fixed"; note?: string },
  log?: { warn?: (o: any, m?: string) => void },
): Promise<{ ok: boolean; reason?: string; followUp?: FollowUpKind | "failed" }> {
  const res = await db.supportUpdate.updateMany({
    where: {
      id: input.updateId,
      userId: input.userId,
      tenantId: input.tenantId,
      status: { in: ["ready", "delivered"] },
    },
    data: {
      status: "answered",
      verdict: input.verdict,
      customerNote: input.note ? String(input.note).slice(0, 2000) : null,
      answeredAt: new Date(),
      readAt: new Date(),
    },
  });
  if (res.count === 0) return { ok: false, reason: "that update is not yours, or it has already been answered" };
  if (input.verdict !== "not_fixed") return { ok: true, followUp: "none" };

  // ⛔ FAILS SOFT past this point: the verdict is recorded either way, and the
  // route's wording degrades honestly when no follow-up could be filed.
  try {
    const row = await db.supportUpdate.findUnique({
      where: { id: input.updateId },
      select: { escalationId: true, ticketRef: true, technicalReport: true },
    });
    const esc = row?.escalationId
      ? await db.agentEscalation.findUnique({
          where: { id: row.escalationId },
          select: {
            id: true, conversationId: true, tenantId: true, tenantName: true,
            clientUserId: true, userName: true, userEmail: true, requestSummary: true,
          },
        })
      : null;
    if (!esc) return { ok: true, followUp: "failed" };
    const kind = decideVerdictFollowUp({ verdict: "not_fixed", escalationSummary: esc.requestSummary });
    await createFollowUpEscalation(db, {
      esc: { ...esc, previousReport: row?.technicalReport ?? null },
      ticketRef: String(row?.ticketRef ?? ""),
      note: input.note ? String(input.note).slice(0, 2000) : null,
      kind,
    });
    return { ok: true, followUp: kind };
  } catch (err: any) {
    log?.warn?.({ err: String(err?.message ?? err).slice(0, 200), updateId: input.updateId },
      "support-update: verdict recorded but the follow-up could not be filed");
    return { ok: true, followUp: "failed" };
  }
}
