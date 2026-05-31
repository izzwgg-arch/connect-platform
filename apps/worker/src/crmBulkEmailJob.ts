import { db } from "@connect/db";
import { processCrmEmailSendJob } from "./crmEmailSend";
import { plainTextToCrmHtml } from "@connect/shared";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum recipients to process in one pass before yielding for idempotency. */
const BATCH_SIZE = 10;
/** Delay (ms) between individual sends to avoid Gmail rate-limit (1 QPS burst). */
const INTER_SEND_DELAY_MS = Number(process.env.CRM_BULK_EMAIL_INTER_SEND_MS || "600");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Render a template string by replacing {{variable}} tokens.
 * Safe: unrecognised tokens become empty string.
 * Exported for unit testing.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_match, key: string) => {
    const alias = key === "contact.fullName" || key === "contact.displayName" ? "contact.name" : key;
    return vars[key] ?? vars[alias] ?? vars[key.replace(".", "_")] ?? "";
  });
}

/** Exported for unit testing. */
export function buildContactVars(contact: {
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  company?: string | null;
  title?: string | null;
  primaryEmail?: { email: string } | null;
  primaryPhone?: { numberRaw: string } | null;
  primaryCity?: string | null;
  primaryState?: string | null;
}): Record<string, string> {
  const firstName = contact.firstName ?? contact.displayName?.split(" ")[0] ?? "";
  const lastName =
    contact.lastName ?? contact.displayName?.split(" ").slice(1).join(" ") ?? "";
  const fullName = contact.displayName ?? `${firstName} ${lastName}`.trim();
  return {
    firstName,
    "contact.firstName": firstName,
    lastName,
    "contact.lastName": lastName,
    name: fullName,
    "contact.name": fullName,
    "contact.fullName": fullName,
    "contact.displayName": fullName,
    company: contact.company ?? "",
    "contact.company": contact.company ?? "",
    title: contact.title ?? "",
    "contact.title": contact.title ?? "",
    email: contact.primaryEmail?.email ?? "",
    "contact.email": contact.primaryEmail?.email ?? "",
    phone: contact.primaryPhone?.numberRaw ?? "",
    "contact.phone": contact.primaryPhone?.numberRaw ?? "",
    city: contact.primaryCity ?? "",
    "contact.city": contact.primaryCity ?? "",
    state: contact.primaryState ?? "",
    "contact.state": contact.primaryState ?? "",
  };
}

/** Exported for unit testing. */
export function buildFunderVars(funder: {
  name: string;
  organization?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
}): Record<string, string> {
  const firstName = funder.name.split(" ")[0] ?? funder.name;
  const lastName = funder.name.split(" ").slice(1).join(" ") ?? "";
  return {
    firstName,
    "contact.firstName": firstName,
    lastName,
    "contact.lastName": lastName,
    name: funder.name,
    "contact.name": funder.name,
    "contact.fullName": funder.name,
    "contact.displayName": funder.name,
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
    "funder.name": funder.name,
    "funder.organization": funder.organization ?? "",
  };
}

/**
 * Resolve the sender CrmEmailConnection for a bulk job.
 * Uses the same fallback chain as the API's resolveSenderConnection:
 *  1. job.connectionId (if set)
 *  2. createdBy user's own USER connection
 *  3. tenant default TENANT connection
 *  4. lone TENANT connection
 */
async function resolveBulkSender(
  tenantId: string,
  userId: string | null | undefined,
  connectionId: string | null | undefined,
): Promise<{ id: string; emailAddress: string; senderName: string | null; displayName: string | null; scope: string } | null> {
  if (connectionId) {
    const row = await db.crmEmailConnection.findFirst({
      where: { id: connectionId, tenantId, status: "CONNECTED" },
      select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true },
    });
    if (row) return row as any;
  }

  if (userId) {
    const mine = await db.crmEmailConnection.findFirst({
      where: { tenantId, userId, scope: "USER", status: "CONNECTED" },
      select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true },
    });
    if (mine) return mine as any;
  }

  const def = await db.crmEmailConnection.findFirst({
    where: { tenantId, scope: "TENANT", isDefaultForTenant: true, status: "CONNECTED" },
    select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true },
  });
  if (def) return def as any;

  const tenantRows = await db.crmEmailConnection.findMany({
    where: { tenantId, scope: "TENANT", status: "CONNECTED" },
    select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true },
    take: 2,
  });
  if (tenantRows.length === 1) return tenantRows[0] as any;

  return null;
}

// ── Main processor ─────────────────────────────────────────────────────────────

