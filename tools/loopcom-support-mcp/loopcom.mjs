/**
 * The LoopCom side of the support-ticket MCP server.
 *
 * ⛔ ONE WRITE, AND IT CANNOT REACH A CUSTOMER (v2, 2026-08-31).
 * Everything here reads, except `postAgentReport`, which hands the finished
 * investigation back to LoopCom. That is not a message to a customer: the api
 * gives it to OpenAI to rewrite in plain English and then runs a safety gate
 * that decides whether a person may see it. Claude never writes the words a
 * customer reads, and this client cannot make one appear — it has no route to
 * the customer at all.
 *
 * Izzy's design is that the OpenAI agent inside LoopCom keeps the customer
 * relationship and does all the talking; Claude does the technical work.
 * Adding a customer-facing write here is still a separate, deliberate decision
 * — not a convenience to slip in later.
 *
 * Every call goes through the EXISTING /admin/support/* routes, which are
 * SUPER_ADMIN-gated and audited server-side. This server adds no gate of its
 * own and must not: a second opinion about who may read a ticket is exactly
 * the drift this codebase keeps paying for.
 */

const DEFAULT_BASE = "https://app.loopcom.net/api";

export class LoopcomError extends Error {
  constructor(status, body, url) {
    super(`LoopCom ${status} on ${url}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export function readConfig(env = process.env) {
  const token = (env.LOOPCOM_TOKEN || "").trim();
  const base = (env.LOOPCOM_API_BASE || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return { token, base, configured: token.length > 0 };
}

/**
 * ⛔ Failure direction: a missing token must produce a sentence a person can act
 * on, not a 401 that reads like the platform is down. This tool is used when
 * something is already going wrong; an unclear error costs the whole session.
 */
export function configurationProblem(cfg) {
  if (!cfg.configured) {
    return [
      "LOOPCOM_TOKEN is not set, so I cannot read support tickets.",
      "Set it to a SUPER_ADMIN portal token in the MCP server's env and restart Claude Code.",
    ].join(" ");
  }
  return null;
}

async function call(cfg, path, { timeoutMs = 30_000 } = {}) {
  const url = `${cfg.base}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new LoopcomError(res.status, body, path);
    return body;
  } catch (err) {
    if (err instanceof LoopcomError) throw err;
    if (err?.name === "AbortError") throw new Error(`LoopCom did not answer within ${Math.round(timeoutMs / 1000)}s on ${path}.`);
    throw new Error(`Could not reach LoopCom at ${cfg.base} — ${String(err?.message || err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Tickets, newest first. `status` mirrors the console's own filter. */
export async function listTickets(cfg, { status = "all", take = 20, tenantId } = {}) {
  const q = new URLSearchParams();
  if (status && status !== "all") q.set("status", status);
  if (tenantId) q.set("tenantId", tenantId);
  q.set("take", String(Math.max(1, Math.min(50, Number(take) || 20))));
  return call(cfg, `/admin/support/escalations?${q.toString()}`);
}

/** One ticket in full: the report, the proposed fix, and the customer context. */
export async function getTicket(cfg, id) {
  return call(cfg, `/admin/support/escalations/${encodeURIComponent(id)}`);
}

/** The whole account behind a ticket — numbers, extensions, billing, calls. */
export async function getCustomer(cfg, tenantId) {
  return call(cfg, `/admin/support/customers/${encodeURIComponent(tenantId)}`);
}

/** The chat the ticket came out of — what the customer actually said. */
export async function getConversation(cfg, conversationId) {
  return call(cfg, `/admin/support/conversations/${encodeURIComponent(conversationId)}`);
}

/**
 * ⛔ A reference (e.g. Q2FJRK) is what Izzy sees in the SMS, so it is what he
 * will type. Resolve it to a row id rather than making him find a cuid.
 */
export async function resolveReference(cfg, refOrId) {
  const needle = String(refOrId || "").trim();
  if (!needle) throw new Error("Give me a ticket reference (like Q2FJRK) or its id.");
  if (needle.length > 20) return needle; // already a cuid
  const list = await listTickets(cfg, { status: "all", take: 50 });
  const rows = Array.isArray(list?.escalations) ? list.escalations : [];
  const hit = rows.find((r) => String(r.reference || "").toUpperCase() === needle.toUpperCase());
  if (!hit) throw new Error(`No open ticket with reference ${needle} in the last 50. Use list_support_tickets to see what is there.`);
  return hit.id;
}

/**
 * Hand the finished investigation back to LoopCom.
 *
 * ⛔ This does NOT message the customer, and it cannot. The api rewrites it
 * through OpenAI and runs a safety gate; a report that mentions another
 * customer, an internal system or a secret is HELD there for a person, and the
 * customer sees nothing. All this call decides is that we finished looking.
 *
 * ⛔ Idempotent server-side on the escalation, so a retry can never queue a
 * second message. It still fails soft: losing the post-back costs the customer
 * their update, never the report, which is already on disk.
 */
export async function postAgentReport(cfg, reference, report) {
  const url = `${cfg.base}/admin/support/escalations/${encodeURIComponent(reference)}/agent-report`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ report: String(report ?? "") }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!res.ok) throw new LoopcomError(res.status, body, url);
    return body;
  } finally {
    clearTimeout(timer);
  }
}
