import { db } from "@connect/db";
import {
  classifyAttachmentType,
  extractWebsiteSubmissionFields,
  normalizeEmail,
  normalizePhone,
  redactSensitiveText,
  ruleMatchesEmail,
  type ExtractedWebsiteSubmissionFields,
} from "./websiteSubmissionExtraction.js";
import { writeTimelineEvent } from "./timelineHelper.js";
import { writeCrmDocFile } from "./docImportStorage.js";

export type WebsiteSubmissionEmailAttachment = {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

export type ProcessWebsiteSubmissionEmailInput = {
  tenantId: string;
  connectionId: string;
  gmailMessageId: string;
  gmailThreadId?: string | null;
  fromEmail?: string | null;
  toEmail?: string | null;
  subject?: string | null;
  receivedAt?: Date | null;
  snippet?: string | null;
  bodyText: string;
  attachments?: WebsiteSubmissionEmailAttachment[];
};

type ProcessingOutcome = {
  matched: boolean;
  submissionId?: string;
  contactId?: string | null;
  status?: "PROCESSED" | "PENDING_REVIEW" | "FAILED";
  reason?: string;
};

function displayNameFromFields(fields: ExtractedWebsiteSubmissionFields, fallbackEmail?: string | null): string {
  const fromParts = [fields.firstName, fields.lastName].filter(Boolean).join(" ").trim();
  return fields.displayName || fromParts || fields.company || fallbackEmail || "Website submission";
}

function safeSummaryLines(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => redactSensitiveText(String(line || "")).slice(0, 300)).filter(Boolean).slice(0, 12);
}

