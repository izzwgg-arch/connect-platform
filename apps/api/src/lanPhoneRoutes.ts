/**
 * Desk phones discovered on a customer's own network by the Windows app.
 *
 * The point of this is one comparison nobody has been able to make: what the
 * PBX record SAYS a phone's MAC is, against what the phone's MAC actually is.
 * When those disagree, VitalPBX rewrites a config file that no handset ever
 * downloads, the panel looks correct, the nginx log shows a clean 200 for a
 * different filename, and the phone serves a weeks-old config. There is no
 * error anywhere in that chain — which is why it went unnoticed for seven
 * weeks on Create A Box ext 102.
 *
 * ⛔ SCANNING IS AN EXPLICIT ACTION, NEVER BACKGROUND. The Windows app must
 * only scan when a person asks it to. A support tool that quietly inventories a
 * customer's network on a timer is something else entirely, and the difference
 * is consent.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { userHasActionPermission } from "./permissionGates";
import { formatMac, normalizeIpv4, normalizeMac, vendorForMac } from "./lanPhoneVendors";
import { comparePhones, listPbxProvisionedPhones, resolvePbxTenantNumber } from "./pbxPhoneProvisioning";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type LanPhoneDeps = {
  audit: (params: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    targetUserId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
};

const getUser = (req: any): JwtUser => req.user as JwtUser;

const startRunBody = z.object({
  deviceLabel: z.string().max(200).optional(),
  subnet: z.string().max(64).optional(),
});

const reportBody = z.object({
  outcome: z.enum(["ok", "partial", "failed"]),
  note: z.string().max(500).optional(),
  hostsSeen: z.number().int().min(0).max(100_000).optional(),
  phones: z
    .array(
      z.object({
        macAddress: z.string().min(1),
        ipAddress: z.string().optional(),
        model: z.string().max(120).optional(),
        firmware: z.string().max(120).optional(),
        hostname: z.string().max(200).optional(),
        provisioningUrl: z.string().max(500).optional(),
        vendor: z.string().max(80).optional(),
      }),
    )
    .max(2000),
});

function phoneView(row: any) {
  return {
    id: row.id,
    mac: formatMac(row.macAddress),
    macRaw: row.macAddress,
    ip: row.ipAddress,
    vendor: row.vendor,
    model: row.model,
    firmware: row.firmware,
    hostname: row.hostname,
    provisioningUrl: row.provisioningUrl,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function runView(row: any) {
  return {
    id: row.id,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    outcome: row.outcome,
    note: row.note,
    subnet: row.subnet,
    deviceLabel: row.deviceLabel,
    hostsSeen: row.hostsSeen,
    phonesFound: row.phonesFound,
    reportedByUserId: row.reportedByUserId,
  };
}

export async function registerLanPhoneRoutes(app: FastifyInstance, deps: LanPhoneDeps) {
  /**
   * The Windows app says "I am about to scan". Creating the run up front is
   * what makes a scan that dies halfway visible — otherwise a crashed scan is
   * indistinguishable from one that was never started.
   */
  app.post("/lan-phones/runs", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = startRunBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const run = await db.lanDiscoveryRun.create({
      data: {
        tenantId: user.tenantId,
        reportedByUserId: user.sub,
        deviceLabel: parsed.data.deviceLabel || null,
        subnet: parsed.data.subnet || null,
      },
    });

    return reply.send({ ok: true, run: runView(run) });
  });

  /**
   * The findings.
   *
   * ⛔ A phone that fails MAC validation is DROPPED and counted, never stored.
   * A row with a malformed MAC can never match a PBX record, so storing it
   * would add a phone to the inventory that is guaranteed to look like a
   * mismatch forever.
   */
  app.post("/lan-phones/runs/:id/report", async (req: any, reply: any) => {
    const user = getUser(req);
    const parsed = reportBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const run = await db.lanDiscoveryRun.findUnique({ where: { id: String(req.params.id) } });
    if (!run) return reply.status(404).send({ error: "run_not_found" });
    // A run belongs to the machine that started it.
    if (run.reportedByUserId !== user.sub || run.tenantId !== user.tenantId) {
      return reply.status(403).send({ error: "not_your_run" });
    }
    if (run.finishedAt) return reply.status(409).send({ error: "run_already_reported" });

    const now = new Date();
    let stored = 0;
    let rejected = 0;

    for (const phone of parsed.data.phones) {
      const mac = normalizeMac(phone.macAddress);
      if (!mac) {
        rejected += 1;
        continue;
      }
      const vendor = vendorForMac(mac) || phone.vendor?.slice(0, 80) || null;
      const ip = normalizeIpv4(phone.ipAddress);

      await db.lanDiscoveredPhone.upsert({
        where: { tenantId_macAddress: { tenantId: run.tenantId, macAddress: mac } },
        create: {
          tenantId: run.tenantId,
          macAddress: mac,
          ipAddress: ip,
          vendor,
          model: phone.model || null,
          firmware: phone.firmware || null,
          hostname: phone.hostname || null,
          provisioningUrl: phone.provisioningUrl || null,
          lastRunId: run.id,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: {
          // Only overwrite with something we actually learned — a scan that
          // could not read the model must not erase a model read last time.
          ipAddress: ip ?? undefined,
          vendor: vendor ?? undefined,
          model: phone.model || undefined,
          firmware: phone.firmware || undefined,
          hostname: phone.hostname || undefined,
          provisioningUrl: phone.provisioningUrl || undefined,
          lastRunId: run.id,
          lastSeenAt: now,
        },
      });
      stored += 1;
    }

    const note = [parsed.data.note, rejected > 0 ? `${rejected} device(s) had an unreadable MAC` : null]
      .filter(Boolean)
      .join(" — ") || null;

    await db.lanDiscoveryRun.update({
      where: { id: run.id },
      data: {
        finishedAt: now,
        outcome: parsed.data.outcome,
        note,
        hostsSeen: parsed.data.hostsSeen ?? 0,
        phonesFound: stored,
      },
    });

    await deps.audit({
      tenantId: run.tenantId,
      action: "LAN_PHONE_SCAN_REPORTED",
      entityType: "LanDiscoveryRun",
      entityId: run.id,
      actorUserId: user.sub,
      metadata: { outcome: parsed.data.outcome, stored, rejected, hostsSeen: parsed.data.hostsSeen ?? 0 },
    });

    return reply.send({ ok: true, stored, rejected });
  });

  /**
   * The inventory.
   *
   * ⛔ Always reports whether a scan has EVER run. An empty list rendered as
   * "this office has no phones" when the truth is "nobody has ever scanned" is
   * the same failure as a queue report showing zero calls because a database
   * grant was missing — confidently wrong beats obviously broken every time.
   */
  app.get("/lan-phones", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!(await userHasActionPermission(user, "can_view_lan_phones"))) {
      return reply.status(403).send({ error: "forbidden" });
    }

    const isSuper = String(user.role) === "SUPER_ADMIN";
    const requestedTenant = String(req.query?.tenantId || "").trim();
    const tenantId = isSuper && requestedTenant ? requestedTenant : user.tenantId;

    const [phones, lastRun, runCount] = await Promise.all([
      db.lanDiscoveredPhone.findMany({
        where: { tenantId },
        orderBy: [{ vendor: "asc" }, { lastSeenAt: "desc" }],
        take: 500,
      }),
      db.lanDiscoveryRun.findFirst({
        where: { tenantId },
        orderBy: { startedAt: "desc" },
      }),
      db.lanDiscoveryRun.count({ where: { tenantId } }),
    ]);

    return reply.send({
      tenantId,
      phones: phones.map(phoneView),
      // The three facts that make an empty list interpretable.
      everScanned: runCount > 0,
      scanCount: runCount,
      lastRun: lastRun ? runView(lastRun) : null,
    });
  });

  /**
   * ⛔ THE PAYOFF: what the phone system BELIEVES each phone's hardware ID is,
   * against what is actually on the network.
   *
   * When those disagree, VitalPBX rewrites a settings file that no handset ever
   * downloads — the panel looks right, the log shows a clean 200 for a
   * different filename, and the phone serves a config from weeks ago. There is
   * no error anywhere in that chain, which is why Create A Box ext 102 went
   * seven weeks unnoticed. This route is the check that was missing.
   *
   * ⛔ Never answers with an empty list when something is unavailable. A blank
   * comparison reads as "everything is fine", which is the opposite of the
   * truth when the real answer is "I could not look".
   */
  app.get("/lan-phones/comparison", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!(await userHasActionPermission(user, "can_view_lan_phones"))) {
      return reply.status(403).send({ error: "forbidden" });
    }

    const isSuper = String(user.role) === "SUPER_ADMIN";
    const requestedTenant = String(req.query?.tenantId || "").trim();
    const tenantId = isSuper && requestedTenant ? requestedTenant : user.tenantId;

    const [link, phones, runCount] = await Promise.all([
      db.tenantPbxLink.findUnique({ where: { tenantId } }),
      db.lanDiscoveredPhone.findMany({ where: { tenantId }, take: 500 }),
      db.lanDiscoveryRun.count({ where: { tenantId } }),
    ]);

    if (!link?.pbxInstanceId) {
      return reply.send({
        available: false,
        reason: "no_pbx_link",
        message: "This company is not linked to the phone system, so there is nothing to compare against.",
      });
    }

    const instance = await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } });
    // ⛔ resolvePbxTenantNumber, never Number(pbxTenantCode || …): the code is
    // "T2", Number("T2") is NaN, and the old fallthrough passed NO tenant filter
    // — a per-customer comparison quietly running over EVERY tenant's phones.
    const pbxTenant = resolvePbxTenantNumber(link);
    if (!pbxTenant) {
      return reply.send({
        available: false,
        reason: "no_pbx_link",
        message: "This company's phone-system link is missing its tenant number, so there is nothing to compare against.",
      });
    }

    const provisioned = await listPbxProvisionedPhones(
      (instance as any)?.ombuMysqlUrlEncrypted,
      { pbxTenant },
    );

    if (!provisioned.available) {
      // Prints the exact fix on screen rather than a slug, the same way the
      // queue reports do when their grant is missing.
      return reply.send({
        available: false,
        reason: provisioned.reason,
        message:
          provisioned.reason === "provisioning_access_denied"
            ? "Connect cannot read the phone system's provisioning records yet. One database permission is needed."
            : "The phone system could not be reached, so there is nothing to compare against.",
        detail: provisioned.detail,
        grantSql: provisioned.grantSql,
      });
    }

    const comparison = comparePhones({
      pbxPhones: provisioned.phones,
      networkPhones: phones.map((p) => ({ mac: p.macAddress, ip: p.ipAddress, vendor: p.vendor })),
      networkScanned: runCount > 0,
    });

    return reply.send({
      available: true,
      tenantId,
      networkScanned: runCount > 0,
      ...comparison,
    });
  });

  /** Scan history, so "when did we last look" has an answer. */
  app.get("/lan-phones/runs", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!(await userHasActionPermission(user, "can_view_lan_phones"))) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const isSuper = String(user.role) === "SUPER_ADMIN";
    const requestedTenant = String(req.query?.tenantId || "").trim();
    const tenantId = isSuper && requestedTenant ? requestedTenant : user.tenantId;

    const runs = await db.lanDiscoveryRun.findMany({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
      take: 50,
    });
    return reply.send({ runs: runs.map(runView) });
  });
}
