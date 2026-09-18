import { resolveTxt } from "node:dns/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db.js";
import { requireActor, requireStaff } from "../auth/actor.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { notify } from "../lib/notify.js";
import { requireOrgPermission } from "../organizations/permissions.js";
import { domainInstructions, txtRecordsProveDomain } from "../organizations/policy.js";
import { notifyOrgHolders } from "../organizations/service.js";

const ORG_KINDS = ["BUSINESS", "LICENSE", "INSURANCE", "DOMAIN"] as const;
const PERSON_KINDS = ["IDENTITY", "LICENSE"] as const;

/** loopcom-verify=<orgId> found in the domain's live TXT records? Network failures read as "not found yet". */
async function checkDomainTxt(domain: string, organizationId: string): Promise<boolean> {
  try {
    const records = await resolveTxt(domain);
    return txtRecordsProveDomain(records, organizationId);
  } catch {
    return false;
  }
}

async function runDomainCheck(db: Db, organizationId: string, domain: string) {
  const proven = await checkDomainTxt(domain, organizationId);
  const existing = await db.verification.findFirst({ where: { organizationId, kind: "DOMAIN" } });
  const data = proven
    ? { status: "VERIFIED" as const, reviewedAt: new Date(), evidence: { domain } }
    : { status: "PENDING" as const, evidence: { domain } };
  const row = existing
    ? await db.verification.update({ where: { id: existing.id }, data })
    : await db.verification.create({ data: { organizationId, kind: "DOMAIN", ...data } });
  if (proven) await db.organization.update({ where: { id: organizationId }, data: { domainVerifiedAt: new Date() } });
  return { row, proven };
}

