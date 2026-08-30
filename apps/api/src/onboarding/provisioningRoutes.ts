import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { createPublicLinkSchema, adminStatusUpdateSchema, adminChecklistUpdateSchema, adminNotesUpdateSchema } from "./validation";
import { buildVitalPbxCsvForSubmission, listAdminSubmissions, readAdminSubmissionDetail, toPublicUrl, isValidStatusTransition } from "./provisioning";
import { applyOnboardingNumber, syncOnboardingSms } from "./voipMsProvisioning";
import { resolveOnboardingStoragePath } from "./storage";
import { runOnboardingSetup } from "./setupOrchestrator";
import { registerOnboardingInvitationRoutes } from "./invitationRoutes";
import { buildLoaPdf, buildPortQueueRow } from "./portQueue";

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
  // The invite-and-analyse screens (list, one sign-up's story, patterns).
  // Same SUPER_ADMIN gate as everything else here, handed in explicitly so the
  // guard is visible at the registration site.
  await registerOnboardingInvitationRoutes(app, requireSuperAdmin);

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

  // Re-kick the automated setup pipeline for a submitted onboarding.
  // Safe to call after a failure or an interrupted run: every stage
  // (VoIP.ms number, SMS, PBX build, sync, invites) is idempotent and
  // resumes where it left off. Refuses while a run is genuinely in flight.
  app.post("/admin/onboarding/submissions/:id/retry-setup", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await (db as any).onboardingSubmission.findUnique({
      where: { id },
      select: { id: true, status: true, paidAt: true, pbxSetupStatus: true, updatedAt: true },
    });
    if (!row) return reply.code(404).send({ error: "not_found" });
    // Gate on what matters: paid, and not finished. The old allowlist named
    // two statuses that don't exist in the enum ("APPROVED"/"PROVISIONING")
    // and rejected the REAL recovery states (AWAITING_PBX_SETUP, ACTIVE with
    // a later partial failure) — the retry button 409'd exactly when needed.
    const retryableStatus = ["SUBMITTED", "AWAITING_PBX_SETUP", "AWAITING_PORT", "READY_TO_SYNC", "ACTIVE"].includes(String(row.status));
    if (!retryableStatus || !row.paidAt) {
      return reply.code(409).send({ error: "not_retryable", detail: `status is ${row.status}${row.paidAt ? "" : ", not paid"}` });
    }
    if (row.pbxSetupStatus === "done") return reply.code(409).send({ error: "already_done" });
    const inFlight = ["building", "syncing", "inviting"].includes(String(row.pbxSetupStatus || ""));
    const staleMs = Number(process.env.ONBOARDING_INFLIGHT_STALE_MS || 15 * 60_000);
    if (inFlight && Date.now() - new Date(row.updatedAt || 0).getTime() < staleMs) {
      return reply.code(409).send({ error: "setup_in_progress" });
    }
    await (db as any).onboardingEvent.create({
      data: { submissionId: id, type: "STATUS_CHANGED", message: `Setup retry requested by admin` },
    });
    void (async () => {
      await applyOnboardingNumber(id).catch(() => { /* logged inside */ });
      await syncOnboardingSms(id).catch(() => { /* logged inside */ });
      await runOnboardingSetup(id).catch(() => { /* logged inside */ });
    })();
    return { ok: true, status: "retrying" };
  });

  // Delete submission (SUPER_ADMIN only)
  app.delete("/admin/onboarding/submissions/:id", async (req, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const exists = await (db as any).onboardingSubmission.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return reply.code(404).send({ error: "not_found" });
    await (db as any).$transaction([
      (db as any).onboardingEvent.deleteMany({ where: { submissionId: id } }),
      (db as any).onboardingRequestedExtension.deleteMany({ where: { submissionId: id } }),
      (db as any).onboardingUploadedFile.deleteMany({ where: { submissionId: id } }),
      (db as any).onboardingSubmission.delete({ where: { id } }),
    ]);
    return { ok: true };
  });

  // ── The Port queue (SignalWire porting is a manual dashboard filing —
  // mockup screen B). Lists every submission whose provisioning stamped a
  // `portFiling` block; awaiting_manual_filing first, newest first inside
  // each group. JSON-path filtering in Prisma is the awkward half, so this
  // reads the recent rows and filters in JS — bounded, same as the list.
  app.get("/admin/onboarding/port-queue", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const rows = await (db as any).onboardingSubmission.findMany({
      orderBy: { updatedAt: "desc" },
      take: 300,
      select: { id: true, companyName: true, answers: true, submittedAt: true, provisionedDid: true, uploadedFiles: { select: { id: true, filename: true, kind: true } } },
    });
    const queue = rows.map(buildPortQueueRow).filter(Boolean) as any[];
    queue.sort((a, b) => (a.status === b.status ? 0 : a.status === "awaiting_manual_filing" ? -1 : 1));
    return { queue };
  });

  // The generated Letter of Authorization — what gets uploaded with the
  // SignalWire dashboard filing (they require it signed + dated ≤30 days).
  app.get("/admin/onboarding/submissions/:id/loa.pdf", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const row = await (db as any).onboardingSubmission.findUnique({
      where: { id },
      select: { id: true, companyName: true, answers: true, submittedAt: true, provisionedDid: true, uploadedFiles: { select: { id: true, filename: true, kind: true } } },
    });
    const pq = row ? buildPortQueueRow(row) : null;
    if (!pq) return reply.code(404).send({ error: "not_found" });
    const pdf = await buildLoaPdf(pq);
    reply.header("content-type", "application/pdf");
    reply.header("content-disposition", `attachment; filename="loa-${pq.portedDid.replace(/\D/g, "") || id}.pdf"`);
    return reply.send(pdf);
  });

  // Mark a port package as filed at SignalWire. ⛔ Changes OUR record only —
  // it never touches a carrier; the optional reference is their order id.
  app.post("/admin/onboarding/submissions/:id/port-filed", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id } = (req.params as any) as { id: string };
    const body = z.object({ portReference: z.string().trim().max(80).optional() }).parse((req as any).body || {});
    const row = await (db as any).onboardingSubmission.findUnique({ where: { id }, select: { id: true, answers: true } });
    const a: any = row?.answers || {};
    if (!a?.provisioning?.portFiling) return reply.code(404).send({ error: "not_found" });
    a.provisioning.portFiling = {
      ...a.provisioning.portFiling,
      status: "filed",
      filedAt: new Date().toISOString(),
      ...(body.portReference ? { portReference: body.portReference } : {}),
      filedBy: admin.sub || "admin",
    };
    await (db as any).onboardingSubmission.update({ where: { id }, data: { answers: a } });
    await (db as any).onboardingEvent.create({
      data: { submissionId: id, type: "STATUS_CHANGED", message: `Port filed at SignalWire${body.portReference ? ` (ref ${body.portReference})` : ""}.` },
    });
    return { ok: true };
  });

  // 10DLC registration status — the texting side of the same admin surface
  // (includes the sole-proprietor rows that need a person to file).
  app.get("/admin/onboarding/sms-registrations", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const regs = await (db as any).tenantSmsRegistration.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    const subIds = [...new Set(regs.map((r: any) => r.submissionId).filter(Boolean))] as string[];
    const subs = subIds.length
      ? await (db as any).onboardingSubmission.findMany({ where: { id: { in: subIds } }, select: { id: true, companyName: true } })
      : [];
    const nameOf = new Map(subs.map((s: any) => [s.id, s.companyName]));
    return {
      registrations: regs.map((r: any) => ({
        id: r.id,
        submissionId: r.submissionId,
        companyName: r.submissionId ? nameOf.get(r.submissionId) || r.legalName : r.legalName,
        legalName: r.legalName,
        classification: r.classification,
        senderSystem: r.senderSystem,
        status: r.status,
        brandState: r.brandState,
        campaignState: r.campaignState,
        phoneE164: r.phoneE164,
        error: r.error,
        activatedAt: r.activatedAt,
        updatedAt: r.updatedAt,
      })),
    };
  });

  // File download (admin-only)
  app.get("/admin/onboarding/submissions/:id/files/:fileId/download", async (req: any, reply) => {
    const admin = await requireSuperAdmin(req, reply); if (!admin) return;
    const { id, fileId } = (req.params as any) as { id: string; fileId: string };
    const file = await (db as any).onboardingUploadedFile.findUnique({ where: { id: fileId } });
    if (!file || file.submissionId !== id) return reply.code(404).send({ error: "not_found" });
    // Local storage read (paired with public upload path)
    const full = resolveOnboardingStoragePath(String(file.storageKey || ""));
    const fs = require("node:fs");
    if (!fs.existsSync(full)) return reply.code(404).send({ error: "missing_file" });
    reply.header("content-type", file.mimeType || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename=${JSON.stringify(file.filename || "file.bin")}`);
    const stream = fs.createReadStream(full);
    return reply.send(stream);
  });
}
