import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess } from "./guard";
import { assertCrmContactAllowed } from "./crmContactAccess";
import { readCrmFormFile } from "./formStorage";
import {
  createAndSendFormRequest,
  createFormTemplate,
  formatFormField,
  formatFormRequest,
  formatFormTemplate,
  loadPublicFormRequest,
  publicFormDto,
  replaceFormFields,
  resendFormRequest,
  revokeFormRequest,
  submitPublicForm,
} from "./formService";

const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  category: z.string().trim().max(120).nullable().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});

const sendFormSchema = z.object({
  formTemplateId: z.string().min(1),
  recipientEmail: z.string().email(),
  message: z.string().max(2000).optional(),
  expiresInDays: z.number().int().min(1).max(60).optional(),
});

async function readMultipartUpload(req: FastifyRequest): Promise<{
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  fields: Record<string, string>;
}> {
  const fields: Record<string, string> = {};
  let buffer: Buffer | null = null;
  let fileName = "form.pdf";
  let mimeType = "application/pdf";
  const parts = (req as any).parts();
  for await (const part of parts as AsyncIterable<any>) {
    if (part.type === "file" && part.fieldname === "file") {
      fileName = String(part.filename || fileName);
      mimeType = String(part.mimetype || mimeType);
      buffer = await part.toBuffer();
    } else if (part.type === "field") {
      const key = String(part.fieldname || "");
      if (key) fields[key] = String(part.value ?? "").trim();
    }
  }
  if (!buffer?.length) throw Object.assign(new Error("file_required"), { code: "file_required" });
  return { buffer, fileName, mimeType, fields };
}

function sendRouteError(reply: any, err: any) {
  const code = String(err?.code || err?.message || "error");
  if (code === "form_not_found" || code === "request_not_found") return reply.code(404).send({ error: code });
  if (code === "no_sender_available") return reply.code(409).send({ error: code });
  if (code === "already_completed" || code === "revoked") return reply.code(409).send({ error: code });
  if (code === "file_too_large") return reply.code(413).send({ error: code });
  if (code === "pdf_required" || code.startsWith("invalid_")) return reply.code(400).send({ error: code });
  console.error("[CRM][forms] route failed", { code, err });
  return reply.code(500).send({ error: "form_operation_failed" });
}

function sendPublicError(reply: any, err: any) {
  const code = String(err?.code || err?.message || "invalid_token");
  if (code === "expired") return reply.code(410).send({ error: "expired" });
  if (code === "revoked") return reply.code(410).send({ error: "revoked" });
  if (code === "already_completed") return reply.code(409).send({ error: "already_completed" });
  if (code === "validation_failed") return reply.code(400).send({ error: "validation_failed", fields: err.errors || {} });
  return reply.code(404).send({ error: "invalid_token" });
}

async function assertFormRequestContactAllowed(user: { tenantId: string; sub: string; role?: string }, requestId: string, reply: any): Promise<boolean> {
  const request = await (db as any).crmFormRequest.findFirst({
    where: { id: requestId, tenantId: user.tenantId },
    select: { contactId: true },
  });
  if (!request) {
    reply.code(404).send({ error: "request_not_found" });
    return false;
  }
  return assertCrmContactAllowed(user, request.contactId, reply);
}

