import * as crypto from "node:crypto";
import { db } from "@connect/db";
import { canonicalPortalOrigin } from "../publicOrigins";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { resolveImplicitSenderConnectionOrder } from "./crmEmailHelpers";
import { queueCrmEmailSend } from "./crmEmailQueue";
import { writeTimelineEvent } from "./timelineHelper";
import {
  assertPdfUpload,
  buildCrmFormCompletedStorageKey,
  buildCrmFormTemplateStorageKey,
  extractBasicPdfMetadata,
  readCrmFormFile,
  writeCrmFormFile,
} from "./formStorage";
import { writeCrmDocFile } from "./docImportStorage";
import {
  formatFormField,
  generateFormToken,
  hashFormToken,
  normalizeFieldInputs,
  publicFormDto,
  validateSubmission,
  type CrmFormFieldInput,
} from "./formCore";
export { formatFormField, publicFormDto } from "./formCore";

const DEFAULT_EXPIRES_DAYS = 14;

export function hashPublicIp(ip: string | undefined | null): string | null {
  const value = String(ip || "").trim();
  if (!value) return null;
  const secret = process.env.CRM_FORM_AUDIT_HASH_SECRET || process.env.CDR_INGEST_SECRET || "dev-form-audit-secret";
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function buildPublicFormUrl(token: string): string {
  const base = canonicalPortalOrigin();
  return `${base}/forms/sign/${encodeURIComponent(token)}`;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function formatFormTemplate(row: any) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    originalFileName: row.originalFileName,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    status: row.status,
    pageCount: row.pageCount ?? null,
    pdfMetadata: row.pdfMetadata ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    timesSent: Number(row._count?.requests ?? row.timesSent ?? 0),
    completedCount: Number(row._count?.submissions ?? row.completedCount ?? 0),
  };
}

