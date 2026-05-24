import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { createPublicLinkSchema, adminStatusUpdateSchema, adminChecklistUpdateSchema, adminNotesUpdateSchema } from "./validation";
import { buildVitalPbxCsvForSubmission, listAdminSubmissions, readAdminSubmissionDetail, toPublicUrl, isValidStatusTransition } from "./provisioning";

function user(req: any): { sub?: string; role?: string } { return req.user as any; }
async function requireSuperAdmin(req: any, reply: any): Promise<{ sub?: string; role?: string } | null> {
  const u = user(req);
  if (!u || u.role !== "SUPER_ADMIN") { reply.code(403).send({ error: "forbidden" }); return null; }
  return u;
}

function generatePublicToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24)) as any).toString("base64url");
}

import { randomBytes } from "node:crypto";
function secureToken(): string { return randomBytes(24).toString("base64url"); }

export async function registerOnboardingProvisioningRoutes(app: FastifyInstance) {
  // Create a public onboarding link (SUPER_ADMIN only)
  app.post("/admin/onboarding/public-links", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const body = createPublicLinkSchema.parse((req as any).body || {});
    const token = secureToken();
    const created = await (db as any).onboardingSubmission.create({
      data: {
        publicToken: token,
        companyName: body.companyName || null,
        mainEmail: body.mainEmail || null,
        status: "INVITE_SENT",
        events: { create: { type: "CREATED", message: "Admin-created link" } },
      },
    });
    return { ok: true, token, link: toPublicUrl(token), submissionId: created.id };
  });

  // List submissions
  app.get("/admin/onboarding/submissions", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const list = await listAdminSubmissions(300);
    return { submissions: list };
  });

  // Detail
  app.get("/admin/onboarding/submissions/:id", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await readAdminSubmissionDetail(id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    return row;
  });

  // Status update
  app.post("/admin/onboarding/submissions/:id/status", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const body = adminStatusUpdateSchema.parse((req as any).body || {});
    const current = await (db as any).onboardingSubmission.findUnique({ where: { id }, select: { status: true } });
    if (!current) return reply.code(404).send({ error: "not_found" });
    if (!isValidStatusTransition(current.status, body.status)) {
      return reply.code(400).send({ error: "invalid_status_transition" });
    }
    await (db as any).onboardingSubmission.update({ where: { id }, data: { status: body.status } });
    await (db as any).onboardingEvent.create({ data: { submissionId: id, type: "STATUS_CHANGED", message: body.status } });
    return { ok: true };
  });

  // Checklist
  app.post("/admin/onboarding/submissions/:id/checklist", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const body = adminChecklistUpdateSchema.parse((req as any).body || {});
    await (db as any).onboardingSubmission.update({ where: { id }, data: { provisioningChecklist: body.provisioningChecklist } });
    await (db as any).onboardingEvent.create({ data: { submissionId: id, type: "CHECKLIST_UPDATED" } });
    return { ok: true };
  });

  // Notes
  app.post("/admin/onboarding/submissions/:id/notes", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const body = adminNotesUpdateSchema.parse((req as any).body || {});
    await (db as any).onboardingSubmission.update({ where: { id }, data: { internalNotes: body.internalNotes } });
    await (db as any).onboardingEvent.create({ data: { submissionId: id, type: "NOTES_UPDATED" } });
    return { ok: true };
  });

  // VitalPBX CSV export
  app.get("/admin/onboarding/submissions/:id/vitalpbx.csv", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const csv = await buildVitalPbxCsvForSubmission(id);
    if (!csv) return reply.code(404).send({ error: "not_found" });
    reply.header("content-type", csv.mime);
    reply.header("content-disposition", `attachment; filename=${JSON.stringify(csv.filename)}`);
    return csv.body;
  });

  // File download (admin-only)
  app.get("/admin/onboarding/submissions/:id/files/:fileId/download", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id, fileId } = (req.params as any) as { id: string; fileId: string };
    const file = await (db as any).onboardingUploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.submissionId !== id) return reply.code(404).send({ error: "not_found" });
    // Local storage read (paired with public upload path)
    const root = (process.env.ONBOARDING_STORAGE_DIR || require("node:path").resolve(process.cwd(), "data/onboarding-files")).replace(/\\/g, "/");
    const full = require("node:path").resolve(root, String(file.storageKey || ""));
    const fs = require("node:fs");
    if (!fs.existsSync(full)) return reply.code(404).send({ error: "missing_file" });
    reply.header("content-type", file.mimeType || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename=${JSON.stringify(file.filename || "file.bin")}`);
    const stream = fs.createReadStream(full);
    return reply.send(stream);
  });
}
