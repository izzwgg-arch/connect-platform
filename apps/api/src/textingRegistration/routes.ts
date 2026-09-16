/**
 * Routes for 10DLC texting registration (2026-09-16).
 *
 *   /admin/texting-registration/*     platform staff (SUPER_ADMIN jwt) AND the
 *                                     matching action key — a custom role can
 *                                     narrow what staff may do, but a tenant
 *                                     user can never reach another company's
 *                                     registration by holding a key.
 *   /texting-registration/:token/*    the customer's private link (JWT bypass,
 *                                     anchored in jwtPublicRouteBypass.ts)
 *   /texting-registration/policy/:slug  the business's public privacy policy + terms
 *   /webhooks/telnyx/10dlc            registry status updates — Ed25519
 *                                     fail-closed; a TRIGGER to re-read only
 *
 * ⛔ Public routes are rate limited per IP here (in-process) because the
 * global limiter is too loose for a form that accepts an EIN.
 * ⛔ No response ever carries an EIN token, a raw EIN (except the audited
 * staff reveal), or a carrier name on a customer route.
 */
import {
  RegistrationError,
  appeal,
  advanceRegistration,
  contentOf,
  createLink,
  createRegistration,
  deactivate,
  factsOf,
  fileWithTelnyx,
  loadPrefill,
  publicView,
  registrationChecks,
  resendOwnerPin,
  resolvePublicLink,
  revealEin,
  revokeLinks,
  saveDraft,
  sendBackToCustomer,
  staffUpdateBusiness,
  submitCustomerForm,
  sweepState,
  telnyxNumbersFor,
  updateContent,
  verifyOwnerPin,
  type EngineDeps,
} from "./engine";
import { buildInviteEmail, INVITE_EMAIL_TYPE } from "./emails";
import { buildPrivacyPolicy, buildSmsTerms, cleanName } from "./content";
import { NEEDS_STAFF, STATUS_LABEL, type RegistrationStatus } from "./phases";
import { maskedEin } from "./tokens";

export const TEXTING_REGISTRATION_WEBHOOK_PATH = "/webhooks/telnyx/10dlc";

export const KEYS = {
  view: "can_view_admin_texting_registration",
  sendLink: "can_send_texting_registration_link",
  viewEin: "can_view_texting_registration_ein",
  file: "can_file_texting_registration",
  fix: "can_fix_texting_registration",
  deactivate: "can_deactivate_texting_registration",
} as const;

export interface RouteDeps {
  app: any;
  engine: () => EngineDeps;
  /** Resolves the signed-in platform staff user, or sends 401/403 and returns null. */
  requireStaff: (req: any, reply: any) => Promise<{ sub: string; tenantId?: string } | null>;
  hasKey: (user: any, key: string) => Promise<boolean>;
  telnyxHealth?: () => Promise<{ connected: boolean; publicKeySet: boolean; balance: string | null }>;
  verifySignature?: (input: { publicKeyB64: string; signatureB64: string; timestamp: string; rawBody: string | Buffer }) => { ok: boolean; reason?: string };
  resolvePublicKey?: () => Promise<string | null>;
}

// ── Tiny per-IP limiter for the public link ─────────────────────────────────

export function createLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 20_000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

function clientIp(req: any): string {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || req.ip || "unknown";
}

function sendError(reply: any, err: unknown, log?: any) {
  if (err instanceof RegistrationError) return reply.code(err.status).send({ error: err.code, message: err.message });
  log?.error?.({ err: String((err as any)?.message || err) }, "texting_registration_route_error");
  return reply.code(500).send({ error: "internal", message: "Something went wrong. Try again." });
}