export async function processCrmBulkEmailJob(jobData: {
  jobId: string;
  tenantId: string;
}): Promise<void> {
  const { jobId, tenantId } = jobData;

  // Load job
  const job = await db.crmBulkEmailJob.findFirst({
    where: { id: jobId, tenantId },
  });

  if (!job) {
    console.error(`[crm-bulk-email] Job ${jobId} not found`);
    return;
  }

  if (job.status === "CANCELLED") {
    console.log(`[crm-bulk-email] Job ${jobId} is cancelled — skipping`);
    return;
  }

  if (!["QUEUED", "RUNNING"].includes(job.status)) {
    console.log(`[crm-bulk-email] Job ${jobId} is already ${job.status} — skipping`);
    return;
  }

  // Mark as RUNNING
  await db.crmBulkEmailJob.update({
    where: { id: jobId },
    data: { status: "RUNNING", startedAt: job.startedAt ?? new Date() },
  });

  // Load template
  const template = await db.crmEmailTemplate.findFirst({
    where: { id: job.templateId, tenantId },
  });
  if (!template) {
    await db.crmBulkEmailJob.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), errorSummary: "Template not found" },
    });
    return;
  }

  // Resolve sender
  const sender = await resolveBulkSender(tenantId, job.createdByUserId, job.connectionId);
  if (!sender) {
    await db.crmBulkEmailJob.update({
      where: { id: jobId },
      data: { status: "FAILED", completedAt: new Date(), errorSummary: "No connected email sender available" },
    });
    return;
  }

  // Persist the resolved connectionId so future status reads show it
  if (!job.connectionId && sender.id) {
    await db.crmBulkEmailJob.update({
      where: { id: jobId },
      data: { connectionId: sender.id },
    });
  }

  let sentCount = job.sentCount;
  let failedCount = job.failedCount;
  const errors: string[] = [];

  try {
    // Process QUEUED recipients in pages
    let hasMore = true;
    while (hasMore) {
      const recipients = await db.crmBulkEmailRecipient.findMany({
        where: { jobId, status: "QUEUED" },
        take: BATCH_SIZE,
        orderBy: { createdAt: "asc" },
      });

      if (recipients.length === 0) {
        hasMore = false;
        break;
      }

      for (const recipient of recipients) {
        // Idempotency: if already processed, skip
        const current = await db.crmBulkEmailRecipient.findUnique({
          where: { id: recipient.id },
          select: { status: true },
        });
        if (!current || current.status !== "QUEUED") continue;

        // Resolve contact/funder data for template rendering
        let vars: Record<string, string> = {};

        if (recipient.contactId) {
          const contact = await db.contact.findFirst({
            where: { id: recipient.contactId, tenantId },
            select: {
              firstName: true,
              lastName: true,
              displayName: true,
              company: true,
              title: true,
              emails: { where: { isPrimary: true }, select: { email: true }, take: 1 },
              phones: { where: { isPrimary: true }, select: { numberRaw: true }, take: 1 },
            },
          });
          if (contact) {
            vars = buildContactVars({
              ...contact,
              primaryEmail: contact.emails[0] ? { email: contact.emails[0].email } : null,
              primaryPhone: contact.phones[0] ? { numberRaw: contact.phones[0].numberRaw } : null,
            });
          }
        } else if (recipient.funderId) {
          const funder = await db.funder.findFirst({
            where: { id: recipient.funderId, tenantId },
            select: { name: true, organization: true, email: true, phone: true, city: true, state: true },
          });
          if (funder) {
            vars = buildFunderVars(funder);
          }
        }

        const subject = renderTemplate(template.subject, vars);
        const bodyText = renderTemplate(template.bodyText, vars);
        const bodyHtml = renderTemplate((template as any).bodyHtml || plainTextToCrmHtml(template.bodyText), vars);

        try {
          await processCrmEmailSendJob({
            tenantId,
            userId: job.createdByUserId ?? "",
            connectionId: sender.id,
            to: recipient.toEmail,
            subject,
            bodyText,
            bodyHtml,
            contactId: recipient.contactId ?? null,
            templateId: template.id,
          });

          await db.crmBulkEmailRecipient.update({
            where: { id: recipient.id },
            data: { status: "SENT", sentAt: new Date() },
          });
          sentCount++;
        } catch (err: any) {
          const errMsg = String(err?.message || "send_failed");
          await db.crmBulkEmailRecipient.update({
            where: { id: recipient.id },
            data: { status: "FAILED", errorMessage: errMsg.slice(0, 500) },
          });
          failedCount++;
          errors.push(`${recipient.toEmail}: ${errMsg}`);
        }

        // Persist running counts periodically
        await db.crmBulkEmailJob.update({
          where: { id: jobId },
          data: { sentCount, failedCount },
        });

        // Throttle between sends
        if (INTER_SEND_DELAY_MS > 0) {
          await delay(INTER_SEND_DELAY_MS);
        }
      }
    }

    const errorSummary =
      errors.length > 0
        ? `${errors.length} failed: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? " …" : ""}`
        : null;

    await db.crmBulkEmailJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        sentCount,
        failedCount,
        errorSummary: errorSummary ?? undefined,
      },
    });

    console.log(
      `[crm-bulk-email] Job ${jobId} completed: sent=${sentCount} failed=${failedCount}`,
    );
  } catch (err: any) {
    const errMsg = String(err?.message || "bulk_job_error");
    await db.crmBulkEmailJob
      .update({
        where: { id: jobId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          sentCount,
          failedCount,
          errorSummary: errMsg.slice(0, 500),
        },
      })
      .catch(() => undefined);
    console.error(`[crm-bulk-email] Job ${jobId} failed:`, errMsg);
    throw err;
  }
}
