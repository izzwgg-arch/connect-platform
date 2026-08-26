/**
 * Supermarket-mode routes (plan Phases 0–7):
 *  - /admin/integrations/*  — the ONE admin screen for per-tenant integration
 *    keys (Sola + Tracking system), CRM mode, and supermarket settings.
 *    SUPER_ADMIN only: every handler opens with `requireOwner` (the injected
 *    gate, visible at the call site), the prefix rides
 *    can_manage_global_settings, and navConfig forces the nav item.
 *  - /supermarket/*         — the Orders Desk: drafts, catalog search, the
 *    screen-pop lookup, stats, specials, driver creation. Prefix-gated on
 *    can_view_supermarket_orders; writes additionally need their action key;
 *    every route is MODE-gated server-side (requireSupermarketMode).
 *  - /internal/supermarket/pay-ivr/step — the dialplan's door (fail-closed
 *    shared secret via the injected internalGuard).
 *  - /marketing/unsubscribe/:token — the public one-click unsubscribe.
 *
 * ⛔ Ordering on draft routes: ownership (tenant-scoped findFirst → 404)
 * BEFORE permission (403) BEFORE body validation (400) — another customer's
 * draft must be indistinguishable from one that never existed.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { userHasActionPermission } from "../permissionGates";
import { resolveEffectiveTenantBillingContext } from "../billing/billingAuth";
import {
  describeIntegrationKeys,
  isSupermarketProvider,
  posClientForTenant,
  removeIntegrationKey,
  storeIntegrationKey,
} from "./integrationCredentials";
import { clearCrmModeCache, requireSupermarketMode, CRM_MODES } from "./crmMode";
import { approveAndSubmitDraft, sanitizeDraftItems } from "./orderSubmit";
import { runPayIvrStep } from "./payIvrRuntime";
import { marketingLaneEnabled, sendSpecialBlast, verifyUnsubscribeToken } from "./specials";
import { decideAutoSubmit, weeklyCorrectionStats } from "./learning";
import { extractPosCustomer, PosApiError, posPhoneDigits } from "./posWithLogic";
import { composeDraftContent, loadCatalogIndex } from "./draftBuilder";
import { chargeCardForDraft, listCardsOnFile, saveCardFromSut, solaAdapterForTenant } from "./customerCards";

export type SupermarketRouteDeps = {
  app: any;
  db: any;
  /** SUPER_ADMIN gate, injected so it is visible at every admin call site. */
  requireOwner: (req: any, reply: any) => Promise<any | null | undefined>;
  /** Best-effort audit — must never fail a request. */
  audit: (p: {
    tenantId: string;
    action: string;
    entityType: string;
    entityId: string;
    actorUserId?: string;
    metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  /** guardInternalSecret bound at the call site (fail-closed). */
  internalGuard: (req: any, reply: any, endpoint: string) => boolean;
  /** loopComShell — the ONE branded email look. */
  renderShell: (opts: {
    headerTitle: string;
    body: string;
    organizationName?: string | null;
    preheaderText?: string;
    headerSubtitle?: string;
  }) => string;
  publicOrigin: () => string;
  ingestDeliveryOrder: (tenantId: string, event: any) => Promise<{ ok: boolean; code?: string }>;
  driverInvite: {
    createInviteToken: (userId: string, createdBy?: string | null) => Promise<{ token: string }>;
    portalPublicUrl: (path: string) => string;
    queueEmailJob: (input: {
      tenantId: string;
      type: string;
      toEmail: string;
      subject: string;
      htmlBody: string;
      textBody: string;
    }) => Promise<void>;
  };
  hasActionPermission?: typeof userHasActionPermission;
  clientFor?: typeof posClientForTenant;
};

const keyBodySchema = z.object({
  tenantId: z.string().min(5).max(64),
  provider: z.string().min(2).max(32),
  apiKey: z.string().min(8).max(512),
  baseUrl: z.string().max(200).optional(),
  label: z.string().max(120).optional(),
  /** SOLA only: the merchant's public iFields key (renders the card iframes). */
  ifieldsKey: z.string().max(200).optional(),
});

const modeBodySchema = z.object({
  tenantId: z.string().min(5).max(64),
  mode: z.enum(CRM_MODES),
});

const settingsBodySchema = z.object({
  tenantId: z.string().min(5).max(64),
  autoSubmitEnabled: z.boolean().optional(),
  autoSubmitMaxCorrectionPct: z.number().min(0).max(100).optional(),
  autoSubmitMinWeeks: z.number().int().min(1).max(52).optional(),
  deliveryIngestEnabled: z.boolean().optional(),
  deliveryStoreRef: z.string().min(1).max(64).optional(),
  payIvrEnabled: z.boolean().optional(),
});

const draftPatchSchema = z.object({
  items: z.array(z.any()).max(100).optional(),
  comments: z.string().max(1000).optional(),
  notes: z.string().max(2000).optional(),
  orderMethod: z.enum(["Pickup", "Delivery"]).optional(),
  /** The account IS the phone number (Izzy) — 7 digits get the 845 area code. */
  customerPhone: z.string().max(24).optional(),
});

const draftApproveSchema = z.object({
  items: z.array(z.any()).max(100),
  comments: z.string().max(1000).optional().default(""),
  notes: z.string().max(2000).optional().default(""),
  orderMethod: z.enum(["Pickup", "Delivery"]).optional().default("Pickup"),
});

const draftCreateSchema = z.object({
  sourceType: z.literal("call"),
  customerPhone: z.string().max(24).optional().default(""),
  customerName: z.string().max(120).optional().default(""),
});

const specialCreateSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(3).max(10_000),
});

const driverCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  cell: z.string().trim().min(7).max(24),
  email: z
    .string()
    .trim()
    .min(5)
    .max(254)
    .refine((v) => !/[\r\n]/.test(v), "no line breaks")
    .refine((v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v), "not an email address"),
});