function summarize(reg: any) {
  return {
    id: reg.id,
    tenantId: reg.tenantId,
    tenantName: reg.tenant?.name ?? null,
    displayName: reg.displayName,
    businessEmail: reg.businessEmail,
    contactName: [reg.contactFirstName, reg.contactLastName].filter(Boolean).join(" ") || null,
    status: reg.status,
    statusLabel: STATUS_LABEL[reg.status as RegistrationStatus] || reg.status,
    needsStaff: (NEEDS_STAFF as string[]).includes(reg.status),
    numbersCount: Array.isArray(reg.numbers) ? reg.numbers.length : 0,
    carrierReviews: reg.carrierReviews ?? null,
    lastError: reg.lastError,
    submittedAt: reg.submittedAt,
    filedAt: reg.filedAt,
    liveAt: reg.liveAt,
    renewsAt: reg.renewsAt,
    updatedAt: reg.updatedAt,
    lastLink: reg.links?.[0]
      ? { createdAt: reg.links[0].createdAt, emailedTo: reg.links[0].emailedTo, emailedAt: reg.links[0].emailedAt, openedAt: reg.links[0].openedAt, usedAt: reg.links[0].usedAt, revokedAt: reg.links[0].revokedAt, expiresAt: reg.links[0].expiresAt }
      : null,
  };
}