async function resolveFallbackUserId(tenantId: string, preferred?: string | null): Promise<string | null> {
  if (preferred) {
    const user = await (db as any).user.findFirst({ where: { id: preferred, tenantId }, select: { id: true } });
    if (user) return user.id;
  }
  const user = await (db as any).user.findFirst({
    where: { tenantId, status: "ACTIVE", role: { in: ["TENANT_ADMIN", "ADMIN", "MANAGER", "USER"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function findExistingContact(tenantId: string, fields: ExtractedWebsiteSubmissionFields) {
  const email = normalizeEmail(fields.email);
  const phone = normalizePhone(fields.phone);
  const or: any[] = [];
  if (email) or.push({ emails: { some: { email } } });
  if (phone) or.push({ phones: { some: { numberNormalized: phone } } });
  if (or.length === 0) return null;
  return (db as any).contact.findFirst({
    where: { tenantId, active: true, archivedAt: null, OR: or },
    include: { phones: true, emails: true, addresses: true, crmMeta: true },
  });
}

async function createOrUpdateContact(input: {
  tenantId: string;
  fields: ExtractedWebsiteSubmissionFields;
  summaryLines: string[];
  assignedUserId: string | null;
  allowWrite: boolean;
  ruleName: string;
}) {
  const { tenantId, fields, assignedUserId, allowWrite, ruleName } = input;
  const email = normalizeEmail(fields.email);
  const normalizedPhone = normalizePhone(fields.phone);
  const existing = await findExistingContact(tenantId, fields);
  const notesSuffix = [
    `Source: Website Submission (${ruleName})`,
    ...input.summaryLines,
  ].filter(Boolean).join("\n");

  if (!existing) {
    if (!allowWrite) return { contact: null, created: false, updated: false };
    const contact = await (db as any).contact.create({
      data: {
        tenantId,
        firstName: fields.firstName || null,
        lastName: fields.lastName || null,
        displayName: displayNameFromFields(fields, email),
        company: fields.company || null,
        title: fields.title || null,
        notes: [fields.notes, notesSuffix].filter(Boolean).join("\n\n").slice(0, 5000) || null,
        source: "WEBSITE_SUBMISSION",
        emails: email ? { create: [{ email, type: "WORK", isPrimary: true }] } : undefined,
        phones: normalizedPhone ? { create: [{ numberRaw: fields.phone || normalizedPhone, numberNormalized: normalizedPhone, type: "MOBILE", isPrimary: true }] } : undefined,
        addresses: fields.address && Object.values(fields.address).some(Boolean) ? { create: [fields.address] } : undefined,
        crmMeta: {
          create: {
            tenantId,
            stage: "LEAD",
            assignedToUserId: assignedUserId || null,
          },
        },
      },
      include: { crmMeta: true },
    });
    return { contact, created: true, updated: false };
  }

  const contactUpdates: any = {};
  for (const key of ["firstName", "lastName", "company", "title"] as const) {
    if (!existing[key] && fields[key]) contactUpdates[key] = fields[key];
  }
  if (!existing.displayName && displayNameFromFields(fields, email)) {
    contactUpdates.displayName = displayNameFromFields(fields, email);
  }
  if (notesSuffix && !String(existing.notes || "").includes(`Website Submission (${ruleName})`)) {
    contactUpdates.notes = [existing.notes, notesSuffix].filter(Boolean).join("\n\n").slice(0, 5000);
  }
  if (Object.keys(contactUpdates).length > 0 && allowWrite) {
    await (db as any).contact.update({ where: { id: existing.id }, data: contactUpdates });
  }
  if (allowWrite && email && !existing.emails?.some((e: any) => String(e.email).toLowerCase() === email)) {
    await (db as any).contactEmail.create({ data: { contactId: existing.id, email, type: "WORK", isPrimary: false } }).catch(() => undefined);
  }
  if (allowWrite && normalizedPhone && !existing.phones?.some((p: any) => p.numberNormalized === normalizedPhone)) {
    await (db as any).contactPhone.create({
      data: { contactId: existing.id, numberRaw: fields.phone || normalizedPhone, numberNormalized: normalizedPhone, type: "MOBILE", isPrimary: false },
    }).catch(() => undefined);
  }
  if (allowWrite && fields.address && Object.values(fields.address).some(Boolean) && !(existing.addresses || []).length) {
    await (db as any).contactAddress.create({ data: { contactId: existing.id, ...fields.address } }).catch(() => undefined);
  }
  if (allowWrite && !existing.crmMeta) {
    await (db as any).crmContactMeta.create({
      data: { tenantId, contactId: existing.id, stage: "LEAD", assignedToUserId: assignedUserId || null },
    }).catch(() => undefined);
  } else if (allowWrite && existing.crmMeta && !existing.crmMeta.assignedToUserId && assignedUserId) {
    await (db as any).crmContactMeta.update({ where: { contactId: existing.id }, data: { assignedToUserId: assignedUserId } }).catch(() => undefined);
  }
  return { contact: existing, created: false, updated: Object.keys(contactUpdates).length > 0 };
}

async function storeAttachments(input: {
  tenantId: string;
  contactId: string;
  submissionId: string;
  attachments: WebsiteSubmissionEmailAttachment[];
}) {
  const summary: Array<{ documentId: string; fileName: string; mimeType: string; documentType: string }> = [];
  for (const attachment of input.attachments.slice(0, 10)) {
    const documentType = classifyAttachmentType(attachment.fileName, attachment.mimeType);
    const doc = await (db as any).crmLeadDocument.create({
      data: {
        tenantId: input.tenantId,
        contactId: input.contactId,
        source: "EMAIL_ATTACHMENT",
        originalFileName: attachment.fileName.slice(0, 255),
        mimeType: attachment.mimeType || "application/octet-stream",
        sizeBytes: BigInt(attachment.buffer.length),
        status: "IMPORTING",
        matchConfidence: "HIGH",
        matchReason: `website_submission_email:${documentType}`,
      },
      select: { id: true },
    });
    try {
      const stored = await writeCrmDocFile({
        tenantId: input.tenantId,
        docId: doc.id,
        buffer: attachment.buffer,
        mimeType: attachment.mimeType || "application/octet-stream",
        originalFileName: attachment.fileName,
      });
      await (db as any).crmLeadDocument.update({
        where: { id: doc.id },
        data: {
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          sizeBytes: BigInt(stored.storedBytes),
          status: "IMPORTED",
          importedAt: new Date(),
          importedMimeType: attachment.mimeType || "application/octet-stream",
        },
      });
      summary.push({ documentId: doc.id, fileName: attachment.fileName, mimeType: attachment.mimeType, documentType });
    } catch (err) {
      await (db as any).crmLeadDocument.update({
        where: { id: doc.id },
        data: { status: "IMPORT_FAILED", importError: "email_attachment_storage_failed" },
      }).catch(() => undefined);
    }
  }
  return summary;
}

export async function processWebsiteSubmissionEmail(input: ProcessWebsiteSubmissionEmailInput): Promise<ProcessingOutcome> {
  if ((process.env.CRM_WEBSITE_SUBMISSION_EMAIL_ENABLED || "true").toLowerCase() === "false") {
    return { matched: false, reason: "feature_disabled" };
  }
  const rules = await (db as any).crmWebsiteSubmissionEmailRule.findMany({
    where: { tenantId: input.tenantId, connectionId: input.connectionId, active: true },
    orderBy: { createdAt: "asc" },
  });
  if (rules.length === 0) return { matched: false, reason: "no_active_rules" };

  const rule = rules.find((candidate: any) => ruleMatchesEmail(candidate, {
    fromEmail: input.fromEmail,
    subject: input.subject,
    body: input.bodyText,
  }));
  if (!rule) return { matched: false, reason: "no_rule_match" };

  const existing = await (db as any).crmWebsiteSubmission.findUnique({
    where: { tenantId_gmailMessageId: { tenantId: input.tenantId, gmailMessageId: input.gmailMessageId } },
    select: { id: true, contactId: true, status: true },
  }).catch(() => null);
  if (existing) return { matched: true, submissionId: existing.id, contactId: existing.contactId, status: existing.status, reason: "duplicate" };

  const fieldMap = rule.fieldMap && typeof rule.fieldMap === "object" && !Array.isArray(rule.fieldMap) ? rule.fieldMap as Record<string, string> : {};
  const extraction = extractWebsiteSubmissionFields(input.bodyText, fieldMap);
  const summaryLines = safeSummaryLines(extraction.unmappedSummary);
  const confidence = extraction.confidence;
  const threshold = typeof rule.confidenceThreshold === "number" ? rule.confidenceThreshold : 0.75;
  const hasContactSignal = Boolean(
    extraction.fields.email ||
    extraction.fields.phone ||
    extraction.fields.displayName ||
    extraction.fields.firstName ||
    extraction.fields.lastName ||
    extraction.fields.company,
  );
  const lowConfidence = confidence < threshold || !hasContactSignal;
  const assignedUserId = await resolveFallbackUserId(input.tenantId, rule.assignmentUserId || null);

  const submission = await (db as any).crmWebsiteSubmission.create({
    data: {
      tenantId: input.tenantId,
      ruleId: rule.id,
      connectionId: input.connectionId,
      gmailMessageId: input.gmailMessageId,
      status: "MATCHED",
      fromEmail: normalizeEmail(input.fromEmail),
      subject: redactSensitiveText(input.subject || "").slice(0, 500) || null,
      receivedAt: input.receivedAt || new Date(),
      extractedFields: extraction.fields as any,
      unmappedSummary: summaryLines as any,
      confidence,
    },
  });

  try {
    const allowWrite = rule.mode === "AUTO_CREATE" && !lowConfidence;
    const contactResult = await createOrUpdateContact({
      tenantId: input.tenantId,
      fields: extraction.fields,
      summaryLines,
      assignedUserId,
      allowWrite,
      ruleName: rule.name,
    });
    const contactId = contactResult.contact?.id ?? null;
    const thread = contactId && assignedUserId && input.gmailThreadId
      ? await (db as any).crmEmailThread.upsert({
          where: { tenantId_gmailThreadId: { tenantId: input.tenantId, gmailThreadId: input.gmailThreadId } },
          update: { contactId, lastMessageAt: input.receivedAt || new Date(), senderConnectionId: input.connectionId },
          create: {
            tenantId: input.tenantId,
            userId: assignedUserId,
            contactId,
            gmailThreadId: input.gmailThreadId,
            subject: redactSensitiveText(input.subject || "").slice(0, 500) || null,
            lastMessageAt: input.receivedAt || new Date(),
            senderConnectionId: input.connectionId,
          },
        }).catch(() => null)
      : null;
    const emailMessage = contactId && assignedUserId
      ? await (db as any).crmEmailMessage.create({
          data: {
            tenantId: input.tenantId,
            userId: assignedUserId,
            threadId: thread?.id ?? null,
            contactId,
            gmailMessageId: input.gmailMessageId,
            direction: "INBOUND",
            subject: redactSensitiveText(input.subject || "").slice(0, 500) || null,
            fromEmail: normalizeEmail(input.fromEmail),
            toEmail: normalizeEmail(input.toEmail),
            previewSnippet: redactSensitiveText(input.snippet || input.bodyText).slice(0, 300),
            receivedAt: input.receivedAt || new Date(),
            senderConnectionId: input.connectionId,
          },
        }).catch(() => null)
      : null;

    const attachmentSummary = contactId
      ? await storeAttachments({
          tenantId: input.tenantId,
          contactId,
          submissionId: submission.id,
          attachments: input.attachments || [],
        })
      : [];
    const finalStatus = lowConfidence || rule.mode === "REVIEW_FIRST" ? "PENDING_REVIEW" : "PROCESSED";
    await (db as any).crmWebsiteSubmission.update({
      where: { id: submission.id },
      data: {
        status: finalStatus,
        contactId,
        emailMessageId: emailMessage?.id ?? null,
        attachmentSummary: attachmentSummary as any,
        processedAt: finalStatus === "PROCESSED" ? new Date() : null,
      },
    });
    await (db as any).crmWebsiteSubmissionEmailRule.update({
      where: { id: rule.id },
      data: { lastMatchedAt: new Date() },
    }).catch(() => undefined);

    if (contactId) {
      const title = finalStatus === "PENDING_REVIEW" ? "Website submission needs review" : "New website submission";
      const body = [
        `Rule: ${rule.name}`,
        `Confidence: ${Math.round(confidence * 100)}%`,
        attachmentSummary.length ? `Documents received: ${attachmentSummary.length}` : null,
        summaryLines.length ? `Summary: ${summaryLines.slice(0, 2).join("; ")}` : null,
      ].filter(Boolean).join("\n");
      await writeTimelineEvent({
        tenantId: input.tenantId,
        contactId,
        type: "WEBSITE_SUBMISSION",
        title,
        body: redactSensitiveText(body).slice(0, 2000),
        metadata: {
          submissionId: submission.id,
          ruleId: rule.id,
          ruleName: rule.name,
          confidence,
          documentCount: attachmentSummary.length,
          status: finalStatus,
        },
        linkedId: submission.id,
      });
      if (assignedUserId) {
        await (db as any).crmUserNotification.create({
          data: {
            tenantId: input.tenantId,
            userId: assignedUserId,
            title: "New website submission",
            body: redactSensitiveText(`${displayNameFromFields(extraction.fields, input.fromEmail)} from ${rule.name}. Documents: ${attachmentSummary.length}. Confidence: ${Math.round(confidence * 100)}%.`),
            route: `/crm/contacts/${contactId}`,
            kind: "CRM_WEBSITE_SUBMISSION",
            metadata: { submissionId: submission.id, contactId, ruleId: rule.id, status: finalStatus, documentCount: attachmentSummary.length },
          },
        }).catch(() => undefined);
      }
    } else if (assignedUserId) {
      await (db as any).crmUserNotification.create({
        data: {
          tenantId: input.tenantId,
          userId: assignedUserId,
          title: "Website submission needs review",
          body: redactSensitiveText(`${displayNameFromFields(extraction.fields, input.fromEmail)} from ${rule.name}. Confidence: ${Math.round(confidence * 100)}%.`),
          route: "/crm/settings",
          kind: "CRM_WEBSITE_SUBMISSION",
          metadata: { submissionId: submission.id, ruleId: rule.id, status: finalStatus, documentCount: 0 },
        },
      }).catch(() => undefined);
    }
    return { matched: true, submissionId: submission.id, contactId, status: finalStatus };
  } catch (err) {
    const safeError = err instanceof Error ? redactSensitiveText(err.message).slice(0, 300) : "processing_failed";
    await (db as any).crmWebsiteSubmission.update({
      where: { id: submission.id },
      data: { status: "FAILED", safeError },
    }).catch(() => undefined);
    return { matched: true, submissionId: submission.id, status: "FAILED", reason: safeError };
  }
}