export async function registerCrmFormRoutes(app: FastifyInstance) {
  app.get("/crm/forms", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const query = req.query as any;
    const search = String(query?.search || "").trim();
    const status = String(query?.status || "").toUpperCase();
    const where: any = { tenantId: user.tenantId };
    if (["DRAFT", "ACTIVE", "ARCHIVED"].includes(status)) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { category: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }
    const [rows, totals] = await Promise.all([
      (db as any).crmFormTemplate.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 200,
        include: { _count: { select: { requests: true, submissions: true } } },
      }),
      (db as any).crmFormTemplate.groupBy({ by: ["status"], where: { tenantId: user.tenantId }, _count: { _all: true } }),
    ]);
    return {
      forms: rows.map(formatFormTemplate),
      stats: totals.reduce((acc: any, row: any) => ({ ...acc, [row.status]: row._count._all }), {}),
    };
  });

  app.post("/crm/forms/upload", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    if (!(req as any).isMultipart?.()) return reply.code(400).send({ error: "multipart_required" });
    try {
      const upload = await readMultipartUpload(req);
      const template = await createFormTemplate({
        tenantId: user.tenantId,
        userId: user.sub,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        buffer: upload.buffer,
        name: upload.fields.name,
        description: upload.fields.description,
        category: upload.fields.category,
      });
      return reply.code(201).send({ form: formatFormTemplate(template) });
    } catch (err: any) {
      return sendRouteError(reply, err);
    }
  });

  app.get("/crm/forms/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await (db as any).crmFormTemplate.findFirst({
      where: { id, tenantId: user.tenantId },
      include: {
        fields: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
        _count: { select: { requests: true, submissions: true } },
      },
    });
    if (!row) return reply.code(404).send({ error: "form_not_found" });
    return { form: formatFormTemplate(row), fields: row.fields.map(formatFormField) };
  });

  app.put("/crm/forms/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const parsed = updateTemplateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    const updated = await (db as any).crmFormTemplate.updateMany({ where: { id, tenantId: user.tenantId }, data: parsed.data });
    if (!updated.count) return reply.code(404).send({ error: "form_not_found" });
    const row = await (db as any).crmFormTemplate.findFirst({ where: { id, tenantId: user.tenantId }, include: { _count: { select: { requests: true, submissions: true } } } });
    return { form: formatFormTemplate(row) };
  });

  app.post("/crm/forms/:id/archive", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const updated = await (db as any).crmFormTemplate.updateMany({ where: { id, tenantId: user.tenantId }, data: { status: "ARCHIVED" } });
    if (!updated.count) return reply.code(404).send({ error: "form_not_found" });
    return { ok: true };
  });

  app.get("/crm/forms/:id/fields", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const template = await (db as any).crmFormTemplate.findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
    if (!template) return reply.code(404).send({ error: "form_not_found" });
    const fields = await (db as any).crmFormField.findMany({ where: { tenantId: user.tenantId, formTemplateId: id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
    return { fields: fields.map(formatFormField) };
  });

  app.put("/crm/forms/:id/fields", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    try {
      const fields = await replaceFormFields(user.tenantId, id, (req.body as any)?.fields || []);
      return { fields: fields.map(formatFormField) };
    } catch (err: any) {
      return sendRouteError(reply, err);
    }
  });

  app.get("/crm/forms/:id/preview", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    const row = await (db as any).crmFormTemplate.findFirst({ where: { id, tenantId: user.tenantId }, select: { storageKey: true, originalFileName: true } });
    if (!row) return reply.code(404).send({ error: "form_not_found" });
    const buffer = await readCrmFormFile(row.storageKey);
    const filename = String(row.originalFileName || "form.pdf").replace(/[^\w.-]+/g, "_");
    return reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Disposition", `inline; filename="${filename}"`)
      .type("application/pdf")
      .send(buffer);
  });

  app.get("/crm/contacts/:id/forms", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await assertCrmContactAllowed(user, id, reply))) return;
    const [requests, templates] = await Promise.all([
      (db as any).crmFormRequest.findMany({
        where: { tenantId: user.tenantId, contactId: id },
        orderBy: { createdAt: "desc" },
        include: { formTemplate: true, submission: true },
        take: 100,
      }),
      (db as any).crmFormTemplate.findMany({
        where: { tenantId: user.tenantId, status: "ACTIVE" },
        orderBy: { name: "asc" },
        select: { id: true, name: true, category: true },
      }),
    ]);
    return { requests: requests.map(formatFormRequest), templates };
  });

  app.post("/crm/contacts/:id/forms/send", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const { id } = req.params as { id: string };
    if (!(await assertCrmContactAllowed(user, id, reply))) return;
    const parsed = sendFormSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", detail: parsed.error.format() });
    try {
      const result = await createAndSendFormRequest({
        tenantId: user.tenantId,
        userId: user.sub,
        contactId: id,
        ...parsed.data,
      });
      return reply.code(201).send({ request: formatFormRequest(result.request) });
    } catch (err: any) {
      return sendRouteError(reply, err);
    }
  });

  app.post("/crm/forms/requests/:id/resend", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const requestId = (req.params as any).id;
    if (!(await assertFormRequestContactAllowed(user, requestId, reply))) return;
    try {
      const result = await resendFormRequest({ tenantId: user.tenantId, userId: user.sub, requestId });
      return { request: formatFormRequest(result.request) };
    } catch (err: any) {
      return sendRouteError(reply, err);
    }
  });

  app.post("/crm/forms/requests/:id/revoke", async (req, reply) => {
    const user = await requireCrmAccess(req, reply); if (!user) return;
    const requestId = (req.params as any).id;
    if (!(await assertFormRequestContactAllowed(user, requestId, reply))) return;
    try {
      const request = await revokeFormRequest({ tenantId: user.tenantId, userId: user.sub, requestId });
      return { request: formatFormRequest(request) };
    } catch (err: any) {
      return sendRouteError(reply, err);
    }
  });

  app.get("/public/forms/:token", async (req, reply) => {
    try {
      const request = await loadPublicFormRequest((req.params as any).token, true);
      return publicFormDto(request);
    } catch (err: any) {
      return sendPublicError(reply, err);
    }
  });

  app.get("/public/forms/:token/pdf", async (req, reply) => {
    try {
      const request = await loadPublicFormRequest((req.params as any).token, true);
      if (request.status === "COMPLETED") {
        return reply.code(409).send({ error: "already_completed" });
      }
      const buffer = await readCrmFormFile(request.formTemplate.storageKey);
      const filename = String(request.formTemplate.originalFileName || "form.pdf").replace(/[^\w.-]+/g, "_");
      return reply
        .header("Cache-Control", "private, no-store")
        .header("Content-Disposition", `inline; filename="${filename}"`)
        .type("application/pdf")
        .send(buffer);
    } catch (err: any) {
      return sendPublicError(reply, err);
    }
  });

  app.post("/public/forms/:token/submit", async (req, reply) => {
    try {
      const result = await submitPublicForm({
        token: (req.params as any).token,
        submittedData: ((req.body as any)?.submittedData || {}) as Record<string, unknown>,
        ipAddress: req.ip,
        userAgent: String(req.headers["user-agent"] || ""),
      });
      return { ok: true, submissionId: result.submission.id, completedAt: result.submission.submittedAt.toISOString(), completedPdfPending: true };
    } catch (err: any) {
      return sendPublicError(reply, err);
    }
  });
}