const payIvrStepSchema = z.object({
  tenantId: z.string().min(5).max(64),
  callId: z.string().min(1).max(128),
  callerNumber: z.string().max(32).optional().default(""),
  digits: z.string().max(32).optional(),
  hangup: z.boolean().optional(),
});

export const SUPERMARKET_VIEW_KEY = "can_view_supermarket_orders";
export const SUPERMARKET_MANAGE_KEY = "can_manage_supermarket_orders";
export const SUPERMARKET_SPECIALS_KEY = "can_manage_supermarket_specials";

export async function registerSupermarketRoutes(deps: SupermarketRouteDeps): Promise<void> {
  const { app, db, requireOwner, audit, internalGuard, renderShell } = deps;
  const hasKey = deps.hasActionPermission ?? userHasActionPermission;
  const clientFor = deps.clientFor ?? posClientForTenant;

  const getUser = (req: any) => (req.user ?? {}) as { sub?: string; tenantId?: string; role?: string; email?: string };
  /**
   * The tenant every tenant-facing route operates on. ⛔ For SUPER_ADMIN this
   * honours the workspace tenant switch (x-tenant-context / ?tenantId=) via the
   * platform's ONE resolver in billing/billingAuth — Izzy, 2026-08-26: "from
   * the main tenant, when I go to Gesheft, I should be able to access their
   * system with their API key." Without this, every route read the admin
   * tenant (no catalog, no drafts) and the quick-add suggested nothing —
   * the recorded routes-ignore-the-tenant-selector trap.
   */
  const tenantOf = (req: any): string =>
    resolveEffectiveTenantBillingContext(req, { tenantId: String(getUser(req).tenantId ?? ""), role: getUser(req).role });
  const allowed = async (req: any, key: string): Promise<boolean> => {
    const user = getUser(req);
    if (user.role === "SUPER_ADMIN") return true;
    return hasKey(user as any, key).catch(() => false);
  };
  /** Tenant-scoped draft fetch — the 404-before-anything ownership step. */
  const ownDraft = async (req: any, reply: any, draftId: string) => {
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const draft = await db.supermarketOrderDraft.findFirst({ where: { id: String(draftId), tenantId } });
    if (!draft) {
      reply.status(404).send({ error: "not_found" });
      return null;
    }
    return draft;
  };
  const safeAudit = async (p: Parameters<SupermarketRouteDeps["audit"]>[0]) => {
    try {
      await audit(p);
    } catch {
      /* audit is best-effort by design */
    }
  };

  // ══════════════════════════ ADMIN: integration keys ══════════════════════

  app.get("/admin/integrations/tenants", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const tenants = await db.tenant.findMany({
      where: { pbxRemovedAt: null },
      select: { id: true, name: true, crmMode: true },
      orderBy: { name: "asc" },
      take: 200,
    });
    return reply.send({ tenants });
  });

  app.get("/admin/integrations/keys", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const tenantId = String((req.query as any)?.tenantId ?? "").trim();
    if (!tenantId) return reply.status(400).send({ error: "tenant_required" });
    const keys = await describeIntegrationKeys(db, tenantId);
    const settings = await db.supermarketSettings.findUnique({ where: { tenantId } }).catch(() => null);
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, crmMode: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    return reply.send({ tenant: { id: tenantId, name: tenant.name, crmMode: tenant.crmMode }, keys, settings });
  });

  app.post("/admin/integrations/keys", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = keyBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "Check the key and try again." });
    if (!isSupermarketProvider(parsed.data.provider)) {
      return reply.status(400).send({ error: "unknown_provider", message: "Pick Sola or the Tracking system." });
    }
    const tenant = await db.tenant.findUnique({ where: { id: parsed.data.tenantId }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    let saved: { id: string; hint: string };
    try {
      saved = await storeIntegrationKey(db, {
        tenantId: parsed.data.tenantId,
        provider: parsed.data.provider,
        apiKey: parsed.data.apiKey,
        baseUrl: parsed.data.baseUrl,
        label: parsed.data.label,
        ifieldsKey: parsed.data.ifieldsKey,
        actorUserId: String(admin.sub ?? admin.id ?? ""),
      });
    } catch (err: any) {
      const code = String(err?.message ?? "store_failed");
      const msg =
        code === "credentials_master_key_missing"
          ? "The credential vault is not available on this server."
          : "That key doesn't look right — paste it exactly, with no spaces.";
      return reply.status(code === "credentials_master_key_missing" ? 503 : 400).send({ error: code, message: msg });
    }
    await safeAudit({
      tenantId: parsed.data.tenantId,
      action: "SUPERMARKET_INTEGRATION_KEY_SAVED",
      entityType: "ProviderCredential",
      entityId: saved.id,
      actorUserId: String(admin.sub ?? ""),
      metadata: { provider: parsed.data.provider, hint: saved.hint },
    });
    return reply.send({ ok: true, hint: saved.hint });
  });

  app.post("/admin/integrations/keys/remove", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = z
      .object({ tenantId: z.string().min(5).max(64), provider: z.string().min(2).max(32) })
      .safeParse(req.body ?? {});
    if (!parsed.success || !isSupermarketProvider(parsed.data.provider)) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    await removeIntegrationKey(db, parsed.data.tenantId, parsed.data.provider);
    await safeAudit({
      tenantId: parsed.data.tenantId,
      action: "SUPERMARKET_INTEGRATION_KEY_REMOVED",
      entityType: "ProviderCredential",
      entityId: parsed.data.provider,
      actorUserId: String(admin.sub ?? ""),
      metadata: { provider: parsed.data.provider },
    });
    return reply.send({ ok: true });
  });

  /**
   * Key test. POS: one FREE read (`GET /orders/id/probe`) and read WHICH
   * refusal comes back — their 404 means the key authenticated and the order
   * doesn't exist; 401/403 means the key is wrong (the differential-refusal
   * technique). Sola has no safe probe; it reports so honestly.
   */
  app.post("/admin/integrations/keys/test", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = z
      .object({ tenantId: z.string().min(5).max(64), provider: z.string().min(2).max(32) })
      .safeParse(req.body ?? {});
    if (!parsed.success || !isSupermarketProvider(parsed.data.provider)) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    if (parsed.data.provider === "SOLA") {
      return reply.send({ ok: true, verdict: "not_probed", message: "Sola keys are proven on the first real payment flow." });
    }
    const client = await clientFor(db, parsed.data.tenantId);
    if (!client) return reply.status(404).send({ error: "no_key", message: "No Tracking-system key is stored for this company." });
    try {
      await client.getOrderById("connect-key-probe");
      return reply.send({ ok: true, verdict: "key_works" });
    } catch (err: any) {
      if (err instanceof PosApiError && err.code === "pos_not_found") {
        return reply.send({ ok: true, verdict: "key_works" });
      }
      if (err instanceof PosApiError && err.code === "pos_auth_failed") {
        return reply.send({ ok: false, verdict: "key_rejected", message: "Their system rejected this key." });
      }
      // ⛔ Proven live 2026-08-26 with the first real key: their order-by-id
      // endpoint answers 500 on the probe id, NOT 404 — so the free probe is
      // inconclusive there. Fall back to one tiny catalog read (1 credit):
      // a 200 settles "the key works" definitively; a 401 settles the reverse.
      try {
        await client.listProducts({ take: 1 });
        return reply.send({ ok: true, verdict: "key_works" });
      } catch (err2: any) {
        if (err2 instanceof PosApiError && err2.code === "pos_auth_failed") {
          return reply.send({ ok: false, verdict: "key_rejected", message: "Their system rejected this key." });
        }
        return reply.send({ ok: false, verdict: "unreachable", message: "Their system could not be reached — the key itself may still be fine." });
      }
    }
  });

  /**
   * Product-photo ingest (Izzy, 2026-08-26: "when the suggestions come up, it
   * should come up with the photos"). The photos live on the store's own
   * webstore (Self-Point), whose API sits behind a Cloudflare browser
   * challenge — the SERVER cannot walk it, so the barcode→imageUrl map is
   * harvested in a real browser and fed through this SUPER_ADMIN door.
   * Updates PosCatalogItem by (tenantId, code=barcode); https URLs only;
   * additive — a row keeps its photo until a newer harvest replaces it.
   */
  app.post("/admin/integrations/webstore-images", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = z
      .object({
        tenantId: z.string().min(5).max(64),
        images: z
          .array(z.object({ barcode: z.string().trim().min(3).max(32), imageUrl: z.string().trim().url().max(500) }))
          .min(1)
          .max(5000),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const tenant = await db.tenant.findUnique({ where: { id: parsed.data.tenantId }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    let matched = 0;
    let unmatched = 0;
    for (const img of parsed.data.images) {
      if (!img.imageUrl.startsWith("https://")) {
        unmatched++;
        continue;
      }
      const res = await db.posCatalogItem.updateMany({
        where: { tenantId: tenant.id, code: img.barcode },
        data: { imageUrl: img.imageUrl },
      });
      if (res.count > 0) matched++;
      else unmatched++;
    }
    await safeAudit({
      tenantId: tenant.id,
      action: "SUPERMARKET_WEBSTORE_IMAGES_INGESTED",
      entityType: "PosCatalogItem",
      entityId: "batch",
      actorUserId: String(admin.sub ?? ""),
      metadata: { received: parsed.data.images.length, matched, unmatched },
    });
    return reply.send({ ok: true, matched, unmatched });
  });

  /**
   * Re-run the order pipeline over EXISTING review-queue drafts (Izzy,
   * 2026-08-26: "re-transcribe all drafts that we have right now with Yiddish
   * Labs, then translate with English, and let's see if it's going to fill in
   * the right items").
   *
   * ⛔ NEEDS_REVIEW only — an approved or submitted draft is a record of what a
   * person decided and is never rewritten. Sequential on purpose: YL audio is
   * per-credit and OpenAI per-token; a burst here is a bill, not a speedup.
   */
  app.post("/admin/integrations/reprocess-drafts", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = z
      .object({
        tenantId: z.string().min(5).max(64),
        limit: z.number().int().min(1).max(50).default(20),
        draftIds: z.array(z.string().min(5).max(64)).max(50).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const tenant = await db.tenant.findUnique({ where: { id: parsed.data.tenantId }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    const drafts = await db.supermarketOrderDraft.findMany({
      where: {
        tenantId: tenant.id,
        status: "NEEDS_REVIEW",
        ...(parsed.data.draftIds?.length ? { id: { in: parsed.data.draftIds } } : {}),
      },
      select: { id: true, sourceType: true, sourceId: true, transcript: true, translation: true, customerPhone: true },
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
    });
    const index = await loadCatalogIndex(db, tenant.id);
    const results: any[] = [];
    for (const draft of drafts) {
      try {
        let text = String(draft.transcript ?? "");
        let localAudioPath: string | null = null;
        if (draft.sourceType === "voicemail") {
          const vm = await db.voicemail
            .findUnique({ where: { id: draft.sourceId }, select: { transcript: true, localAudioPath: true } })
            .catch(() => null);
          if (vm) {
            text = String(vm.transcript ?? "") || text;
            localAudioPath = vm.localAudioPath ?? null;
          }
        }
        // a draft that already carries YL's translation reuses it — the brain
        // re-runs, YL is never re-billed for the same audio
        const storedTranslation = String(draft.translation ?? "").trim();
        const content = await composeDraftContent({ db }, tenant.id, index, {
          kind: draft.sourceType === "voicemail" ? "voicemail" : "text",
          text,
          localAudioPath,
          voicemailId: draft.sourceType === "voicemail" ? draft.sourceId : undefined,
          customerPhone: String(draft.customerPhone ?? "") || undefined,
          ...(storedTranslation ? { preTranslated: { transcript: String(draft.transcript ?? ""), translation: storedTranslation } } : {}),
        });
        // the customer SPOKE their account number → re-run the POS lookup on it
        let customerFields: any = {};
        if (content.statedPhone) {
          customerFields.customerPhone = content.statedPhone;
          try {
            const client = await posClientForTenant(db, tenant.id);
            if (client) {
              const body: any = await client.getCustomerByPhone(posPhoneDigits(content.statedPhone) ?? content.statedPhone);
              const ext = extractPosCustomer(body);
              if (ext?.posCustomerId) {
                customerFields.posCustomerId = ext.posCustomerId;
                if (ext.name) customerFields.customerName = ext.name;
                customerFields.customerInfo = ext;
              }
            }
          } catch {
            /* best-effort — an unreachable register costs the name, never the reprocess */
          }
        }
        await db.supermarketOrderDraft.update({
          where: { id: draft.id },
          data: {
            transcript: content.transcript,
            translation: content.translation,
            items: content.items,
            agentItems: content.items,
            comments: content.comments,
            notes: content.notes,
            // ⛔ "not every message is an order... It's not supposed to be a
            // draft" (Izzy) — the brain's non-order verdict clears it off the
            // review queue, reason preserved in notes.
            ...(content.notAnOrder ? { status: "DISMISSED" } : {}),
            ...customerFields,
          },
        });
        results.push({
          id: draft.id,
          ok: true,
          engine: content.engine,
          items: content.items.length,
          translated: Boolean(content.translation),
          notAnOrder: content.notAnOrder ?? undefined,
        });
      } catch (err: any) {
        results.push({ id: draft.id, ok: false, error: String(err?.message ?? err).slice(0, 200) });
      }
    }
    await safeAudit({
      tenantId: tenant.id,
      action: "SUPERMARKET_DRAFTS_REPROCESSED",
      entityType: "SupermarketOrderDraft",
      entityId: "batch",
      actorUserId: String(admin.sub ?? ""),
      metadata: { reprocessed: results.length },
    });
    return reply.send({ ok: true, reprocessed: results.length, results });
  });

  app.put("/admin/integrations/crm-mode", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = modeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const tenant = await db.tenant.findUnique({ where: { id: parsed.data.tenantId }, select: { id: true, crmMode: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    await db.tenant.update({ where: { id: tenant.id }, data: { crmMode: parsed.data.mode } });
    clearCrmModeCache();
    await safeAudit({
      tenantId: tenant.id,
      action: "TENANT_CRM_MODE_UPDATED",
      entityType: "Tenant",
      entityId: tenant.id,
      actorUserId: String(admin.sub ?? ""),
      metadata: { from: tenant.crmMode, to: parsed.data.mode },
    });
    return reply.send({ ok: true, mode: parsed.data.mode });
  });

  app.put("/admin/integrations/supermarket-settings", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply);
    if (!admin) return;
    const parsed = settingsBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const { tenantId, ...changes } = parsed.data;
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });
    const settings = await db.supermarketSettings.upsert({
      where: { tenantId },
      update: { ...changes, updatedBy: String(admin.sub ?? "") },
      create: { tenantId, ...changes, updatedBy: String(admin.sub ?? "") },
    });
    return reply.send({ ok: true, settings });
  });

  // ══════════════════════════ TENANT: the Orders Desk ══════════════════════

  /** Mode probe — authenticated-only (permission: null rule); the portal nav
   *  + the order-twin watcher ask this for every signed-in user. */
  app.get("/supermarket/mode", async (req: any, reply: any) => {
    const user = getUser(req);
    const tenantId = tenantOf(req);
    if (!tenantId) return reply.send({ mode: "classic" });
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { crmMode: true } }).catch(() => null);
    return reply.send({ mode: tenant?.crmMode === "supermarket" ? "supermarket" : "classic" });
  });

  app.get("/supermarket/summary", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [needsReview, submittedToday, fromVoicemail, fromText] = await Promise.all([
      db.supermarketOrderDraft.count({ where: { tenantId, status: "NEEDS_REVIEW" } }),
      db.supermarketOrderDraft.count({ where: { tenantId, status: "SUBMITTED", submittedAt: { gte: dayStart } } }),
      db.supermarketOrderDraft.count({ where: { tenantId, sourceType: "voicemail", createdAt: { gte: dayStart } } }),
      db.supermarketOrderDraft.count({ where: { tenantId, sourceType: "text", createdAt: { gte: dayStart } } }),
    ]);
    return reply.send({ needsReview, submittedToday, fromVoicemail, fromText });
  });

  app.get("/supermarket/drafts", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const status = String((req.query as any)?.status ?? "").trim();
    const where: any = { tenantId };
    if (status && ["NEEDS_REVIEW", "APPROVED", "SUBMITTED", "SUBMIT_FAILED", "DISMISSED", "SUBMITTING"].includes(status)) {
      where.status = status;
    }
    const drafts = await db.supermarketOrderDraft.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        threadId: true,
        customerName: true,
        customerPhone: true,
        posCustomerId: true,
        customerInfo: true,
        items: true,
        comments: true,
        notes: true,
        status: true,
        orderMethod: true,
        posOrderId: true,
        submitError: true,
        createdAt: true,
        submittedAt: true,
      },
    });
    return reply.send({ drafts });
  });

  app.get("/supermarket/drafts/:id", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const draft = await ownDraft(req, reply, (req.params as any).id);
    if (!draft) return;
    // hydrate product photos onto the items — display-only, never persisted
    // (sanitizeDraftItems strips them on every write)
    try {
      const items: any[] = Array.isArray(draft.items) ? draft.items : [];
      const ids = items.map((i) => String(i?.posProductId ?? "")).filter(Boolean);
      if (ids.length) {
        const photos = await db.posCatalogItem.findMany({
          where: { tenantId: tenantOf(req), posProductId: { in: ids.slice(0, 100) }, imageUrl: { not: null } },
          select: { posProductId: true, imageUrl: true },
        });
        const byId = new Map(photos.map((p: any) => [p.posProductId, p.imageUrl]));
        draft.items = items.map((i) => (byId.has(i?.posProductId) ? { ...i, imageUrl: byId.get(i.posProductId) } : i));
      }
    } catch {
      /* photos are decoration — never fail the draft read */
    }
    return reply.send({ draft });
  });

  app.post("/supermarket/drafts", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    const parsed = draftCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const draft = await db.supermarketOrderDraft.create({
      data: {
        tenantId,
        sourceType: "call",
        sourceId: `call-${randomUUID()}`,
        customerPhone: parsed.data.customerPhone.slice(0, 24),
        customerName: parsed.data.customerName.slice(0, 120),
        items: [],
        agentItems: [],
      },
    });
    return reply.send({ draft });
  });

  app.patch("/supermarket/drafts/:id", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const draft = await ownDraft(req, reply, (req.params as any).id);
    if (!draft) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    const parsed = draftPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    if (draft.status === "SUBMITTED" || draft.status === "SUBMITTING") {
      return reply.status(409).send({ error: "already_submitted", message: "That order already went through." });
    }
    const data: any = {};
    if (parsed.data.items !== undefined) data.items = sanitizeDraftItems(parsed.data.items);
    if (parsed.data.comments !== undefined) data.comments = parsed.data.comments;
    if (parsed.data.notes !== undefined) data.notes = parsed.data.notes;
    if (parsed.data.orderMethod !== undefined) data.orderMethod = parsed.data.orderMethod;
    if (parsed.data.customerPhone !== undefined) {
      const phone10 = posPhoneDigits(parsed.data.customerPhone);
      if (!phone10) {
        return reply.status(400).send({ error: "bad_phone", message: "That doesn't look like a phone number — 7 or 10 digits." });
      }
      data.customerPhone = phone10;
      // the phone IS the account: look the customer up on the register and
      // bring in EVERYTHING the record holds (name, address, email).
      data.posCustomerId = null;
      data.customerInfo = null;
      try {
        const client = await clientFor(db, tenantOf(req));
        if (client) {
          const body: any = await client.getCustomerByPhone(phone10);
          const ext = extractPosCustomer(body);
          if (ext?.posCustomerId) {
            data.posCustomerId = ext.posCustomerId;
            if (ext.name) data.customerName = ext.name;
            data.customerInfo = ext;
          }
        }
      } catch {
        /* best-effort — an unreachable register costs the lookup, never the save */
      }
    }
    const updated = await db.supermarketOrderDraft.update({ where: { id: draft.id }, data });
    return reply.send({ draft: updated });
  });

  // ── cards on file (Izzy, 2026-08-26) ─────────────────────────────────────
  app.get("/supermarket/customers/:posCustomerId/cards", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, SUPERMARKET_VIEW_KEY))) return reply.status(403).send({ error: "forbidden" });
    const tenantId = tenantOf(req);
    const posCustomerId = String((req.params as any).posCustomerId ?? "").slice(0, 64);
    if (!posCustomerId) return reply.status(400).send({ error: "invalid_request" });
    const posClient = await clientFor(db, tenantId).catch(() => null);
    const cards = await listCardsOnFile({ db, posClient }, tenantId, posCustomerId);
    const sola = await solaAdapterForTenant(db, tenantId);
    return reply.send({ cards, solaConnected: Boolean(sola), ifieldsKey: sola?.ifieldsKey ?? null });
  });

  app.post("/supermarket/customers/:posCustomerId/cards", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    const tenantId = tenantOf(req);
    const posCustomerId = String((req.params as any).posCustomerId ?? "").slice(0, 64);
    const parsed = z
      .object({
        cardToken: z.string().min(8).max(512),
        exp: z.string().max(8).optional(),
        cardholderName: z.string().max(120).optional(),
      })
      .safeParse(req.body ?? {});
    if (!posCustomerId || !parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = getUser(req);
    const result = await saveCardFromSut(
      { db },
      {
        tenantId,
        posCustomerId,
        sut: parsed.data.cardToken,
        exp: parsed.data.exp,
        cardholderName: parsed.data.cardholderName,
        actorUserId: String(user.sub ?? ""),
      },
    );
    if (!result.ok) return reply.status(result.code === "sola_not_connected" ? 503 : 422).send({ error: result.code, message: result.message });
    await safeAudit({
      tenantId,
      action: "SUPERMARKET_CARD_SAVED",
      entityType: "SmCustomerCard",
      entityId: result.card.id,
      actorUserId: String(user.sub ?? ""),
      metadata: { posCustomerId, last4: result.card.last4 },
    });
    return reply.send({ ok: true, card: result.card });
  });

  app.post("/supermarket/drafts/:id/charge", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const draft = await ownDraft(req, reply, (req.params as any).id);
    if (!draft) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    const parsed = z
      .object({ cardId: z.string().min(3).max(80), amountCents: z.number().int().min(50).max(500_000) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    // ⛔ one charge per draft, ever — a second press must not double-bill.
    if (draft.paymentStatus === "CHARGED" || draft.paymentStatus === "UNKNOWN") {
      return reply.status(409).send({ error: "already_charged", message: "A charge was already made for this order." });
    }
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const result = await chargeCardForDraft(
      { db },
      { tenantId, draftId: draft.id, cardRef: parsed.data.cardId, amountCents: parsed.data.amountCents, actorUserId: String(user.sub ?? "") },
    );
    await safeAudit({
      tenantId,
      action: result.ok ? "SUPERMARKET_CARD_CHARGED" : "SUPERMARKET_CARD_CHARGE_FAILED",
      entityType: "SupermarketOrderDraft",
      entityId: draft.id,
      actorUserId: String(user.sub ?? ""),
      metadata: { code: result.code, amountCents: parsed.data.amountCents, last4: result.last4 ?? null },
    });
    return reply.status(result.ok ? 200 : 402).send(result);
  });

  app.post("/supermarket/drafts/:id/approve", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const draft = await ownDraft(req, reply, (req.params as any).id);
    if (!draft) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    const parsed = draftApproveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const user = getUser(req);
    const result = await approveAndSubmitDraft(
      { db, log: app.log, clientFor, ingestDeliveryOrder: deps.ingestDeliveryOrder },
      {
        tenantId: tenantOf(req),
        draftId: draft.id,
        actorUserId: String(user.sub ?? ""),
        reviewedItems: sanitizeDraftItems(parsed.data.items),
        comments: parsed.data.comments,
        notes: parsed.data.notes,
        orderMethod: parsed.data.orderMethod,
      },
    );
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : result.code === "no_items" ? 400 : 409;
      return reply.status(status).send({ error: result.code, message: result.message });
    }
    await safeAudit({
      tenantId: tenantOf(req),
      action: "SUPERMARKET_DRAFT_SUBMITTED",
      entityType: "SupermarketOrderDraft",
      entityId: draft.id,
      actorUserId: String(user.sub ?? ""),
      metadata: { posOrderId: result.posOrderId, alreadySubmitted: result.alreadySubmitted },
    });
    return reply.send({ ok: true, posOrderId: result.posOrderId, alreadySubmitted: result.alreadySubmitted });
  });

  app.post("/supermarket/drafts/:id/dismiss", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const draft = await ownDraft(req, reply, (req.params as any).id);
    if (!draft) return;
    if (!(await allowed(req, SUPERMARKET_MANAGE_KEY))) return reply.status(403).send({ error: "forbidden" });
    if (draft.status === "SUBMITTED" || draft.status === "SUBMITTING") {
      return reply.status(409).send({ error: "already_submitted" });
    }
    const user = getUser(req);
    await db.supermarketOrderDraft.update({
      where: { id: draft.id },
      data: { status: "DISMISSED", reviewedBy: String(user.sub ?? "") },
    });
    return reply.send({ ok: true });
  });

  app.get("/supermarket/catalog/search", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const q = String((req.query as any)?.q ?? "").trim().slice(0, 60);
    if (q.length < 1) return reply.send({ items: [] });
    const isNumeric = /^\d+$/.test(q);
    const items = await db.posCatalogItem.findMany({
      where: isNumeric
        ? { tenantId, isActive: true, code: { startsWith: q } }
        : { tenantId, isActive: true, name: { contains: q, mode: "insensitive" } },
      select: { posProductId: true, code: true, name: true, unitPriceCents: true, imageUrl: true },
      orderBy: isNumeric ? { code: "asc" } : { name: "asc" },
      take: 8,
    });
    return reply.send({ items });
  });

  /** The screen-pop / order-twin lookup: phone → register account. */
  app.get("/supermarket/lookup", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const phoneRaw = String((req.query as any)?.phone ?? "");
    const phone10 = posPhoneDigits(phoneRaw);
    if (!phone10) return reply.send({ found: false });
    const client = await clientFor(db, tenantId);
    if (!client) return reply.send({ found: false, noPosKey: true });
    let posCustomerId: string | null = null;
    let name = "";
    try {
      const body: any = await client.getCustomerByPhone(phone10);
      const id = body?.id ?? body?.customerId ?? null;
      if (id) {
        posCustomerId = String(id);
        name = [body?.firstName, body?.lastName].filter(Boolean).join(" ") || String(body?.name ?? "");
      }
    } catch {
      /* not found / unreachable both read as not-found to the pop */
    }
    if (!posCustomerId) return reply.send({ found: false });

    // Balance is PIN-gated by their api; an enrolled PIN for this customer
    // unlocks it for the pop — otherwise it reads "available on demand".
    let balanceCents: number | null = null;
    try {
      const pinRow = await db.supermarketPhonePin.findFirst({
        where: { tenantId, posCustomerId },
        select: { pinEnc: true },
      });
      if (pinRow) {
        const sec = await import("@connect/security");
        if (sec.hasCredentialsMasterKey()) {
          const value = sec.decryptJson<{ pin: string }>(pinRow.pinEnc);
          if (value?.pin) {
            const body: any = await client.getCustomerBalance(posCustomerId, value.pin);
            const n = Number(body?.balance ?? body?.amount);
            if (Number.isFinite(n)) balanceCents = Math.round(n * 100);
          }
        }
      }
    } catch {
      balanceCents = null;
    }

    const recent = await db.supermarketOrderDraft.findMany({
      where: { tenantId, status: "SUBMITTED", OR: [{ posCustomerId }, { customerPhone: { contains: phone10.slice(-7) } }] },
      orderBy: { submittedAt: "desc" },
      take: 3,
      select: { id: true, posOrderId: true, submittedAt: true, items: true },
    });
    return reply.send({
      found: true,
      posCustomerId,
      name: name.slice(0, 120),
      balanceCents,
      recentOrders: recent.map((r: any) => ({
        id: r.id,
        posOrderId: r.posOrderId,
        submittedAt: r.submittedAt,
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        totalCents: Array.isArray(r.items)
          ? r.items.reduce((sum: number, i: any) => sum + Number(i?.unitPriceCents ?? 0) * Number(i?.qty ?? 0), 0)
          : 0,
      })),
    });
  });

  app.get("/supermarket/stats", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const rows = await db.supermarketOrderDraft.findMany({
      where: { tenantId, corrections: { not: null }, approvedAt: { not: null } },
      select: { approvedAt: true, corrections: true },
      orderBy: { approvedAt: "desc" },
      take: 2_000,
    });
    const weeks = weeklyCorrectionStats(rows);
    const settings = await db.supermarketSettings.findUnique({ where: { tenantId } });
    const decision = decideAutoSubmit(weeks, {
      autoSubmitEnabled: Boolean(settings?.autoSubmitEnabled),
      autoSubmitMaxCorrectionPct: Number(settings?.autoSubmitMaxCorrectionPct ?? 5),
      autoSubmitMinWeeks: Number(settings?.autoSubmitMinWeeks ?? 2),
    });
    return reply.send({ weeks, autoSubmit: decision });
  });

  // ── specials ──────────────────────────────────────────────────────────────

  app.get("/supermarket/specials", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const specials = await db.supermarketSpecial.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return reply.send({ specials, laneReady: marketingLaneEnabled() });
  });

  app.post("/supermarket/specials", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, SUPERMARKET_SPECIALS_KEY))) return reply.status(403).send({ error: "forbidden" });
    const parsed = specialCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "A special needs a subject and a body." });
    const user = getUser(req);
    const special = await db.supermarketSpecial.create({
      data: {
        tenantId: tenantOf(req),
        subject: parsed.data.subject,
        body: parsed.data.body,
        createdBy: String(user.sub ?? ""),
      },
    });
    return reply.send({ special });
  });

  app.post("/supermarket/specials/:id/send", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, SUPERMARKET_SPECIALS_KEY))) return reply.status(403).send({ error: "forbidden" });
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const result = await sendSpecialBlast(
      { db, renderShell, publicOrigin: deps.publicOrigin, log: app.log },
      { tenantId, specialId: String((req.params as any).id) },
    );
    if (!result.ok) {
      const status = result.code === "not_found" ? 404 : result.code === "marketing_lane_not_configured" ? 503 : 409;
      return reply.status(status).send({ error: result.code, message: result.message });
    }
    await safeAudit({
      tenantId,
      action: "SUPERMARKET_SPECIAL_SENT",
      entityType: "SupermarketSpecial",
      entityId: String((req.params as any).id),
      actorUserId: String(user.sub ?? ""),
      metadata: { recipients: result.recipients },
    });
    return reply.send({ ok: true, recipients: result.recipients, skippedUnsubscribed: result.skippedUnsubscribed });
  });

  // ── drivers: list + create with the setup email (mockup screens 4, 5, 7) ──

  /** Driver list with the REAL CELL number — drivers won't have the Loopcom
   *  phone app; the dispatcher's Call button dials the cell on this record. */
  app.get("/supermarket/drivers", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const tenantId = tenantOf(req);
    const profiles = await db.driverProfile.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      select: { id: true, userId: true, status: true, active: true, activeRunId: true, createdAt: true },
      take: 200,
    });
    const users = await db.user.findMany({
      where: { tenantId, id: { in: profiles.map((p: any) => p.userId) } },
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, status: true },
    });
    const byId = new Map(users.map((u: any) => [u.id, u]));
    return reply.send({
      drivers: profiles.map((p: any) => {
        const u: any = byId.get(p.userId) ?? {};
        return {
          id: p.id,
          userId: p.userId,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "—",
          email: u.email ?? "",
          cell: u.phone ?? "",
          appStatus: u.status ?? "",
          driverStatus: p.status,
          active: p.active,
          activeRunId: p.activeRunId,
        };
      }),
    });
  });

  // ── drivers: create with the setup email (mockup screen 5 + 7) ────────────

  app.post("/supermarket/drivers/full", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    if (!(await allowed(req, "can_manage_tracking_drivers"))) return reply.status(403).send({ error: "forbidden" });
    const parsed = driverCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", message: "A driver needs a name, a cell number and an email." });
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const email = parsed.data.email.toLowerCase();

    const existing = await db.user.findFirst({ where: { email }, select: { id: true, tenantId: true } });
    if (existing) {
      return reply.status(409).send({ error: "email_taken", message: "Somebody already signs in with that email address." });
    }
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    const created = await db.user.create({
      data: {
        tenantId,
        email,
        firstName: parsed.data.name.split(/\s+/)[0] ?? parsed.data.name,
        lastName: parsed.data.name.split(/\s+/).slice(1).join(" ") || null,
        phone: parsed.data.cell,
        role: "USER",
        status: "INVITED",
        passwordHash: randomUUID() + randomUUID(),
        forcePasswordReset: true,
      },
      select: { id: true },
    });
    await db.driverProfile.upsert({
      where: { tenantId_userId: { tenantId, userId: created.id } },
      create: { tenantId, userId: created.id, active: true },
      update: { active: true },
    });

    // The setup email — the EXACT screen-7 design, on the real shell.
    let emailed = false;
    try {
      const { token } = await deps.driverInvite.createInviteToken(created.id, String(user.sub ?? ""));
      const setupUrl = deps.driverInvite.portalPublicUrl(`/auth/invite/accept?token=${encodeURIComponent(token)}`);
      const storeName = String(tenant?.name ?? "your store");
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const bodyHtml =
        `<p style="margin:0 0 16px;">Hi ${esc(parsed.data.name)},</p>` +
        `<p style="margin:0 0 16px;"><strong>${esc(storeName)}</strong> set you up as a delivery driver. ` +
        `One quick step and you're ready to roll: choose a password for the driver app.</p>` +
        `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;"><tr>` +
        `<td align="center" bgcolor="#22a8ff" style="border-radius:10px;background:#22a8ff;background-image:linear-gradient(135deg,#22a8ff,#4f7bff);">` +
        `<a href="${esc(setupUrl)}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:15px 30px;border-radius:10px;">Choose my password</a>` +
        `</td></tr></table>` +
        `<p style="margin:22px 0 6px;font-weight:700;">Then:</p>` +
        `<ol style="margin:0 0 16px;padding-left:20px;">` +
        `<li style="margin-bottom:6px;">Get the <strong>Loopcom Driver</strong> app on your phone.</li>` +
        `<li style="margin-bottom:6px;">Sign in with this email and your new password.</li>` +
        `<li>Your name and number are already set up — your runs appear when dispatch assigns them.</li>` +
        `</ol>` +
        `<p style="margin:0;color:#6b7280;font-size:13px;">Signing in as: <strong>${esc(email)}</strong> &middot; ${esc(parsed.data.cell)}</p>`;
      const html = renderShell({
        headerTitle: "You're set up as a driver",
        headerSubtitle: storeName,
        preheaderText: `${storeName} set you up as a delivery driver`,
        body: bodyHtml,
        organizationName: storeName,
      });
      // ⛔ Type DRIVER_INVITE, never ADMIN_ALERT (muted at the send door).
      await deps.driverInvite.queueEmailJob({
        tenantId,
        type: "DRIVER_INVITE",
        toEmail: email,
        subject: `${storeName} set you up as a delivery driver`,
        htmlBody: html,
        textBody: `Hi ${parsed.data.name},\n\n${storeName} set you up as a delivery driver.\nChoose your password: ${setupUrl}\nThen get the Loopcom Driver app and sign in with ${email}.`,
      });
      emailed = true;
    } catch (err: any) {
      app.log?.warn?.({ err: String(err?.message ?? err) }, "driver setup email failed (driver still created)");
    }

    await safeAudit({
      tenantId,
      action: "SUPERMARKET_DRIVER_INVITED",
      entityType: "User",
      entityId: created.id,
      actorUserId: String(user.sub ?? ""),
      metadata: { email, emailed },
    });
    return reply.send({ ok: true, userId: created.id, emailed });
  });

  /** Resend a driver's setup email — SAME stored token flow, and ⛔ refused
   *  outright for a driver who has ever signed in (resend-invite writes
   *  status INVITED + forcePasswordReset, which would destroy a working
   *  password — the TYH lesson: check lastLoginAt before every resend). */
  app.post("/supermarket/drivers/:userId/resend-invite", async (req: any, reply: any) => {
    if (!(await requireSupermarketMode(db, req, reply))) return;
    const user = getUser(req);
    const tenantId = tenantOf(req);
    const target = await db.user.findFirst({
      where: { id: String((req.params as any).userId), tenantId },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, status: true, lastLoginAt: true },
    });
    if (!target) return reply.status(404).send({ error: "not_found" });
    if (!(await allowed(req, "can_manage_tracking_drivers"))) return reply.status(403).send({ error: "forbidden" });
    const profile = await db.driverProfile.findFirst({ where: { tenantId, userId: target.id }, select: { id: true } });
    if (!profile) return reply.status(404).send({ error: "not_found" });
    if (target.lastLoginAt || target.status === "ACTIVE") {
      return reply.status(409).send({ error: "already_active", message: "This driver already signed in — resending would break their password." });
    }
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    try {
      const { token } = await deps.driverInvite.createInviteToken(target.id, String(user.sub ?? ""));
      const setupUrl = deps.driverInvite.portalPublicUrl(`/auth/invite/accept?token=${encodeURIComponent(token)}`);
      const storeName = String(tenant?.name ?? "your store");
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const driverName = [target.firstName, target.lastName].filter(Boolean).join(" ") || target.email;
      const html = renderShell({
        headerTitle: "You're set up as a driver",
        headerSubtitle: storeName,
        preheaderText: `${storeName} set you up as a delivery driver`,
        organizationName: storeName,
        body:
          `<p style="margin:0 0 16px;">Hi ${esc(driverName)},</p>` +
          `<p style="margin:0 0 16px;">Here is your setup link again — choose a password for the driver app.</p>` +
          `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:26px 0 6px;"><tr>` +
          `<td align="center" bgcolor="#22a8ff" style="border-radius:10px;background:#22a8ff;background-image:linear-gradient(135deg,#22a8ff,#4f7bff);">` +
          `<a href="${esc(setupUrl)}" target="_blank" style="display:inline-block;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:15px 30px;border-radius:10px;">Choose my password</a>` +
          `</td></tr></table>`,
      });
      await deps.driverInvite.queueEmailJob({
        tenantId,
        type: "DRIVER_INVITE",
        toEmail: target.email,
        subject: `${storeName} set you up as a delivery driver`,
        htmlBody: html,
        textBody: `Choose your password for the driver app: ${setupUrl}`,
      });
    } catch (err: any) {
      return reply.status(502).send({ error: "email_failed", message: "The email could not be queued — nothing was changed." });
    }
    return reply.send({ ok: true });
  });

  // ══════════════════════════ INTERNAL: pay-by-phone door ══════════════════

  app.post("/internal/supermarket/pay-ivr/step", async (req: any, reply: any) => {
    if (!internalGuard(req, reply, "/internal/supermarket/pay-ivr/step")) return;
    const parsed = payIvrStepSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_payload" });
    const settings = await db.supermarketSettings.findUnique({ where: { tenantId: parsed.data.tenantId } }).catch(() => null);
    const tenant = await db.tenant.findUnique({ where: { id: parsed.data.tenantId }, select: { crmMode: true } }).catch(() => null);
    if (tenant?.crmMode !== "supermarket" || !settings?.payIvrEnabled) {
      return reply.send({ prompts: ["20_connect_person"], gather: null, transfer: true, done: false });
    }
    const result = await runPayIvrStep({ db, log: app.log, clientFor }, parsed.data);
    return reply.send(result);
  });

  // ══════════════════════════ PUBLIC: unsubscribe ══════════════════════════

  app.get("/marketing/unsubscribe/:token", async (req: any, reply: any) => {
    const verdict = verifyUnsubscribeToken(String((req.params as any).token ?? ""));
    if (!verdict) return reply.status(400).type("text/html").send("<p>That unsubscribe link is not valid.</p>");
    try {
      await db.marketingUnsubscribe.upsert({
        where: { tenantId_email: { tenantId: verdict.tenantId, email: verdict.email } },
        update: {},
        create: { tenantId: verdict.tenantId, email: verdict.email },
      });
    } catch {
      /* an upsert race is fine — the row exists */
    }
    return reply
      .type("text/html")
      .send("<div style=\"font-family:sans-serif;max-width:32rem;margin:80px auto;text-align:center;\"><h2>You're unsubscribed.</h2><p>You won't get any more specials at this address.</p></div>");
  });
}
