/**
 * Read-only contacts door for the assistant — "who is in my contacts",
 * "what's the number for X". Trainer red rows 12/25: the assistant answered
 * "Cannot view contacts" while the tenant's contact book sat in the Contact
 * table it had no way to reach.
 *
 * Same contract as account-setup-info:
 *  - in-handler shared-secret auth (AGENT_INTERNAL_SECRET), fail-closed;
 *  - ⛔ the path MUST also be in jwtPublicRouteBypass.ts or the global JWT
 *    hook 401s it before this auth ever runs — that exact miss left the
 *    account-setup door dead for six days (a 401 means you never reached the
 *    route; a bad secret answers 403);
 *  - tenant comes from the request the AGENT authenticated, never from
 *    anything the model invents; results are scoped to that tenant only.
 *
 * READ-ONLY by design. Adding or editing contacts stays with the human team /
 * portal — a status-shaped feature must never grow a write path by accident
 * (the DND status-query lesson).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentMohSecretOk } from "../agentMohOverride";
import { db } from "@connect/db";

export type AgentContactsInfo = {
  total: number;
  /** Capped list — `total` says whether there are more than shown. */
  contacts: Array<{
    name: string;
    company: string | null;
    /** Primary number first, formatted for reading aloud. */
    phones: string[];
    favorite: boolean;
  }>;
};

function fmtPhone(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : String(raw || "");
}

const MAX_RESULTS = 25;

export async function loadAgentContactsInfo(tenantId: string, search?: string): Promise<AgentContactsInfo> {
  const q = String(search ?? "").trim().slice(0, 80);
  const where: any = { tenantId, active: true, archivedAt: null };
  if (q) {
    where.OR = [
      { displayName: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
      { phones: { some: { numberNormalized: { contains: q.replace(/\D/g, "") || q } } } },
    ];
  }
  const [total, rows] = await Promise.all([
    (db as any).contact.count({ where }),
    (db as any).contact.findMany({
      where,
      select: {
        displayName: true,
        company: true,
        favorite: true,
        phones: { select: { numberRaw: true, isPrimary: true }, orderBy: { isPrimary: "desc" }, take: 3 },
      },
      orderBy: [{ favorite: "desc" }, { displayName: "asc" }],
      take: MAX_RESULTS,
    }),
  ]);
  return {
    total,
    contacts: rows.map((c: any) => ({
      name: c.displayName,
      company: c.company ?? null,
      phones: (c.phones ?? []).map((p: any) => fmtPhone(p.numberRaw)),
      favorite: !!c.favorite,
    })),
  };
}

export function registerAgentContactsInfoRoute(app: FastifyInstance) {
  app.post("/internal/agent/contacts-info", async (req, reply) => {
    // Fail closed: an unset secret must not become an open door. Constant-time compare.
    if (!agentMohSecretOk(req.headers["x-agent-internal-secret"], process.env.AGENT_INTERNAL_SECRET)) {
      return reply.code(403).send({ ok: false, error: "forbidden" });
    }
    const body = z
      .object({ tenantId: z.string().min(1), search: z.string().max(80).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: "bad_request" });
    try {
      return { ok: true, info: await loadAgentContactsInfo(body.data.tenantId, body.data.search) };
    } catch (err) {
      req.log?.error({ err, tenantId: body.data.tenantId }, "agent_contacts_info_failed");
      return reply.code(500).send({ ok: false, error: "lookup_failed" });
    }
  });
}
