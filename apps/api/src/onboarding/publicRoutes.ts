import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { z } from "zod";
import type { OnboardingStatus } from "@prisma/client";
import { publicSaveSchema, publicSubmitSchema } from "./validation";

function sanitizeFileName(name: string): string {
  const base = path.basename(name || "");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 140) || "upload.bin";
}

function onboardingStorageRoot(): string {
  return (process.env.ONBOARDING_STORAGE_DIR || path.resolve(process.cwd(), "data/onboarding-files")).replace(/\\/g, "/");
}

function buildStorageKey(submissionId: string, original: string): string {
  const ts = Date.now();
  const safe = sanitizeFileName(original);
  return `onboarding/${submissionId}/${ts}_${safe}`;
}

function resolveOnboardingStoragePath(storageKey: string): string {
  const clean = String(storageKey || "").replace(/\\/g, "/");
  if (clean.includes("..")) throw new Error("invalid_storage_key");
  const root = onboardingStorageRoot();
  const full = path.resolve(root, clean);
  if (!full.startsWith(root + path.sep) && full !== root) {
    throw new Error("invalid_storage_key_scope");
  }
  return full;
}

async function ensureRowForToken(token: string): Promise<any | null> {
  const row = await (db as any).onboardingSubmission.findFirst({ where: { publicToken: token } });
  return row || null;
}

function isProduction(): boolean {
  return String(process.env.NODE_ENV || "development") === "production";
}

function canLazyCreate(): boolean {
  return !isProduction();
}

function generatePublicToken(bytes: number = 24): string {
  // 32+ URL-safe chars
  return randomBytes(bytes).toString("base64url");
}

function isWriteBlocked(row: any): boolean {
  const s = String(row?.status || "");
  return ["SUBMITTED", "CANCELED", "COMPLETED"].includes(s);
}

export async function registerOnboardingPublicRoutes(app: FastifyInstance) {
  // Validate token exists (prod) or can be created (dev)
  app.get("/onboarding/:token/validate", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) {
      if (canLazyCreate()) {
        return { ok: true, exists: false };
      }
      return reply.code(404).send({ error: "invalid_token" });
    }
    return {
      ok: true,
      exists: true,
      submission: {
        id: row.id,
        currentStep: typeof row.currentStep === "number" ? row.currentStep : 0,
        answers: row.answers ?? null,
      },
    };
  });

  // Public config — card capture disabled for now
  app.get("/onboarding/:token/public-config", async (req, reply) => {
    return { canTokenize: false };
  });

  // Autosave current step + partial answers
  app.put("/onboarding/:token/save", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const body = publicSaveSchema.parse((req as any).body || {});
    let row = await ensureRowForToken(token);
    if (!row) {
      if (!canLazyCreate()) return reply.code(404).send({ error: "invalid_token" });
      row = await (db as any).onboardingSubmission.create({
        data: {
          publicToken: token,
          status: "IN_PROGRESS" as OnboardingStatus,
          currentStep: body.currentStep || null,
          answers: body.answers ?? null,
          events: { create: { type: "CREATED", message: "Submission created (lazy)" } },
        },
      });
    } else {
      if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });
      await (db as any).onboardingSubmission.update({
        where: { id: row.id },
        data: {
          currentStep: body.currentStep || null,
          answers: body.answers ?? null,
          status: (row.status === "INVITE_SENT" ? ("IN_PROGRESS" as OnboardingStatus) : row.status),
          events: { create: { type: "AUTOSAVED", message: body.currentStep ? `Step ${body.currentStep}` : undefined } },
        },
      });
    }
    return { ok: true };
  });

  // Upload latest bill / porting document
  app.post("/onboarding/:token/upload-bill", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });

    // fastify/multipart is registered globally in server.ts
    const parts: any = req.parts ? req.parts() : null;
    let filePart: any = null;
    if (parts && typeof parts === "object" && typeof parts[Symbol.asyncIterator] === "function") {
      for await (const p of parts as AsyncIterable<any>) {
        if (p?.file) { filePart = p; break; }
      }
    } else if (typeof req.file === "function") {
      filePart = await req.file();
    }
    if (!filePart) return reply.code(400).send({ error: "file_missing" });

    const bufs: Buffer[] = [];
    for await (const chunk of filePart.file) {
      bufs.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const buffer = Buffer.concat(bufs);
    const originalName = sanitizeFileName(filePart.filename || "upload.bin");
    const storageKey = buildStorageKey(row.id, originalName);
    const absolutePath = resolveOnboardingStoragePath(storageKey);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, buffer);

    const saved = await (db as any).onboardingUploadedFile.create({
      data: {
        submissionId: row.id,
        filename: originalName,
        mimeType: filePart.mimetype || null,
        sizeBytes: buffer.length,
        storageKey,
        kind: "PORTING_BILL",
      },
    });

    await (db as any).onboardingEvent.create({
      data: { submissionId: row.id, type: "FILE_UPLOADED", message: saved.filename },
    });

    return { ok: true, fileId: saved.id };
  });

  // Card capture — disabled for now
  app.post("/onboarding/:token/card", async (_req, reply) => {
    return reply.code(503).send({ error: "card_disabled" });
  });

  // Submit — validate + persist
  app.post("/onboarding/:token/submit", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const body = publicSubmitSchema.parse(req.body || {});

    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked", detail: "This form has already been submitted." });

    // validate extensions numeric + unique
    const seen = new Set<string>();
    for (const e of body.extensions || []) {
      if (!/^[0-9]+$/.test(e.extNumber)) return reply.code(400).send({ error: "invalid_extension_number" });
      if (seen.has(e.extNumber)) return reply.code(400).send({ error: "duplicate_extension_number" });
      seen.add(e.extNumber);
    }

    const smsEnabled = !!body.smsEnabled;
    const smsMonthlyPriceCents = smsEnabled ? 1000 : 0;

    await (db as any).$transaction(async (tx: any) => {
      await tx.onboardingRequestedExtension.deleteMany({ where: { submissionId: row.id } });
      if ((body.extensions || []).length > 0) {
        await tx.onboardingRequestedExtension.createMany({
          data: (body.extensions || []).map((e) => ({
            submissionId: row.id,
            displayName: e.displayName || null,
            extNumber: e.extNumber,
            email: e.email || null,
            smsEnabled: !!e.smsEnabled,
          })),
          skipDuplicates: true,
        });
      }

      await tx.onboardingSubmission.update({
        where: { id: row.id },
        data: {
          companyName: body.companyName,
          contactFirstName: body.contactFirstName,
          contactLastName: body.contactLastName,
          mainEmail: body.mainEmail,
          billingEmail: body.billingEmail,
          mainPhone: body.mainPhone || null,
          phoneNumberChoice: body.phoneNumberChoice || null,
          smsEnabled,
          smsMonthlyPriceCents,
          status: "SUBMITTED" as OnboardingStatus,
          submittedAt: new Date(),
          events: { create: { type: "SUBMITTED", message: `${seen.size} extensions` } },
        },
      });
    });

    return { ok: true };
  });
}