export function formatFormRequest(row: any) {
  return {
    id: row.id,
    contactId: row.contactId,
    formTemplateId: row.formTemplateId,
    formName: row.formTemplate?.name ?? null,
    status: row.status,
    recipientEmail: row.recipientEmail,
    message: row.message ?? null,
    expiresAt: toIso(row.expiresAt),
    sentAt: toIso(row.sentAt),
    openedAt: toIso(row.openedAt),
    completedAt: toIso(row.completedAt),
    revokedAt: toIso(row.revokedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    submissionId: row.submission?.id ?? null,
    completedPdfAvailable: Boolean(row.submission?.completedPdfStorageKey),
  };
}

export async function createFormTemplate(input: {
  tenantId: string;
  userId: string;
  fileName: string;
  mimeType?: string | null;
  buffer: Buffer;
  name?: string;
  description?: string | null;
  category?: string | null;
}) {
  assertPdfUpload({ buffer: input.buffer, mimeType: input.mimeType, fileName: input.fileName });
  const id = crypto.randomUUID();
  const storageKey = buildCrmFormTemplateStorageKey(input.tenantId, id);
  const stored = await writeCrmFormFile(storageKey, input.buffer);
  const metadata = extractBasicPdfMetadata(input.buffer);
  const template = await (db as any).crmFormTemplate.create({
    data: {
      id,
      tenantId: input.tenantId,
      name: (input.name || input.fileName.replace(/\.pdf$/i, "") || "Untitled form").slice(0, 160),
      description: input.description || null,
      category: input.category || null,
      originalFileName: input.fileName,
      storageKey,
      mimeType: "application/pdf",
      sizeBytes: BigInt(stored.sizeBytes),
      status: "DRAFT",
      pageCount: metadata.pageCount,
      pdfMetadata: { ...metadata.pdfMetadata, contentHash: stored.contentHash },
      createdByUserId: input.userId,
    },
    include: { _count: { select: { requests: true, submissions: true } } },
  });
  return template;
}

export async function replaceFormFields(tenantId: string, formTemplateId: string, fields: CrmFormFieldInput[]) {
  const template = await (db as any).crmFormTemplate.findFirst({ where: { id: formTemplateId, tenantId } });
  if (!template) throw Object.assign(new Error("form_not_found"), { code: "form_not_found" });
  const normalized = normalizeFieldInputs(fields) as Array<CrmFormFieldInput & { sortOrder: number }>;
  await db.$transaction(async (tx: any) => {
    await tx.crmFormField.deleteMany({ where: { tenantId, formTemplateId } });
    if (normalized.length) {
      await tx.crmFormField.createMany({
        data: normalized.map((field) => ({
          tenantId,
          formTemplateId,
          fieldType: field.fieldType,
          label: field.label,
          autoFillToken: (field as any).autoFillToken ?? null,
          required: Boolean(field.required),
          pageNumber: field.pageNumber,
          x: field.x,
          y: field.y,
          width: field.width,
          height: field.height,
          sortOrder: field.sortOrder,
        })),
      });
    }
  });
  return (db as any).crmFormField.findMany({ where: { tenantId, formTemplateId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
}

async function resolveSenderConnection(tenantId: string, userId: string) {
  const rows = await (db as any).crmEmailConnection.findMany({
    where: {
      tenantId,
      status: "CONNECTED",
      OR: [{ scope: "TENANT" }, { scope: "USER", userId }],
    },
    select: { id: true, emailAddress: true, senderName: true, displayName: true, scope: true, userId: true, isDefaultForTenant: true },
  });
  return resolveImplicitSenderConnectionOrder(rows, userId) as { id: string } | null;
}

export async function createAndSendFormRequest(input: {
  tenantId: string;
  userId: string;
  contactId: string;
  formTemplateId: string;
  recipientEmail: string;
  message?: string | null;
  expiresInDays?: number;
}) {
  let template = await (db as any).crmFormTemplate.findFirst({
    where: { id: input.formTemplateId, tenantId: input.tenantId, status: { in: ["ACTIVE", "DRAFT"] } },
    include: { fields: true },
  });
  if (!template) throw Object.assign(new Error("form_not_found"), { code: "form_not_found" });
  // Auto-activate DRAFT templates on first send
  if (template.status === "DRAFT") {
    await (db as any).crmFormTemplate.updateMany({
      where: { id: template.id, tenantId: input.tenantId },
      data: { status: "ACTIVE" },
    });
    template = { ...template, status: "ACTIVE" };
  }
  const sender = await resolveSenderConnection(input.tenantId, input.userId);
  const { token, tokenHash } = generateFormToken();
  const expiresDays = Math.max(1, Math.min(60, Number(input.expiresInDays || DEFAULT_EXPIRES_DAYS)));
  const request = await (db as any).crmFormRequest.create({
    data: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      formTemplateId: input.formTemplateId,
      status: "SENT",
      recipientEmail: input.recipientEmail,
      tokenHash,
      message: input.message ? String(input.message).slice(0, 2000) : null,
      expiresAt: new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000),
      createdByUserId: input.userId,
    },
    include: { formTemplate: true, submission: true },
  });
  const publicUrl = buildPublicFormUrl(token);
  let emailSent = false;
  if (sender) {
    const bodyText = [
      input.message?.trim() || `Please complete and sign ${template.name}.`,
      "",
      `Open secure form link: ${publicUrl}`,
      "",
      `This link expires on ${request.expiresAt.toISOString()}.`,
    ].join("\n");
    const bodyHtml = [
      `<p>${escapeHtml(input.message?.trim() || `Please complete and sign ${template.name}.`)}</p>`,
      `<p><a href="${escapeHtml(publicUrl)}">Open secure form</a></p>`,
      `<p style="color:#64748b;font-size:13px">This link expires on ${escapeHtml(request.expiresAt.toISOString())}.</p>`,
    ].join("");
    try {
      await queueCrmEmailSend({
        tenantId: input.tenantId,
        userId: input.userId,
        connectionId: sender.id,
        to: input.recipientEmail,
        subject: `Please complete: ${template.name}`,
        bodyText,
        bodyHtml,
        contactId: input.contactId,
      });
      emailSent = true;
    } catch {
      // Email queuing failed — request is still created; caller can share the link manually
    }
  }
  await writeTimelineEvent({
    tenantId: input.tenantId,
    contactId: input.contactId,
    type: "FORM_SENT",
    title: `Form sent: ${template.name}`,
    body: emailSent ? `Sent to ${input.recipientEmail}.` : `Link generated for ${input.recipientEmail} (no email sender configured).`,
    linkedId: request.id,
    createdByUserId: input.userId,
    metadata: { formTemplateId: template.id, formRequestId: request.id, emailSent },
  });
  return { request, publicUrl, emailSent };
}

export async function resendFormRequest(input: { tenantId: string; userId: string; requestId: string }) {
  const existing = await (db as any).crmFormRequest.findFirst({
    where: { id: input.requestId, tenantId: input.tenantId },
    include: { formTemplate: true },
  });
  if (!existing) throw Object.assign(new Error("request_not_found"), { code: "request_not_found" });
  if (existing.status === "COMPLETED") throw Object.assign(new Error("already_completed"), { code: "already_completed" });
  if (existing.status === "REVOKED") throw Object.assign(new Error("revoked"), { code: "revoked" });
  const sender = await resolveSenderConnection(input.tenantId, input.userId);
  const { token, tokenHash } = generateFormToken();
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  const request = await (db as any).crmFormRequest.update({
    where: { id: existing.id },
    data: {
      tokenHash,
      status: "SENT",
      sentAt: new Date(),
      openedAt: null,
      expiresAt,
    },
    include: { formTemplate: true, submission: true },
  });
  const publicUrl = buildPublicFormUrl(token);
  let emailSent = false;
  if (sender) {
    await queueCrmEmailSend({
      tenantId: input.tenantId,
      userId: input.userId,
      connectionId: sender.id,
      to: existing.recipientEmail,
      subject: `Reminder: please complete ${existing.formTemplate.name}`,
      bodyText: [
        `Reminder: please complete and sign ${existing.formTemplate.name}.`,
        "",
        `Open secure form link: ${publicUrl}`,
        "",
        `This link expires on ${expiresAt.toISOString()}.`,
      ].join("\n"),
      bodyHtml: [
        `<p>Reminder: please complete and sign ${escapeHtml(existing.formTemplate.name)}.</p>`,
        `<p><a href="${escapeHtml(publicUrl)}">Open secure form</a></p>`,
        `<p style="color:#64748b;font-size:13px">This link expires on ${escapeHtml(expiresAt.toISOString())}.</p>`,
      ].join(""),
      contactId: existing.contactId,
    });
    emailSent = true;
  }
  await writeTimelineEvent({
    tenantId: input.tenantId,
    contactId: existing.contactId,
    type: "FORM_SENT",
    title: `Form resent: ${existing.formTemplate.name}`,
    body: emailSent ? `Resent to ${existing.recipientEmail}.` : `Link regenerated for ${existing.recipientEmail} (no email sender configured).`,
    linkedId: existing.id,
    createdByUserId: input.userId,
    metadata: { formTemplateId: existing.formTemplateId, formRequestId: existing.id, resent: true },
  });
  return { request, publicUrl, emailSent };
}

export async function revokeFormRequest(input: { tenantId: string; userId: string; requestId: string }) {
  const existing = await (db as any).crmFormRequest.findFirst({
    where: { id: input.requestId, tenantId: input.tenantId },
    include: { formTemplate: true, submission: true },
  });
  if (!existing) throw Object.assign(new Error("request_not_found"), { code: "request_not_found" });
  if (existing.status === "COMPLETED") throw Object.assign(new Error("already_completed"), { code: "already_completed" });
  const request = await (db as any).crmFormRequest.update({
    where: { id: existing.id },
    data: { status: "REVOKED", revokedAt: existing.revokedAt || new Date() },
    include: { formTemplate: true, submission: true },
  });
  await writeTimelineEvent({
    tenantId: input.tenantId,
    contactId: existing.contactId,
    type: "FORM_REVOKED",
    title: `Form revoked: ${existing.formTemplate.name}`,
    linkedId: existing.id,
    createdByUserId: input.userId,
    metadata: { formTemplateId: existing.formTemplateId, formRequestId: existing.id },
  });
  return request;
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPdfDate(value: unknown): string {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[2]}/${match[3]}/${match[1]}`;
  return raw;
}

function isImageDataUrl(value: unknown): boolean {
  return /^data:image\/(?:png|jpeg|jpg);base64,/i.test(String(value ?? ""));
}

function imageBytesFromDataUrl(value: unknown): Buffer | null {
  const raw = String(value ?? "");
  const match = raw.match(/^data:image\/(?:png|jpeg|jpg);base64,(.+)$/i);
  if (!match?.[1]) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

function pdfRectForField(field: any, pageFields: any[]) {
  const sameRow = pageFields
    .filter((other) => other.id !== field.id && Math.abs(Number(other.y || 0) - Number(field.y || 0)) <= 2 && Number(other.x || 0) > Number(field.x || 0) && Number(other.x || 0) < Number(field.x || 0) + Number(field.width || 0))
    .sort((a, b) => Number(a.x || 0) - Number(b.x || 0));
  if (sameRow[0]) {
    return { ...field, width: Math.max(1, Number(sameRow[0].x || 0) - Number(field.x || 0)) };
  }

  const precedingOverlap = pageFields
    .filter((other) => other.id !== field.id && Math.abs(Number(other.y || 0) - Number(field.y || 0)) <= 2 && Number(other.x || 0) < Number(field.x || 0) && Number(field.x || 0) < Number(other.x || 0) + Number(other.width || 0))
    .sort((a, b) => Number(a.x || 0) - Number(b.x || 0));
  if (precedingOverlap.length > 0) {
    const rowStart = precedingOverlap[0];
    const rowEnd = Number(rowStart.x || 0) + Number(rowStart.width || 0);
    return { ...field, width: Math.max(1, rowEnd - Number(field.x || 0)) };
  }

  return field;
}

async function buildCompletedFormPdf(request: any, submittedData: Record<string, unknown>): Promise<Buffer> {
  const original = await readCrmFormFile(request.formTemplate.storageKey);
  const pdf = await PDFDocument.load(original);
  const textFont = await pdf.embedFont(StandardFonts.Helvetica);
  const signatureFont = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const pages = pdf.getPages();

  const fields = request.formTemplate.fields || [];
  for (const originalField of fields) {
    const pageFields = fields.filter((f: any) => Number(f.pageNumber || 1) === Number(originalField.pageNumber || 1));
    const field = pdfRectForField(originalField, pageFields);
    const page = pages[Math.max(0, Number(field.pageNumber || 1) - 1)];
    if (!page) continue;

    const value = submittedData[field.id];
    const text = field.fieldType === "DATE" ? formatPdfDate(value) : String(value ?? "").trim();
    const x = Number(field.x || 0);
    const y = Number(field.y || 0);
    const width = Math.max(1, Number(field.width || 1));
    const height = Math.max(1, Number(field.height || 1));
    const pdfY = page.getHeight() - y - height;

    if (field.fieldType === "CHECKBOX") {
      if (value === true) {
        page.drawText("X", {
          x,
          y: pdfY + 1,
          size: Math.max(8, Math.min(height, 14)),
          font: textFont,
          color: rgb(0, 0, 0),
        });
      }
      continue;
    }

    if (!text) continue;

    if (field.fieldType === "SIGNATURE" || field.fieldType === "INITIALS") {
      const imageBytes = imageBytesFromDataUrl(value);
      if (imageBytes && isImageDataUrl(value)) {
        try {
          const image = String(value).startsWith("data:image/jpeg") || String(value).startsWith("data:image/jpg")
            ? await pdf.embedJpg(imageBytes)
            : await pdf.embedPng(imageBytes);
          page.drawImage(image, { x, y: pdfY, width, height });
          continue;
        } catch {
          // Fall back to typed text if image embedding fails.
        }
      }
      let size = Math.max(10, Math.min(height * 1.55, 22));
      while (size > 7 && signatureFont.widthOfTextAtSize(text, size) > width) size -= 0.5;
      page.drawText(text, {
        x,
        y: pdfY + (height - size) / 2 + size * 0.25,
        size,
        font: signatureFont,
        color: rgb(0, 0, 0),
      });
      continue;
    }

    let size = Math.max(7, Math.min(height * 0.9, 10));
    while (size > 5 && textFont.widthOfTextAtSize(text, size) > width) size -= 0.5;
    const centerText = field.fieldType === "DATE" || /^(city|state|zip(?: code)?)$/i.test(String(field.label || "").trim());
    const textWidth = textFont.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: centerText ? x + Math.max(0, (width - textWidth) / 2) : x + 1,
      y: pdfY + (height - size) / 2 + size * 0.25,
      size,
      font: textFont,
      color: rgb(0, 0, 0),
    });
  }

  return Buffer.from(await pdf.save());
}

export async function loadPublicFormRequest(token: string, markOpened = false) {
  const tokenHash = hashFormToken(token);

  const request = await (db as any).crmFormRequest.findUnique({
    where: { tokenHash },
    include: {
      formTemplate: {
        include: {
          fields: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
          tenant: { select: { name: true } },
        },
      },
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          displayName: true,
          company: true,
          title: true,
          phones: {
            select: { numberRaw: true, type: true, isPrimary: true },
            orderBy: { isPrimary: "desc" },
          },
          emails: {
            select: { email: true, isPrimary: true },
            orderBy: { isPrimary: "desc" },
          },
          addresses: {
            select: { street: true, city: true, state: true, zip: true, country: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
          crmMeta: {
            select: {
              stage: true,
              assignedTo: { select: { id: true, displayName: true, firstName: true, lastName: true, email: true } },
            },
          },
          intelligenceReport: {
            select: { discoveredEntities: true, keyFindings: true },
          },
        },
      },
      submission: true,
    },
  });
  if (!request) throw Object.assign(new Error("invalid_token"), { code: "invalid_token" });
  if (request.status === "REVOKED") throw Object.assign(new Error("revoked"), { code: "revoked" });
  if (request.status === "COMPLETED") return request;
  if (request.expiresAt < new Date()) {
    await (db as any).crmFormRequest.updateMany({
      where: { id: request.id, status: { in: ["SENT", "OPENED"] } },
      data: { status: "EXPIRED" },
    });
    throw Object.assign(new Error("expired"), { code: "expired" });
  }
  if (markOpened && request.status === "SENT") {
    await (db as any).crmFormRequest.update({
      where: { id: request.id },
      data: { status: "OPENED", openedAt: new Date() },
    });
    await writeTimelineEvent({
      tenantId: request.tenantId,
      contactId: request.contactId,
      type: "FORM_OPENED",
      title: `Form opened: ${request.formTemplate.name}`,
      linkedId: request.id,
      metadata: { formTemplateId: request.formTemplateId, formRequestId: request.id },
    });
  }
  return request;
}

export async function submitPublicForm(input: {
  token: string;
  submittedData: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}) {
  const request = await loadPublicFormRequest(input.token, true);
  if (request.status === "COMPLETED") throw Object.assign(new Error("already_completed"), { code: "already_completed" });
  const validation = validateSubmission(request.formTemplate.fields || [], input.submittedData);
  if (!validation.ok) throw Object.assign(new Error("validation_failed"), { code: "validation_failed", errors: validation.errors });
  const submissionId = crypto.randomUUID();
  const leadDocumentId = crypto.randomUUID();
  const completedFileName = `${String(request.formTemplate.name || "completed-form").replace(/[^\w.-]+/g, "_")}-signed.pdf`;
  const completedPdf = await buildCompletedFormPdf(request, validation.sanitized);
  const completedPdfStorageKey = buildCrmFormCompletedStorageKey(request.tenantId, submissionId);
  const completedStored = await writeCrmFormFile(completedPdfStorageKey, completedPdf);
  const leadDocStored = await writeCrmDocFile({
    tenantId: request.tenantId,
    docId: leadDocumentId,
    buffer: completedPdf,
    mimeType: "application/pdf",
    originalFileName: completedFileName,
  });
  const result = await db.$transaction(async (tx: any) => {
    const submission = await tx.crmFormSubmission.create({
      data: {
        id: submissionId,
        tenantId: request.tenantId,
        formRequestId: request.id,
        contactId: request.contactId,
        formTemplateId: request.formTemplateId,
        submittedData: validation.sanitized,
        completedPdfStorageKey,
        ipAddressHash: hashPublicIp(input.ipAddress),
        userAgent: input.userAgent ? String(input.userAgent).slice(0, 500) : null,
      },
    });
    const document = await tx.crmLeadDocument.create({
      data: {
        id: leadDocumentId,
        tenantId: request.tenantId,
        contactId: request.contactId,
        source: "MANUAL_UPLOAD",
        originalFileName: completedFileName,
        mimeType: "application/pdf",
        importedMimeType: "application/pdf",
        sizeBytes: BigInt(leadDocStored.storedBytes),
        contentHash: leadDocStored.contentHash,
        storageKey: leadDocStored.storageKey,
        status: "IMPORTED",
        matchConfidence: "HIGH",
        matchReason: "completed_crm_form",
        reviewedByUserId: request.createdByUserId ?? null,
        reviewedAt: new Date(),
        importedAt: new Date(),
      },
    });
    const updated = await tx.crmFormRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", completedAt: submission.submittedAt },
      include: { formTemplate: true, submission: true },
    });
    return { submission, document, request: updated };
  });
  await writeTimelineEvent({
    tenantId: request.tenantId,
    contactId: request.contactId,
    type: "FORM_COMPLETED",
    title: `Form completed: ${request.formTemplate.name}`,
    body: `Signed PDF uploaded to Files as ${completedFileName}.`,
    linkedId: request.id,
    metadata: {
      formTemplateId: request.formTemplateId,
      formRequestId: request.id,
      submissionId: result.submission.id,
      completedPdfStorageKey,
      completedPdfBytes: completedStored.sizeBytes,
      leadDocumentId: result.document.id,
      completedFileName,
      notifyUserId: request.createdByUserId ?? null,
    },
  });
  return result;
}