export function registerVerificationRoutes(app: FastifyInstance, db: Db) {
  // ── organization verifications ──────────────────────────────────────────
  app.get("/organizations/:id/verifications", async (req) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.verify");
    const org = await db.organization.findUniqueOrThrow({ where: { id }, select: { domain: true } });
    const rows = await db.verification.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    return {
      verifications: rows.map((v) => ({
        id: v.id,
        kind: v.kind,
        status: v.status,
        note: v.note,
        expiresAt: v.expiresAt,
        createdAt: v.createdAt,
        reviewedAt: v.reviewedAt,
        instructions: v.kind === "DOMAIN" && v.status === "PENDING" && org.domain ? domainInstructions(org.domain, id) : null,
      })),
    };
  });

  app.post("/organizations/:id/verifications", async (req, reply) => {
    const actor = requireActor(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.verify");
    const body = z.object({ kind: z.enum(ORG_KINDS), evidence: z.record(z.unknown()).optional(), assetId: z.string().optional() }).parse(req.body);
    const org = await db.organization.findUniqueOrThrow({ where: { id }, select: { domain: true } });

    if (body.kind === "DOMAIN") {
      if (!org.domain) throw badRequest("no_domain", "Set the company's domain in Page settings before verifying it.");
      const { row, proven } = await runDomainCheck(db, id, org.domain);
      await audit(db, { actorId: actor.personId, action: "org.verification_requested", targetType: "Verification", targetId: row.id, organizationId: id, after: { kind: "DOMAIN", status: row.status } });
      reply.status(proven ? 200 : 202);
      return proven ? { status: "VERIFIED", verification: row } : { status: "PENDING", instructions: domainInstructions(org.domain, id), verification: row };
    }

    const row = await db.verification.create({ data: { organizationId: id, kind: body.kind, status: "PENDING", evidence: body.evidence as object | undefined, assetId: body.assetId ?? null } });
    await audit(db, { actorId: actor.personId, action: "org.verification_requested", targetType: "Verification", targetId: row.id, organizationId: id, after: { kind: body.kind } });
    reply.status(201);
    return row;
  });

  app.post("/organizations/:id/verifications/:vid/recheck", async (req) => {
    const actor = requireActor(req);
    const { id, vid } = z.object({ id: z.string(), vid: z.string() }).parse(req.params);
    await requireOrgPermission(db, actor, id, "org.verify");
    const existing = await db.verification.findFirst({ where: { id: vid, organizationId: id } });
    if (!existing) throw notFound("That verification");
    if (existing.kind !== "DOMAIN") throw badRequest("not_recheckable", "Only a domain verification can be rechecked automatically.");
    const org = await db.organization.findUniqueOrThrow({ where: { id }, select: { domain: true } });
    if (!org.domain) throw badRequest("no_domain", "This company has no domain set anymore.");
    const { row, proven } = await runDomainCheck(db, id, org.domain);
    await audit(db, { actorId: actor.personId, action: "org.verification_rechecked", targetType: "Verification", targetId: row.id, organizationId: id, after: { status: row.status } });
    return proven ? { status: "VERIFIED", verification: row } : { status: "PENDING", instructions: domainInstructions(org.domain, id), verification: row };
  });

  // ── person verifications ─────────────────────────────────────────────────
  app.get("/me/verifications", async (req) => {
    const actor = requireActor(req);
    return { verifications: await db.verification.findMany({ where: { personId: actor.personId }, orderBy: { createdAt: "desc" } }) };
  });

  app.post("/me/verifications", async (req, reply) => {
    const actor = requireActor(req);
    const body = z.object({ kind: z.enum(PERSON_KINDS), evidence: z.record(z.unknown()).optional(), assetId: z.string().optional() }).parse(req.body);
    const row = await db.verification.create({ data: { personId: actor.personId, kind: body.kind, status: "PENDING", evidence: body.evidence as object | undefined, assetId: body.assetId ?? null } });
    await audit(db, { actorId: actor.personId, action: "person.verification_requested", targetType: "Verification", targetId: row.id, after: { kind: body.kind } });
    reply.status(201);
    return row;
  });

  // ── staff review ─────────────────────────────────────────────────────────
  app.get("/admin/verifications", async (req) => {
    requireStaff(req);
    const { status } = z.object({ status: z.enum(["PENDING", "VERIFIED", "REJECTED", "EXPIRED"]).optional() }).parse(req.query);
    const rows = await db.verification.findMany({ where: status ? { status } : {}, orderBy: { createdAt: "desc" }, take: 100 });
    return { verifications: rows };
  });

  app.post("/admin/verifications/:id/decide", async (req) => {
    const staff = requireStaff(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ status: z.enum(["VERIFIED", "REJECTED"]), note: z.string().trim().max(500).optional() }).parse(req.body);
    const existing = await db.verification.findUnique({ where: { id } });
    if (!existing) throw notFound("That verification");
    const row = await db.verification.update({ where: { id }, data: { status: body.status, note: body.note ?? null, reviewedById: staff.personId, reviewedAt: new Date() } });
    if (row.organizationId) {
      const org = await db.organization.findUnique({ where: { id: row.organizationId }, select: { displayName: true } });
      await notifyOrgHolders(db, row.organizationId, ["OWNER"], {
        kind: "org.verification",
        title: `${row.kind} verification ${body.status === "VERIFIED" ? "approved" : "rejected"}${org ? ` for ${org.displayName}` : ""}`,
        body: body.note ?? undefined,
        href: "/company/admin",
        actorId: staff.personId,
      });
    } else if (row.personId) {
      await notify(db, { personId: row.personId, kind: "org.verification", title: `Your ${row.kind.toLowerCase()} verification was ${body.status === "VERIFIED" ? "approved" : "rejected"}`, body: body.note ?? null, href: "/settings", actorId: staff.personId });
    }
    await audit(db, { actorId: staff.personId, action: "verification.decided", targetType: "Verification", targetId: id, organizationId: row.organizationId, before: { status: existing.status }, after: { status: row.status, note: row.note } });
    return row;
  });
}