export function registerTextingRegistrationRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const gate = async (req: any, reply: any, key: string) => {
    const user = await deps.requireStaff(req, reply);
    if (!user) return null;
    if (!(await deps.hasKey(user, KEYS.view)) || !(await deps.hasKey(user, key))) {
      reply.code(403).send({ error: "forbidden", permission: key });
      return null;
    }
    return user;
  };
  const load = async (id: string) => {
    const reg = await deps.engine().db.textingRegistration.findUnique({ where: { id } });
    if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
    return reg;
  };

  // ── Admin: board ──────────────────────────────────────────────────────────
  app.get("/admin/texting-registration", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.view);
    if (!user) return;
    try {
      const e = deps.engine();
      const rows = await e.db.textingRegistration.findMany({
        orderBy: { updatedAt: "desc" },
        take: 500,
        include: { tenant: { select: { name: true } }, links: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
      const health = deps.telnyxHealth ? await deps.telnyxHealth().catch(() => null) : null;
      return {
        registrations: rows.map(summarize),
        counts,
        health: {
          telnyx: health,
          sweep: { lastRunAt: sweepState.lastRunAt, lastResult: sweepState.lastResult, lastError: sweepState.lastError },
        },
      };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.get("/admin/texting-registration/customers", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      const q = cleanName((req.query as any)?.q).slice(0, 80);
      const e = deps.engine();
      const tenants = await e.db.tenant.findMany({
        where: q ? { name: { contains: q, mode: "insensitive" } } : {},
        orderBy: { name: "asc" },
        take: 50,
        select: { id: true, name: true, textingRegistrations: { where: { status: { not: "deactivated" } }, select: { id: true, status: true } } },
      });
      return { customers: tenants.map((t: any) => ({ id: t.id, name: t.name, registrationId: t.textingRegistrations[0]?.id ?? null, status: t.textingRegistrations[0]?.status ?? null })) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.get("/admin/texting-registration/customers/:tenantId/prefill", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      return { prefill: await loadPrefill(deps.engine().db, String(req.params.tenantId)) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      const tenantId = String((req.body as any)?.tenantId || "");
      if (!tenantId) throw new RegistrationError("tenant_required", "Choose a customer.");
      const reg = await createRegistration(deps.engine(), tenantId, user.sub);
      return { registration: summarize(reg) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  // ── Admin: one registration ───────────────────────────────────────────────
  app.get("/admin/texting-registration/:id", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.view);
    if (!user) return;
    try {
      const e = deps.engine();
      const reg = await e.db.textingRegistration.findUnique({
        where: { id: String(req.params.id) },
        include: {
          tenant: { select: { name: true } },
          links: { orderBy: { createdAt: "desc" }, take: 10 },
          events: { orderBy: { createdAt: "desc" }, take: 200 },
          ein: { select: { last4: true, createdAt: true } },
        },
      });
      if (!reg) throw new RegistrationError("not_found", "Registration not found.", 404);
      const facts = factsOf(reg, e.portalOrigin());
      const checks = await registrationChecks(e, reg);
      const telnyxNumbers = await telnyxNumbersFor(e, reg.tenantId);
      return {
        registration: {
          ...summarize(reg),
          publicSlug: reg.publicSlug,
          businessPhone: reg.businessPhone,
          contactFirstName: reg.contactFirstName,
          contactLastName: reg.contactLastName,
          vertical: reg.vertical,
          numbers: reg.numbers,
          telnyxNumbers,
          answers: {
            legalName: reg.legalName, entityType: reg.entityType, street: reg.street, city: reg.city, state: reg.state,
            postalCode: reg.postalCode, website: reg.website, mobilePhone: reg.mobilePhone,
          },
          ein: { onFile: !!reg.ein, masked: maskedEin(reg.ein?.last4), storedAt: reg.ein?.createdAt ?? null },
          signatureName: reg.signatureName,
          consentAt: reg.consentAt,
          content: contentOf(reg, e.portalOrigin()),
          contentEdited: Object.keys(reg.content || {}),
          fixFields: reg.fixFields,
          fixNote: reg.fixNote,
          privacyUrl: facts.privacyUrl,
          termsUrl: facts.termsUrl,
          telnyx: {
            brandId: reg.telnyxBrandId, tcrBrandId: reg.tcrBrandId, brandIdentityStatus: reg.brandIdentityStatus, brandStatus: reg.brandStatus,
            brandFeedback: reg.brandFeedback, campaignId: reg.telnyxCampaignId, tcrCampaignId: reg.tcrCampaignId, campaignStatus: reg.campaignStatus,
            failureReasons: reg.failureReasons, numberAssignments: reg.numberAssignments,
          },
          chargeReference: reg.chargeReference,
          chargeAddedAt: reg.chargeAddedAt,
          lastCheckedAt: reg.lastCheckedAt,
          links: reg.links.map((l: any) => ({ id: l.id, createdAt: l.createdAt, expiresAt: l.expiresAt, revokedAt: l.revokedAt, openedAt: l.openedAt, usedAt: l.usedAt, emailedTo: l.emailedTo, emailedAt: l.emailedAt })),
          events: reg.events.map((ev: any) => ({ id: ev.id, kind: ev.kind, message: ev.message, actorUserId: ev.actorUserId, createdAt: ev.createdAt })),
        },
        checks,
      };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/link", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      const e = deps.engine();
      const body: any = req.body || {};
      const reg = await load(String(req.params.id));
      const to = String(body.email || "").trim();
      if (body.sendEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new RegistrationError("email_invalid", "Enter a valid email address.");
      const link = await createLink(e, reg.id, user.sub);
      let emailed = false;
      if (body.sendEmail) {
        if (!e.queueEmail) throw new RegistrationError("email_unavailable", "Email is not available.", 503);
        const mail = buildInviteEmail({ displayName: reg.displayName, firstName: reg.contactFirstName, formUrl: link.url });
        await e.queueEmail({ tenantId: reg.tenantId, type: INVITE_EMAIL_TYPE, to, ...mail });
        await e.db.textingRegistrationLink.update({ where: { id: link.linkId }, data: { emailedTo: to, emailedAt: e.now() } });
        await e.db.textingRegistrationEvent.create({ data: { registrationId: reg.id, kind: "link_emailed", message: `10DLC form emailed to ${to}`, actorUserId: user.sub } });
        emailed = true;
      }
      return { url: link.url, expiresAt: link.expiresAt, emailed };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/link/revoke", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      return { revoked: await revokeLinks(deps.engine(), String(req.params.id), user.sub) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.get("/admin/texting-registration/:id/email-preview", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.sendLink);
    if (!user) return;
    try {
      const reg = await load(String(req.params.id));
      const mail = buildInviteEmail({ displayName: reg.displayName, firstName: reg.contactFirstName, formUrl: `${deps.engine().portalOrigin()}/texting-registration/…` });
      return { subject: mail.subject, html: mail.html };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/reveal-ein", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.viewEin);
    if (!user) return;
    try {
      reply.header("Cache-Control", "no-store");
      return { ein: await revealEin(deps.engine(), String(req.params.id), user.sub) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.patch("/admin/texting-registration/:id/content", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.fix);
    if (!user) return;
    try {
      await updateContent(deps.engine(), String(req.params.id), (req.body as any) || {}, user.sub);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.patch("/admin/texting-registration/:id/business", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.fix);
    if (!user) return;
    try {
      await staffUpdateBusiness(deps.engine(), String(req.params.id), (req.body as any) || {}, user.sub);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/send-back", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.fix);
    if (!user) return;
    try {
      const b: any = req.body || {};
      await sendBackToCustomer(deps.engine(), String(req.params.id), Array.isArray(b.fields) ? b.fields : [], String(b.note || ""), user.sub);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/file", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.file);
    if (!user) return;
    try {
      const reg = await fileWithTelnyx(deps.engine(), String(req.params.id), user.sub);
      return { status: reg?.status, statusLabel: STATUS_LABEL[reg?.status as RegistrationStatus] || reg?.status, lastError: reg?.lastError ?? null };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/refresh", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.view);
    if (!user) return;
    try {
      const reg = await advanceRegistration(deps.engine(), String(req.params.id));
      return { status: reg?.status, lastError: reg?.lastError ?? null };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/appeal", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.fix);
    if (!user) return;
    try {
      await appeal(deps.engine(), String(req.params.id), String((req.body as any)?.reason || ""), user.sub);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/admin/texting-registration/:id/deactivate", async (req: any, reply: any) => {
    const user = await gate(req, reply, KEYS.deactivate);
    if (!user) return;
    try {
      await deactivate(deps.engine(), String(req.params.id), String((req.body as any)?.confirmName || ""), user.sub);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  // ── Public: the customer's link ───────────────────────────────────────────
  const readLimit = createLimiter(60, 60_000);
  // The policy page is public text rendered server-side by the portal, so many
  // viewers share the portal's address here — a far looser ceiling.
  const policyLimit = createLimiter(1200, 60_000);
  const writeLimit = createLimiter(20, 60_000);
  const pinLimit = createLimiter(8, 10 * 60_000);
  const limited = (reply: any) => reply.code(429).send({ error: "rate_limited", message: "Too many requests. Wait a minute and try again." });
  const unavailable = (reply: any, state: string, reg: any) =>
    reply.code(state === "not_found" ? 404 : 410).send({
      error: `link_${state}`,
      message:
        state === "used" ? "This form was already sent." :
        state === "expired" ? "This link has expired." :
        state === "revoked" ? "This link was replaced with a newer one." : "This link isn't valid.",
      displayName: reg?.displayName ?? null,
      submittedAt: state === "used" ? reg?.submittedAt ?? null : null,
      signatureName: state === "used" ? reg?.signatureName ?? null : null,
    });

  app.get("/texting-registration/policy/:slug", async (req: any, reply: any) => {
    if (!policyLimit(clientIp(req))) return limited(reply);
    try {
      const e = deps.engine();
      const reg = await e.db.textingRegistration.findUnique({ where: { publicSlug: String(req.params.slug || "").slice(0, 80) } });
      if (!reg || reg.status === "deactivated") return reply.code(404).send({ error: "not_found" });
      const facts = factsOf(reg, e.portalOrigin());
      reply.header("Cache-Control", "public, max-age=300");
      return { displayName: reg.displayName, legalName: reg.legalName || reg.displayName, privacy: buildPrivacyPolicy(facts), terms: buildSmsTerms(facts) };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.get("/texting-registration/:token", async (req: any, reply: any) => {
    if (!readLimit(clientIp(req))) return limited(reply);
    try {
      reply.header("Cache-Control", "no-store");
      reply.header("X-Robots-Tag", "noindex");
      const e = deps.engine();
      const r = await resolvePublicLink(e, String(req.params.token || ""));
      if (r.state !== "ok") return unavailable(reply, r.state, r.reg);
      const ein = await e.db.textingRegistrationEin.findUnique({ where: { registrationId: r.reg.id }, select: { registrationId: true } });
      return publicView(e, r.reg, { einOnFile: !!ein });
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/texting-registration/:token/draft", async (req: any, reply: any) => {
    if (!writeLimit(clientIp(req))) return limited(reply);
    try {
      await saveDraft(deps.engine(), String(req.params.token || ""), req.body || {});
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/texting-registration/:token/submit", async (req: any, reply: any) => {
    if (!writeLimit(clientIp(req))) return limited(reply);
    try {
      reply.header("Cache-Control", "no-store");
      const result = await submitCustomerForm(deps.engine(), String(req.params.token || ""), req.body || {}, { ip: clientIp(req) });
      if (!result.ok) return reply.code(422).send({ error: "invalid", errors: result.errors });
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/texting-registration/:token/pin", async (req: any, reply: any) => {
    if (!pinLimit(clientIp(req))) return limited(reply);
    try {
      return await verifyOwnerPin(deps.engine(), String(req.params.token || ""), String((req.body as any)?.pin || ""));
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  app.post("/texting-registration/:token/resend-pin", async (req: any, reply: any) => {
    if (!pinLimit(clientIp(req))) return limited(reply);
    try {
      await resendOwnerPin(deps.engine(), String(req.params.token || ""));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err, req.log);
    }
  });

  // ── Webhook: a trigger to re-read ─────────────────────────────────────────
  const webhookThrottle = new Map<string, number>();
  app.post(TEXTING_REGISTRATION_WEBHOOK_PATH, { config: { rawBody: true } }, async (req: any, reply: any) => {
    const publicKey = deps.resolvePublicKey ? await deps.resolvePublicKey().catch(() => null) : null;
    if (!publicKey || !deps.verifySignature) return reply.code(401).send({ error: "unverifiable" });
    const signature = String(req.headers["telnyx-signature-ed25519"] ?? "");
    const timestamp = String(req.headers["telnyx-timestamp"] ?? "");
    const rawBody: string | Buffer | undefined = (req as any).rawBody;
    if (!signature || !timestamp || rawBody == null) return reply.code(401).send({ error: "unsigned" });
    const verdict = deps.verifySignature({ publicKeyB64: publicKey, signatureB64: signature, timestamp, rawBody });
    if (!verdict.ok) return reply.code(401).send({ error: "unauthorized", reason: verdict.reason });
    let payload: any = {};
    try {
      payload = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
    } catch {
      return reply.send({ ok: true, note: "unparseable" });
    }
    const ids = extractRegistryIds(payload);
    const e = deps.engine();
    const or: any[] = [];
    if (ids.brandId) or.push({ telnyxBrandId: ids.brandId });
    if (ids.campaignId) or.push({ telnyxCampaignId: ids.campaignId });
    if (!or.length) return reply.send({ ok: true, matched: 0 });
    const regs = await e.db.textingRegistration.findMany({ where: { OR: or }, select: { id: true } });
    const now = Date.now();
    for (const r of regs) {
      if (now - (webhookThrottle.get(r.id) || 0) < 20_000) continue;
      webhookThrottle.set(r.id, now);
      void advanceRegistration(e, r.id).catch(() => null);
    }
    return reply.send({ ok: true, matched: regs.length });
  });
}

/** Brand/campaign ids from either payload shape Telnyx documents (envelope or flat). Nothing else is read. */
export function extractRegistryIds(payload: any): { brandId: string | null; campaignId: string | null } {
  const p = payload?.data?.payload ?? payload?.payload ?? payload ?? {};
  const pick = (...vals: any[]) => {
    for (const v of vals) if (typeof v === "string" && v.trim() && v.length <= 80) return v.trim();
    return null;
  };
  return {
    brandId: pick(p.brandId, p.brand_id, payload?.brandId),
    campaignId: pick(p.campaignId, p.campaign_id, payload?.campaignId),
  };
}
