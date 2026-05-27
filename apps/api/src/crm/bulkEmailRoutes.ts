import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { requireCrmAdmin, isAdminRole } from "./guard";

// ── Queue ─────────────────────────────────────────────────────────────────────

const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});
const bulkEmailQueue = new Queue("crm-bulk-email-job", { connection: redis });

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RECIPIENTS_PER_JOB = 5_000;
const MAX_EXPLICIT_IDS = 1_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Render a template's subject and body for a recipient.
 * Replaces {{variable}} tokens with safe fallbacks.
 */
function renderTemplate(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_match, key) => {
    const val = vars[key] ?? vars[key.replace(".", "_")] ?? "";
    return String(val);
  });
}

function buildVarsFromContact(contact: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  state?: string | null;
  primaryEmail?: { email: string } | null;
  primaryPhone?: { numberRaw: string } | null;
}): Record<string, string> {
  const firstName = contact.firstName ?? contact.displayName?.split(" ")[0] ?? "";
  const lastName =
    contact.lastName ?? contact.displayName?.split(" ").slice(1).join(" ") ?? "";
  return {
    firstName,
    "contact.firstName": firstName,
    lastName,
    "contact.lastName": lastName,
    name: contact.displayName ?? `${firstName} ${lastName}`.trim(),
    "contact.name": contact.displayName ?? `${firstName} ${lastName}`.trim(),
    company: contact.company ?? "",
    "contact.company": contact.company ?? "",
    title: contact.title ?? "",
    "contact.title": contact.title ?? "",
    city: contact.city ?? "",
    "contact.city": contact.city ?? "",
    state: contact.state ?? "",
    "contact.state": contact.state ?? "",
    email: contact.primaryEmail?.email ?? "",
    "contact.email": contact.primaryEmail?.email ?? "",
    phone: contact.primaryPhone?.numberRaw ?? "",
    "contact.phone": contact.primaryPhone?.numberRaw ?? "",
  };
}

