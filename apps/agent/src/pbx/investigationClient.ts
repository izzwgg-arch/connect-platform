/**
 * Client for the api's read-only investigation workspace
 * (POST /internal/agent/investigate, shared-secret header, fail-closed).
 *
 * ⛔ THIS IS THE DIAGNOSIS DOOR, AND IT CAN ONLY EVER READ. The api side runs
 * every statement inside a Postgres READ ONLY transaction (or, for the PBX, as
 * the SELECT-only `connect_read` credential), refuses anything that is not a
 * single read, and audits every call — including the refusals. Nothing here
 * needs to re-implement any of that, and nothing here should try to soften it.
 *
 * ⛔ A REFUSAL IS DATA, NOT AN ERROR. When the guard turns a statement down the
 * api answers 200 with `ok:false, refusedByGuard:true` and a plain-English
 * reason. That reason must reach the model unchanged so it can adjust — turning
 * it into a thrown "investigation_failed" would hide "you tried to write" behind
 * a generic error and the model would simply try again. Only a transport fault
 * or a missing secret throws.
 */
import { postInternalApi } from "./internalApiPost";

export interface InvestigationQuery {
  /** The tenant this question is being asked ON BEHALF OF — recorded in the
   *  audit row. ⛔ It is NOT a filter: the door is deliberately not
   *  tenant-scoped, because "is this happening to anyone else?" is a question a
   *  diagnostician has to be able to ask. It is bound from the verified server
   *  context, never from model output. */
  tenantId: string;
  source: "connect" | "pbx";
  sql: string;
  limit?: number;
  /** Why the model is asking. Lands in the audit row so a person reading the
   *  trail later sees the reasoning, not just the SQL. Never control flow. */
  purpose?: string;
}

export interface InvestigationClient {
  query(q: InvestigationQuery): Promise<any>;
}

export function makeInvestigationClient(
  opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {},
): InvestigationClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  // Longer than the other doors on purpose: a diagnostic read across 126k CDR
  // rows is legitimately slower than flipping a feature flag. The api applies
  // its own statement timeout, so this is a ceiling, not a policy.
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    async query(q: InvestigationQuery): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("investigation_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await postInternalApi({
        url: `${baseUrl}/internal/agent/investigate`,
        secret,
        body: {
          tenantId: q.tenantId,
          source: q.source,
          sql: q.sql,
          ...(q.limit != null ? { limit: q.limit } : {}),
          ...(q.purpose ? { purpose: q.purpose } : {}),
        },
        timeoutMs,
      });
      const json: any = await resp.json().catch(() => ({}));
      // 200 with ok:false is a guard refusal or a SQL error — both are answers
      // the model must see. 4xx/5xx are OUR problem and are worth throwing on,
      // except 429, which is the api telling the model it is looping.
      if (resp.status === 429) {
        return { ok: false, rateLimited: true, error: json?.message ?? "Too many investigation queries in a minute." };
      }
      if (!resp.ok && resp.status !== 200) {
        throw new Error(`investigation_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
