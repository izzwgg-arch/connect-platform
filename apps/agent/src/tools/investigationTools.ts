/**
 * The DIAGNOSIS tool — the agent's read-only workspace on both production
 * databases, via the api's `/internal/agent/investigate` door.
 *
 * ⛔⛔ WHY THIS EXISTS, AND WHY IT IS ONE TOOL RATHER THAN TWENTY:
 * diagnosis is generic. The same five verbs — query, count, list, describe,
 * compare — pointed somewhere new answer almost any "why is this broken?"
 * question. The old agent had ten hardcoded questions instead of the ability to
 * ask its own, and that, not the model, was the limit. Only REPAIR is
 * scenario-specific, and repair lives behind the password-gated confirmation
 * flow, not here.
 *
 * ⛔ `minRole: "staff"` — SUPER_ADMIN (Connect staff) ONLY, never "customer" and
 * never "internal". The door is deliberately NOT tenant-scoped: a query cannot be
 * confined to one tenant without parsing SQL, and "is this happening to anyone
 * else?" is a question a diagnostician must be able to ask. That is exactly why
 * it is staff-side only. ⛔ It was "internal" until 2026-08-19, but "internal"
 * means admin MODE, which since 2026-08-06 includes every TENANT_ADMIN — so a
 * customer's own admin could read across all tenants. It is now the "staff" tier
 * (isPlatformStaff / SUPER_ADMIN). A customer OR a tenant admin never learns this
 * tool exists (`toolsForRole` filters it out).
 *
 * ⛔ It CANNOT WRITE, and not because the model was told not to: the api runs
 * every statement in a Postgres READ ONLY transaction, the PBX credential holds
 * SELECT and nothing else, a text guard accepts only a single read, and every
 * call — including every refusal — is audited. Four layers, none of which is
 * "the prompt asked nicely".
 */
import type { InvestigationClient } from "../pbx/investigationClient";
import type { ToolContext, ToolSpec } from "./toolRegistry";

export interface InvestigationToolDeps {
  investigation: InvestigationClient;
}

/** Bound so one runaway conversation cannot walk the whole database. */
const MAX_ROWS = 50;

export function buildInvestigationTools(deps: InvestigationToolDeps): ToolSpec[] {
  return [
    {
      name: "investigate",
      description:
        [
          "Run ONE read-only SQL query against production to find out what is actually true. Use this before stating any fact about an account you have not read — it is what turns a guess into a finding.",
          "",
          'source "connect" = Connect\'s own Postgres (tenants, users, extensions, calls, voicemail, invoices, escalations, audit). Quote camelCase identifiers: select * from "Tenant".',
          'source "pbx" = the phone system\'s MySQL (ombutel: ombu_tenants, ombu_devices, ombu_extensions, ombu_inbound_routes, ombu_queues, ombu_ivrs; asterisk: queues_log).',
          "",
          "SELECT / WITH / SHOW / DESCRIBE / EXPLAIN only — anything that changes data is refused, and the refusal explains itself so you can adjust. Ask one narrow question at a time and build on the answer; at most 50 rows come back.",
          "",
          "Set `purpose` to why you are asking, in a few plain words — a person reads that trail later.",
          "",
          "⛔ EVIDENCE RULE: a finding may only be reported as a finding if a query you actually ran returned it. If you did not read it here, say you did not check — never present a plausible guess in the same voice as a measurement.",
        ].join("\n"),
      // ⛔ STAFF, not "internal". This tool is deliberately NOT tenant-scoped
      // (it runs raw SQL across the whole platform), so it must reach ONLY
      // Connect staff (SUPER_ADMIN). "internal" now includes every TENANT_ADMIN
      // (admin mode, 2026-08-06); exposing an un-scoped cross-platform read to a
      // customer's own admin is a cross-tenant leak. See toolRegistry ToolRole.
      minRole: "staff",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["connect", "pbx"], description: 'Which database: "connect" or "pbx".' },
          sql: { type: "string", description: "One read-only SQL statement." },
          purpose: { type: "string", description: "Why you are asking, in a few plain words. Recorded in the audit trail." },
          limit: { type: "number", description: `Max rows to return. Default 50, max ${MAX_ROWS}.` },
        },
        required: ["source", "sql"],
        additionalProperties: false,
      },
      run: async (args, ctx: ToolContext) => {
        const source = args.source === "pbx" ? "pbx" : "connect";
        const sql = typeof args.sql === "string" ? args.sql.trim() : "";
        if (!sql) return { ok: false, error: "No SQL was supplied." };
        const rawLimit = Number(args.limit);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_ROWS) : undefined;
        return deps.investigation.query({
          // ⛔ Bound from the SERVER-VERIFIED context. The registry already
          // strips any tenant the model invents; this is the second lock.
          tenantId: ctx.tenantId,
          source,
          sql,
          ...(limit != null ? { limit } : {}),
          ...(typeof args.purpose === "string" && args.purpose.trim()
            ? { purpose: args.purpose.trim().slice(0, 300) }
            : {}),
        });
      },
    },
  ];
}