function buildVarsFromFunder(funder: {
  name: string;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
}): Record<string, string> {
  return {
    firstName: funder.name.split(" ")[0] ?? funder.name,
    "contact.firstName": funder.name.split(" ")[0] ?? funder.name,
    lastName: funder.name.split(" ").slice(1).join(" ") ?? "",
    "contact.lastName": funder.name.split(" ").slice(1).join(" ") ?? "",
    name: funder.name,
    "contact.name": funder.name,
    company: funder.organization ?? "",
    "contact.company": funder.organization ?? "",
    email: funder.email ?? "",
    "contact.email": funder.email ?? "",
    phone: funder.phone ?? "",
    "contact.phone": funder.phone ?? "",
    city: funder.city ?? "",
    "contact.city": funder.city ?? "",
    state: funder.state ?? "",
    "contact.state": funder.state ?? "",
    organization: funder.organization ?? "",
    "funder.organization": funder.organization ?? "",
    "funder.name": funder.name,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerCrmBulkEmailRoutes(app: FastifyInstance) {
  /**
   * POST /crm/email/bulk-jobs
   *
   * Creates a bulk email job. Resolves all recipients server-side, dedupes by email,
   * skips missing emails, then enqueues a single BullMQ job for worker processing.
   *
   * Requires CRM admin (ADMIN / TENANT_ADMIN / SUPER_ADMIN).
   *
   * Body:
   * {
   *   sourceType: "CONTACTS" | "CAMPAIGN" | "FUNDERS"
   *   templateId: string                    — required
   *   connectionId?: string                 — optional; deferred to worker fallback chain if omitted
   *   campaignId?: string                   — required when sourceType = CAMPAIGN
   *   tagId?: string                        — optional tag filter
   *   contactIds?: string[]                 — explicit list (CONTACTS / CAMPAIGN); null = all filtered
   *   selectAll?: boolean                   — if true, ignore contactIds and select all filtered
   *   // For CONTACTS + selectAll: pass current filter params
   *   stage?: string
   *   search?: string
   * }
   */
  app.post("/crm/email/bulk-jobs", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const body = (req.body as any) || {};
    const sourceType = String(body.sourceType || "").toUpperCase();
    if (!["CONTACTS", "CAMPAIGN", "FUNDERS"].includes(sourceType)) {
      return reply.code(400).send({ error: "invalid_payload", detail: "sourceType must be CONTACTS, CAMPAIGN, or FUNDERS" });
    }

    const templateId = String(body.templateId || "");
    if (!templateId) {
      return reply.code(400).send({ error: "invalid_payload", detail: "templateId required" });
    }

    // Validate template exists and is accessible
    const template = await db.crmEmailTemplate.findFirst({
      where: {
        id: templateId,
        tenantId: user.tenantId,
        isArchived: false,
      },
    });
    if (!template) {
      return reply.code(404).send({ error: "template_not_found" });
    }

    // Validate connectionId if provided
    const connectionId = body.connectionId ? String(body.connectionId) : null;
    if (connectionId) {
      const conn = await db.crmEmailConnection.findFirst({
        where: {
          id: connectionId,
          tenantId: user.tenantId,
          status: "CONNECTED",
        },
        select: { id: true },
      });
      if (!conn) {
        return reply.code(400).send({ error: "invalid_payload", detail: "connectionId not found or not connected" });
      }
    }

    const campaignId = body.campaignId ? String(body.campaignId) : null;
    const tagId = body.tagId ? String(body.tagId) : null;
    const selectAll = body.selectAll === true;
    const explicitIds: string[] = Array.isArray(body.contactIds)
      ? body.contactIds.slice(0, MAX_EXPLICIT_IDS).map(String)
      : [];

    // ── Resolve recipients ────────────────────────────────────────────────────

    type RecipientInput = {
      contactId?: string;
      funderId?: string;
      toEmail: string;
      displayName?: string;
      firstName?: string | null;
      lastName?: string | null;
      company?: string | null;
      title?: string | null;
      city?: string | null;
      state?: string | null;
      phone?: string | null;
    };

    let candidates: RecipientInput[] = [];

    if (sourceType === "CONTACTS") {
      if (!selectAll && explicitIds.length === 0) {
        return reply.code(400).send({ error: "invalid_payload", detail: "contactIds or selectAll required for CONTACTS source" });
      }

      if (selectAll) {
        // All filtered contacts
        const where: any = {
          tenantId: user.tenantId,
          crmMeta: { isNot: null },
          active: true,
        };
        if (tagId) {
          where.tagLinks = { some: { tagId } };
        }
        if (body.stage && body.stage !== "all") {
          where.crmMeta = { ...where.crmMeta, stage: body.stage };
        }
        const contacts = await db.contact.findMany({
          where,
          take: MAX_RECIPIENTS_PER_JOB,
          select: {
            id: true,
            firstName: true,
            lastName: true,
            displayName: true,
            company: true,
            title: true,
            emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
            phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
          },
        });
        candidates = contacts.map((c) => ({
          contactId: c.id,
          toEmail: c.emails[0]?.email ?? "",
          displayName: c.displayName ?? undefined,
          firstName: c.firstName,
          lastName: c.lastName,
          company: c.company ?? undefined,
          title: c.title ?? undefined,
          phone: c.phones[0]?.numberRaw ?? undefined,
        }));
      } else {
        // Explicit list
        const contacts = await db.contact.findMany({
          where: {
            id: { in: explicitIds },
            tenantId: user.tenantId,
            active: true,
            ...(tagId ? { tagLinks: { some: { tagId } } } : {}),
          },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            displayName: true,
            company: true,
            title: true,
            emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
            phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
          },
        });
        candidates = contacts.map((c) => ({
          contactId: c.id,
          toEmail: c.emails[0]?.email ?? "",
          displayName: c.displayName ?? undefined,
          firstName: c.firstName,
          lastName: c.lastName,
          company: c.company ?? undefined,
          title: c.title ?? undefined,
          phone: c.phones[0]?.numberRaw ?? undefined,
        }));
      }
    } else if (sourceType === "CAMPAIGN") {
      if (!campaignId) {
        return reply.code(400).send({ error: "invalid_payload", detail: "campaignId required for CAMPAIGN source" });
      }
      // Validate campaign belongs to tenant
      const campaign = await db.crmCampaign.findFirst({
        where: { id: campaignId, tenantId: user.tenantId },
        select: { id: true, name: true },
      });
      if (!campaign) {
        return reply.code(404).send({ error: "campaign_not_found" });
      }

      const where: any = {
        campaignId,
        tenantId: user.tenantId,
        contact: { isNot: null, active: true },
      };
      if (explicitIds.length > 0) {
        where.contactId = { in: explicitIds };
      }
      if (tagId) {
        where.contact = { ...where.contact, tagLinks: { some: { tagId } } };
      }

      const members = await db.crmCampaignMember.findMany({
        where,
        take: MAX_RECIPIENTS_PER_JOB,
        select: {
          contactId: true,
          contact: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              displayName: true,
              company: true,
              title: true,
              emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
              phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
            },
          },
        },
      });
      candidates = members
        .filter((m) => m.contact)
        .map((m) => {
          const c = m.contact!;
          return {
            contactId: c.id,
            toEmail: c.emails[0]?.email ?? "",
            displayName: c.displayName ?? undefined,
            firstName: c.firstName,
            lastName: c.lastName,
            company: c.company ?? undefined,
            title: c.title ?? undefined,
            phone: c.phones[0]?.numberRaw ?? undefined,
          };
        });
    } else if (sourceType === "FUNDERS") {
      const where: any = {
        tenantId: user.tenantId,
        active: true,
      };
      if (explicitIds.length > 0 && !selectAll) {
        where.id = { in: explicitIds };
      }
      if (tagId) {
        where.tagLinks = { some: { tagId } };
      }
      const funders = await db.funder.findMany({
        where,
        take: MAX_RECIPIENTS_PER_JOB,
        select: {
          id: true,
          name: true,
          organization: true,
          email: true,
          phone: true,
          city: true,
          state: true,
        },
      });
      candidates = funders.map((f) => ({
        funderId: f.id,
        toEmail: f.email ?? "",
        displayName: f.name,
        firstName: f.name.split(" ")[0] ?? f.name,
        lastName: f.name.split(" ").slice(1).join(" ") ?? "",
        company: f.organization ?? undefined,
        phone: f.phone ?? undefined,
        city: f.city ?? undefined,
        state: f.state ?? undefined,
      }));
    }

    // ── Dedup + skip logic ────────────────────────────────────────────────────

    const emailsSeen = new Set<string>();
    let skippedCount = 0;

    type ResolvedRecipient = {
      contactId?: string;
      funderId?: string;
      toEmail: string;
      displayName?: string;
      firstName?: string | null;
      lastName?: string | null;
      company?: string | null;
      title?: string | null;
      city?: string | null;
      state?: string | null;
      phone?: string | null;
      skipReason?: string;
    };

    const resolved: ResolvedRecipient[] = [];
    for (const c of candidates) {
      const email = c.toEmail.trim().toLowerCase();
      if (!email) {
        skippedCount++;
        resolved.push({ ...c, toEmail: c.toEmail, skipReason: "MISSING_EMAIL" });
        continue;
      }
      if (emailsSeen.has(email)) {
        skippedCount++;
        resolved.push({ ...c, toEmail: c.toEmail, skipReason: "DUPLICATE" });
        continue;
      }
      emailsSeen.add(email);
      resolved.push({ ...c, toEmail: email });
    }

    const totalCount = resolved.length;
    const queuedCount = resolved.filter((r) => !r.skipReason).length;

    if (queuedCount === 0 && totalCount === 0) {
      return reply.code(400).send({ error: "no_recipients", detail: "No recipients found for the given selection" });
    }

    // ── Create job + recipients atomically ───────────────────────────────────

    const job = await db.$transaction(async (tx) => {
      const created = await tx.crmBulkEmailJob.create({
        data: {
          tenantId: user.tenantId,
          createdByUserId: user.sub,
          sourceType,
          campaignId: campaignId ?? null,
          tagId: tagId ?? null,
          contactIds: explicitIds.length > 0 && !selectAll ? explicitIds : undefined,
          templateId,
          connectionId: connectionId ?? null,
          status: "QUEUED",
          totalCount,
          queuedCount,
          skippedCount,
          sentCount: 0,
          failedCount: 0,
        },
      });

      const recipientRows = resolved.map((r) => ({
        jobId: created.id,
        tenantId: user.tenantId,
        contactId: r.contactId ?? null,
        funderId: r.funderId ?? null,
        toEmail: r.toEmail,
        status: r.skipReason ? "SKIPPED" : "QUEUED",
        skipReason: r.skipReason ?? null,
        idempotencyKey: `${created.id}:${r.contactId ?? r.funderId ?? r.toEmail}:${templateId}`,
      }));

      await tx.crmBulkEmailRecipient.createMany({ data: recipientRows });

      return created;
    });

    // Enqueue a single worker job to process all recipients
    await bulkEmailQueue.add(
      "process",
      { jobId: job.id, tenantId: user.tenantId },
      {
        jobId: `bulk:${job.id}`,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );

    await db.auditLog.create({
      data: {
        tenantId: user.tenantId,
        action: "CRM_BULK_EMAIL_QUEUED",
        entityType: "CrmBulkEmailJob",
        entityId: job.id,
        actorUserId: user.sub,
        metadata: { sourceType, totalCount, queuedCount, skippedCount, templateId },
      },
    }).catch(() => undefined);

    return reply.code(201).send({
      jobId: job.id,
      status: job.status,
      totalCount,
      queuedCount,
      skippedCount,
    });
  });

  /**
   * GET /crm/email/bulk-jobs
   * List recent bulk email jobs for this tenant (newest first).
   */
  app.get("/crm/email/bulk-jobs", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const limit = Math.min(50, Math.max(1, Number((req.query as any)?.limit ?? 20)));
    const jobs = await db.crmBulkEmailJob.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        sourceType: true,
        campaignId: true,
        tagId: true,
        status: true,
        totalCount: true,
        queuedCount: true,
        sentCount: true,
        failedCount: true,
        skippedCount: true,
        errorSummary: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        template: { select: { id: true, name: true, subject: true } },
        connection: { select: { id: true, emailAddress: true, scope: true } },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return { jobs };
  });

  /**
   * GET /crm/email/bulk-jobs/:jobId
   * Detail for a specific bulk job, including recipient summary.
   */
  app.get("/crm/email/bulk-jobs/:jobId", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const { jobId } = req.params as { jobId: string };
    const job = await db.crmBulkEmailJob.findFirst({
      where: { id: jobId, tenantId: user.tenantId },
      include: {
        template: { select: { id: true, name: true, subject: true } },
        connection: { select: { id: true, emailAddress: true, scope: true } },
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    if (!job) return reply.code(404).send({ error: "job_not_found" });

    // Fetch a sample of failed recipients for the error report
    const failedRecipients = await db.crmBulkEmailRecipient.findMany({
      where: { jobId, status: "FAILED" },
      take: 50,
      select: {
        id: true,
        toEmail: true,
        contactId: true,
        funderId: true,
        errorMessage: true,
        sentAt: true,
      },
    });

    const skippedRecipients = await db.crmBulkEmailRecipient.findMany({
      where: { jobId, status: "SKIPPED" },
      take: 50,
      select: {
        id: true,
        toEmail: true,
        contactId: true,
        funderId: true,
        skipReason: true,
      },
    });

    return {
      job,
      failedSample: failedRecipients,
      skippedSample: skippedRecipients,
    };
  });

  /**
   * POST /crm/email/bulk-jobs/:jobId/cancel
   * Cancel a QUEUED job (before worker picks it up).
   */
  app.post("/crm/email/bulk-jobs/:jobId/cancel", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;

    const { jobId } = req.params as { jobId: string };
    const job = await db.crmBulkEmailJob.findFirst({
      where: { id: jobId, tenantId: user.tenantId },
      select: { id: true, status: true },
    });
    if (!job) return reply.code(404).send({ error: "job_not_found" });
    if (!["QUEUED"].includes(job.status)) {
      return reply.code(409).send({ error: "cannot_cancel", detail: `Job is ${job.status}` });
    }

    await db.crmBulkEmailJob.update({
      where: { id: jobId },
      data: { status: "CANCELLED" },
    });

    // Best-effort remove from BullMQ
    try {
      const bullJob = await bulkEmailQueue.getJob(`bulk:${jobId}`);
      if (bullJob) await bullJob.remove();
    } catch {
      // non-fatal
    }

    return { ok: true };
  });
}
