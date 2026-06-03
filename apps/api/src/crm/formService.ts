import * as crypto from "node:crypto";
import { db } from "@connect/db";
import { resolveImplicitSenderConnectionOrder } from "./crmEmailHelpers";
import { queueCrmEmailSend } from "./crmEmailQueue";
import { writeTimelineEvent } from "./timelineHelper";
import {
  assertPdfUpload,
  buildCrmFormTemplateStorageKey,
  extractBasicPdfMetadata,
  writeCrmFormFile,
} from "./formStorage";
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
  const base = (
    process.env.PUBLIC_PORTAL_URL ||
    process.env.PORTAL_PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    "https://app.connectcomunications.com"
  ).replace(/\/+$/, "");
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
  const template = await (db as any).crmFormTemplate.findFirst({
    where: { id: input.formTemplateId, tenantId: input.tenantId, status: "ACTIVE" },
    include: { fields: true },
  });
  if (!template) throw Object.assign(new Error("form_not_found"), { code: "form_not_found" });
  const sender = await resolveSenderConnection(input.tenantId, input.userId);
  if (!sender) throw Object.assign(new Error("no_sender_available"), { code: "no_sender_available" });
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
  await writeTimelineEvent({
    tenantId: input.tenantId,
    contactId: input.contactId,
    type: "FORM_SENT",
    title: `Form sent: ${template.name}`,
    body: `Sent to ${input.recipientEmail}.`,
    linkedId: request.id,
    createdByUserId: input.userId,
    metadata: { formTemplateId: template.id, formRequestId: request.id },
  });
  return { request, publicUrl };
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
  if (!sender) throw Object.assign(new Error("no_sender_available"), { code: "no_sender_available" });
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
  await writeTimelineEvent({
    tenantId: input.tenantId,
    contactId: existing.contactId,
    type: "FORM_SENT",
    title: `Form resent: ${existing.formTemplate.name}`,
    body: `Resent to ${existing.recipientEmail}.`,
    linkedId: existing.id,
    createdByUserId: input.userId,
    metadata: { formTemplateId: existing.formTemplateId, formRequestId: existing.id, resent: true },
  });
  return { request, publicUrl };
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

export async function loadPublicFormRequest(token: string, markOpened = false) {
  const tokenHash = hashFormToken(token);
  const request = await (db as any).crmFormRequest.findUnique({
    where: { tokenHash },
    include: {
      formTemplate: { include: { fields: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } } },
      contact: { select: { id: true, displayName: true, company: true } },
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
  const result = await db.$transaction(async (tx: any) => {
    const submission = await tx.crmFormSubmission.create({
      data: {
        tenantId: request.tenantId,
        formRequestId: request.id,
        contactId: request.contactId,
        formTemplateId: request.formTemplateId,
        submittedData: validation.sanitized,
        completedPdfStorageKey: null,
        ipAddressHash: hashPublicIp(input.ipAddress),
        userAgent: input.userAgent ? String(input.userAgent).slice(0, 500) : null,
      },
    });
    const updated = await tx.crmFormRequest.update({
      where: { id: request.id },
      data: { status: "COMPLETED", completedAt: submission.submittedAt },
      include: { formTemplate: true, submission: true },
    });
    return { submission, request: updated };
  });
  await writeTimelineEvent({
    tenantId: request.tenantId,
    contactId: request.contactId,
    type: "FORM_COMPLETED",
    title: `Form completed: ${request.formTemplate.name}`,
    linkedId: request.id,
    metadata: { formTemplateId: request.formTemplateId, formRequestId: request.id, submissionId: result.submission.id },
  });
  return result;
}
