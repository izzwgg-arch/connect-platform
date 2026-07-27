import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "@connect/db";
import { z } from "zod";
import type { OnboardingStatus } from "@prisma/client";
import { publicApplyNumberSchema, publicSaveSchema, publicSubmitSchema } from "./validation";
import { decryptJson } from "@connect/security";
import { VoipMsNumberProvider, type VoipMsCredentials } from "@connect/integrations";
import { applyOnboardingNumber, syncOnboardingSms } from "./voipMsProvisioning";
import { runOnboardingSetup, resumeSetupIfSubmitted } from "./setupOrchestrator";

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

/** Master (reseller) VoIP.ms account used to search & buy numbers during onboarding. */
async function loadGlobalVoipMsCreds(): Promise<VoipMsCredentials | null> {
  const row = await (db as any).globalVoipMsConfig.findUnique({ where: { id: "default" } });
  if (!row?.credentialsEncrypted) return null;
  try {
    const c = decryptJson<any>(row.credentialsEncrypted);
    if (!c?.username || !c?.password) return null;
    return { username: c.username, password: c.password, fromNumber: c.fromNumber || "", apiBaseUrl: row.apiBaseUrl || c.apiBaseUrl };
  } catch {
    return null;
  }
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

  // VoIP.ms availability search takes 15-25s; cache per-query results so
  // repeat searches (and the auto-search on step entry) come back instantly.
  const numberSearchCache = new Map<string, { at: number; payload: unknown }>();
  const NUMBER_SEARCH_CACHE_MS = 10 * 60_000;

  // Search available numbers to buy (VoIP.ms), gated by a valid onboarding token.
  // Read-only lookup only — never orders/charges. Never exposes prices to the customer.
  app.get("/onboarding/:token/numbers", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    const q = String((req.query as any)?.q || "").trim();
    const creds = await loadGlobalVoipMsCreds();
    if (!creds) return { numbers: [], note: "number_provider_unconfigured" };

    const cacheKey = q.replace(/\D/g, "") || q.toLowerCase();
    const cached = numberSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < NUMBER_SEARCH_CACHE_MS) return cached.payload;

    try {
      const testMode = (process.env.SIMULATE_NUMBER_PROVIDER || "false").toLowerCase() === "true";
      const provider = new VoipMsNumberProvider(creds, testMode);
      const digits = q.replace(/\D/g, "");
      const results = await provider.searchNumbers({
        type: "local",
        areaCode: digits || undefined,
        contains: digits || undefined,
        limit: 12,
      });
      const numbers = results.map((r) => {
        const d = String(r.phoneNumber).replace(/\D/g, "").replace(/^1/, "");
        const display = d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : r.phoneNumber;
        return {
          number: display,
          e164: r.phoneNumber,
          location: r.region || "",
          sms: r.capabilities?.sms !== false,
          voice: r.capabilities?.voice !== false,
        };
      });
      const payload = { numbers };
      if (numbers.length) numberSearchCache.set(cacheKey, { at: Date.now(), payload });
      return payload;
    } catch {
      return { numbers: [], error: "number_search_failed" };
    }
  });

  // Check whether an existing number can be ported in (VoIP.ms getPortability).
  // Read-only. Returns portable: true | false | null (unknown / not enough info).
  app.get("/onboarding/:token/portability", async (req, reply) => {
    const { token } = (req.params as any) as { token: string };
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });

    let number = String((req.query as any)?.number || "").replace(/\D/g, "");
    if (number.length === 11 && number.startsWith("1")) number = number.slice(1);
    if (number.length !== 10) return { portable: null, note: "need_full_number" };

    const creds = await loadGlobalVoipMsCreds();
    if (!creds) return { portable: null, note: "provider_unconfigured" };

    try {
      const base = (creds.apiBaseUrl || "https://voip.ms/api/v1/rest.php").replace(/\/$/, "");
      const url = new URL(base);
      url.searchParams.set("api_username", creds.username);
      url.searchParams.set("api_password", creds.password);
      url.searchParams.set("method", "getPortability");
      url.searchParams.set("did", number);
      const res = await fetch(url.toString(), { method: "GET" });
      const json: any = await res.json().catch(() => ({}));
      if (String(json.status || "").toLowerCase() !== "success") return { portable: null };
      const flag = String(json.portable ?? json.portability ?? "").toLowerCase();
      // Explicit "no" => not portable; anything else on a successful lookup => portable.
      return { portable: flag ? !/no|false|^0$/.test(flag) : true };
    } catch {
      return { portable: null };
    }
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

    const kindParam = String((req.query as any)?.kind || "bill").toLowerCase();
    const fileKind = kindParam === "loa" ? "PORTING_LOA" : "PORTING_BILL";
    const saved = await (db as any).onboardingUploadedFile.create({
      data: {
        submissionId: row.id,
        filename: originalName,
        mimeType: filePart.mimetype || null,
        sizeBytes: buffer.length,
        storageKey,
        kind: fileKind,
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

  // Apply the chosen number — fires when the customer leaves the "Your number"
  // step. Persists the choice and kicks off VoIP.ms provisioning (subaccount +
  // DID / port + temporary number) in the background so it's usually done by
  // the time they hit "Launch".
  app.post("/onboarding/:token/apply-number", async (req: any, reply) => {
    const { token } = (req.params as any) as { token: string };
    const body = publicApplyNumberSchema.parse(req.body || {});
    const row = await ensureRowForToken(token);
    if (!row) return reply.code(404).send({ error: "invalid_token" });
    if (isWriteBlocked(row)) return reply.code(409).send({ error: "write_blocked" });

    // Merge the number choice into answers so provisioning can read it even if
    // the autosave for this step hasn't landed yet.
    const answers: any = { ...(row.answers as any || {}) };
    answers.phone = {
      ...(answers.phone || {}),
      choice: body.choice,
      selectedNumber: body.selectedNumber || answers.phone?.selectedNumber || "",
      details: body.porting ?? answers.phone?.details ?? {},
    };
    await (db as any).onboardingSubmission.update({
      where: { id: row.id },
      data: {
        answers,
        phoneNumberChoice: body.choice,
        companyName: row.companyName || body.companyName || null,
      },
    });

    void (async () => {
      await applyOnboardingNumber(row.id).catch(() => { /* logged inside */ });
      // If the customer raced ahead and already hit "Launch" while the number
      // was provisioning, carry the setup pipeline forward now.
      await resumeSetupIfSubmitted(row.id).catch(() => { /* logged inside */ });
    })();
    return { ok: true, status: "provisioning" };
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
            vmPassword: e.vmPassword || null,
            smsEnabled: !!e.smsEnabled,
            cellMode: e.cellMode || null,
            cellNumber: e.cellMode ? e.cellNumber || null : null,
          })),
          skipDuplicates: true,
        });
      }

      // Keep the latest number choice in answers too (provisioning reads it there).
      const answers: any = { ...(row.answers as any || {}) };
      answers.phone = {
        ...(answers.phone || {}),
        choice: body.phoneNumberChoice || answers.phone?.choice || "",
        selectedNumber: body.selectedNumber || answers.phone?.selectedNumber || "",
        details: body.porting ?? answers.phone?.details ?? {},
      };

      await tx.onboardingSubmission.update({
        where: { id: row.id },
        data: {
          companyName: body.companyName,
          contactFirstName: body.contactFirstName,
          contactLastName: body.contactLastName,
          mainEmail: body.mainEmail,
          // No separate billing contact means bills go to the main email.
          billingEmail: body.billingEmail || body.mainEmail,
          mainPhone: body.mainPhone || null,
          phoneNumberChoice: body.phoneNumberChoice || null,
          answers,
          smsEnabled,
          smsMonthlyPriceCents,
          status: "SUBMITTED" as OnboardingStatus,
          submittedAt: new Date(),
          events: { create: { type: "SUBMITTED", message: `${seen.size} extensions` } },
        },
      });
    });

    // Full automated setup, in the background:
    //  1. make sure the VoIP.ms number stage finished (retry if it failed/never ran),
    //  2. sync the SMS add-on onto the DID,
    //  3. build the whole VitalPBX tenant (trunk → routes → tenant → extensions →
    //     inbound route), sync extensions into Connect, SIP-sync, send invites.
    void (async () => {
      await applyOnboardingNumber(row.id).catch(() => { /* logged inside */ });
      await syncOnboardingSms(row.id).catch(() => { /* logged inside */ });
      await runOnboardingSetup(row.id).catch(() => { /* logged inside */ });
    })();

    return { ok: true };
  });
}
