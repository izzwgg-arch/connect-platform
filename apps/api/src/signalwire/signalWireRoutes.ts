/**
 * SignalWire evaluation console — the routes behind /apps/signalwire.
 *
 * Purpose (Izzy, 2026-08-18): "start pivoting away from voip.ms … set this up
 * and test it to see if this would be the ideal replacement … build this
 * inside Loopcom." So this is a TEST BENCH inside the product, not a cut-over:
 * every job VoIP.ms does for the platform today has a button here that does the
 * same job on SignalWire, so each can be proven (or disproven) one at a time
 * with the results recorded — before onboarding, chat, billing SMS or the PBX
 * trunk are pointed anywhere new.
 *
 * ⛔ Platform owner only (SUPER_ADMIN), every route. It spends real money
 * (buying a number, sending a text, registering 911) against the platform's own
 * account, and it creates durable objects on that account. There is
 * deliberately no permission key that can grant it — same rule as IVR
 * Migration.
 *
 * ⛔ Nothing here touches VoIP.ms, `GlobalVoipMsConfig`, `TenantSmsNumber`,
 * onboarding, the worker or the PBX. A number bought here lives on SignalWire
 * and in the event log below; it is not assigned to any tenant and rings no
 * PBX until a person wires it — that is what the SIP panel is for.
 *
 * ⛔ Every mutating action and every inbound webhook is written to
 * `AgentAuditLog` under `signalwire.*` (never a module variable — the api
 * restarts dozens of times a day, and the point of a test bench is the record).
 * The console's "Events" panel reads them back. Secrets (token, signing key,
 * a generated SIP password) are never written there.
 *
 * Registered from server.ts, which passes in the pieces that live there.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalApiBase } from "../publicOrigins";
import {
  describeSignalWireCredentials,
  resolveSignalWireCredentials,
  storeSignalWireCredentials,
  validateSignalWireCredentials,
  type StoredSignalWireCredentials,
} from "./signalWireCredentials";
import {
  SignalWireError,
  assignE911Address,
  assignPhoneRoute,
  checkConnection,
  createE911Address,
  createSipEndpoint,
  createSipGateway,
  getMessage,
  getSipProfile,
  listE911Addresses,
  listNumbers,
  listSipEndpoints,
  listSipGateways,
  lookupNumber,
  purchaseNumber,
  releaseNumber,
  searchNumbers,
  sendMessage,
  updateNumberHandlers,
} from "./signalWireClient";
import { candidatePublicUrls, explainRefusal, isSignalWireWebhookAuthorized } from "./signalWireWebhookAuth";

export interface SignalWireRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces platform-owner access, or replies. */
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
}

/** Public paths — both must be on the JWT bypass list (jwtPublicRouteBypass.ts). */
export const SIGNALWIRE_INBOUND_SMS_PATH = "/webhooks/signalwire/sms";
export const SIGNALWIRE_SMS_STATUS_PATH = "/webhooks/signalwire/sms-status";

/** Event names written to AgentAuditLog. The console filters on the prefix. */
export const SW_EVENT_PREFIX = "signalwire.";

const E164 = /^\+1\d{10}$/;

function toE164(v: unknown): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Where SignalWire should call us back. The portal passes its own origin (so
 * a console opened on app.loopcom.net registers loopcom.net webhooks — see the
 * two-hostnames handoff); a server-side caller falls back to env, then the
 * primary hostname. Always ends without a slash, always carries `/api`.
 */
export function resolvePublicApiBase(fromClient?: unknown): string {
  const candidate = String(fromClient ?? "").trim();
  let base = /^https:\/\/[a-z0-9.-]+(\/api)?\/?$/i.test(candidate) ? candidate : canonicalApiBase();
  base = base.replace(/\/+$/, "");
  if (!/\/api$/.test(base)) base += "/api";
  return base;
}

export function inboundSmsWebhookUrl(publicApiBase: string): string {
  return `${publicApiBase}${SIGNALWIRE_INBOUND_SMS_PATH}`;
}
export function smsStatusWebhookUrl(publicApiBase: string): string {
  return `${publicApiBase}${SIGNALWIRE_SMS_STATUS_PATH}`;
}

/** Audit row — the record of the evaluation. Never pass a secret in `payload`. */
export async function recordSignalWireEvent(db: any, event: string, payload: Record<string, unknown>, actor = "owner"): Promise<void> {
  const body = { actor, event: `${SW_EVENT_PREFIX}${event}`, ts: new Date().toISOString(), payload };
  try {
    await db.agentAuditLog.create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload,
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    });
  } catch {
    // The record must never fail the action it records.
  }
}

/** Route-level failure → plain English + the provider's own detail. */
function sendFailure(reply: any, err: unknown, fallback: string) {
  if (err instanceof SignalWireError) {
    return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
      error: err.code,
      message: err.userMessage,
      detail: err.detail ?? null,
    });
  }
  const msg = String((err as any)?.message || err || fallback);
  return reply.code(500).send({ error: "signalwire_failed", message: `${fallback} (${msg.slice(0, 200)})` });
}

/** Refusal-row throttle for the PUBLIC webhook: an attacker must not be able
 *  to fill the audit table by hammering an unsigned URL. In-memory is fine for
 *  a throttle (it only bounds volume; it is not state anyone reads back). */
let refusalWindowStart = 0;
let refusalCount = 0;
function refusalRowAllowed(): boolean {
  const now = Date.now();
  if (now - refusalWindowStart > 60 * 60 * 1000) {
    refusalWindowStart = now;
    refusalCount = 0;
  }
  refusalCount += 1;
  return refusalCount <= 30;
}

export function registerSignalWireRoutes(deps: SignalWireRouteDeps): void {
  const { app, db, requireOwner } = deps;

  async function requireCreds(reply: any): Promise<StoredSignalWireCredentials | null> {
    const creds = await resolveSignalWireCredentials(db);
    if (!creds) {
      reply.code(409).send({ error: "not_configured", message: "SignalWire isn't set up yet — save the Space URL, Project ID and API token first." });
      return null;
    }
    return creds;
  }

  // ── Status ────────────────────────────────────────────────────────────────
  app.get("/admin/apps/signalwire/status", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const described = await describeSignalWireCredentials(db);
    const publicApiBase = resolvePublicApiBase(req.query?.origin);
    const webhooks = { inboundSms: inboundSmsWebhookUrl(publicApiBase), smsStatus: smsStatusWebhookUrl(publicApiBase) };
    if (!described.configured) return reply.send({ ...described, connection: null, webhooks });
    const creds = (await resolveSignalWireCredentials(db))!;
    const connection = await checkConnection(creds);
    return reply.send({ ...described, connection, webhooks });
  });

  // ── Credentials ───────────────────────────────────────────────────────────
  app.put("/admin/apps/signalwire/credentials", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const body = z.object({
      spaceUrl: z.string().optional(),
      projectId: z.string().optional(),
      apiToken: z.string().optional(),
      signingKey: z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    // Blank Space URL = remove everything (the same "empty means clear"
    // convention the ElevenLabs key and Polly credentials use).
    if (!String(body.data.spaceUrl ?? "").trim()) {
      try {
        await storeSignalWireCredentials(db, null, `user:${user.sub}`);
      } catch (err: any) {
        return reply.code(500).send({ error: "clear_failed", message: "Couldn't remove the credentials. Try again." });
      }
      await recordSignalWireEvent(db, "credentials_cleared", { by: user.sub });
      return reply.send({ ok: true, cleared: true });
    }

    // Keep an existing signing key when a re-save leaves that box blank —
    // the token box is also allowed to stay blank on a re-save, so a person
    // can add the signing key later without re-pasting the token.
    const existing = await resolveSignalWireCredentials(db);
    const merged = {
      spaceUrl: body.data.spaceUrl,
      projectId: String(body.data.projectId ?? "").trim() || existing?.projectId,
      apiToken: String(body.data.apiToken ?? "").trim() || existing?.apiToken,
      signingKey: String(body.data.signingKey ?? "").trim() || existing?.signingKey || "",
    };
    const validated = validateSignalWireCredentials(merged);
    if (!validated.ok) return reply.code(400).send({ error: "invalid_credentials", message: validated.message });

    try {
      await storeSignalWireCredentials(db, validated.value, `user:${user.sub}`);
    } catch (err: any) {
      const missingMaster = String(err?.message || "") === "credentials_master_key_missing";
      return reply.code(missingMaster ? 503 : 500).send({
        error: missingMaster ? "encryption_unavailable" : "save_failed",
        message: missingMaster
          ? "This server can't store credentials securely yet (CREDENTIALS_MASTER_KEY isn't set). Nothing was saved."
          : "Couldn't save the credentials. Try again.",
      });
    }
    const connection = await checkConnection(validated.value);
    await recordSignalWireEvent(db, "credentials_saved", {
      by: user.sub, spaceUrl: validated.value.spaceUrl, projectId: validated.value.projectId,
      signingKeySet: Boolean(validated.value.signingKey), connectionOk: connection.ok, code: connection.code,
    });
    return reply.send({ ok: true, connection });
  });

  // ── Numbers ───────────────────────────────────────────────────────────────
  app.post("/admin/apps/signalwire/numbers/search", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      numberType: z.enum(["local", "toll-free"]).optional(),
      areaCode: z.string().max(5).optional(),
      region: z.string().max(2).optional(),
      city: z.string().max(60).optional(),
      startsWith: z.string().max(7).optional(),
      contains: z.string().max(7).optional(),
      endsWith: z.string().max(7).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    try {
      const startedAt = Date.now();
      const numbers = await searchNumbers(creds, body.data);
      return reply.send({ numbers, count: numbers.length, tookMs: Date.now() - startedAt });
    } catch (err) {
      return sendFailure(reply, err, "The number search failed.");
    }
  });

  app.get("/admin/apps/signalwire/numbers", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      const numbers = await listNumbers(creds);
      return reply.send({ numbers, count: numbers.length });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the numbers on the account.");
    }
  });

  app.post("/admin/apps/signalwire/numbers/purchase", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      number: z.string(),
      confirm: z.literal(true),
      /** Point the number's messaging at Loopcom's inbound webhook straight away (default on). */
      pointMessagingAtLoopcom: z.boolean().optional(),
      origin: z.string().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", message: "Confirm the purchase — it is billed monthly.", detail: body.error.flatten() });
    const e164 = toE164(body.data.number);
    if (!e164) return reply.code(400).send({ error: "invalid_number", message: "That isn't a US/Canada number." });

    let bought;
    try {
      bought = await purchaseNumber(creds, e164);
    } catch (err) {
      await recordSignalWireEvent(db, "number_purchase_failed", { by: user.sub, number: e164, error: err instanceof SignalWireError ? err.code : "unknown", message: String((err as any)?.message || err).slice(0, 300) });
      // ⛔ A timeout on a purchase is NOT retried: SignalWire may well have
      // completed it. Say so, and let the owner check the list.
      if (err instanceof SignalWireError && err.code === "timeout") {
        return reply.code(504).send({ error: "timeout", message: "SignalWire didn't answer in time. The purchase MAY have gone through — refresh the number list before trying again, so it isn't bought twice." });
      }
      return sendFailure(reply, err, "The purchase failed.");
    }
    await recordSignalWireEvent(db, "number_purchased", { by: user.sub, number: bought.number, id: bought.id, numberType: bought.numberType, capabilities: bought.capabilities });

    let handlers: { ok: boolean; message: string | null } = { ok: false, message: null };
    if (body.data.pointMessagingAtLoopcom !== false && bought.id) {
      const url = inboundSmsWebhookUrl(resolvePublicApiBase(body.data.origin));
      try {
        bought = await updateNumberHandlers(creds, bought.id, { messageHandler: "laml_webhooks", messageRequestUrl: url, messageRequestMethod: "POST", name: `Loopcom test ${bought.number}` });
        handlers = { ok: true, message: `Inbound texts to ${bought.number} will POST to ${url}.` };
        await recordSignalWireEvent(db, "number_messaging_pointed", { by: user.sub, number: bought.number, id: bought.id, url });
      } catch (err) {
        handlers = { ok: false, message: `Bought, but couldn't point its messaging at Loopcom: ${err instanceof SignalWireError ? err.userMessage : String((err as any)?.message || err)}` };
      }
    }
    return reply.send({ ok: true, number: bought, handlers });
  });

  app.post("/admin/apps/signalwire/numbers/:id/handlers", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const id = String(req.params?.id ?? "");
    const body = z.object({
      messaging: z.enum(["loopcom", "none"]).optional(),
      voice: z.enum(["sip_endpoint", "none"]).optional(),
      sipEndpointId: z.string().optional(),
      origin: z.string().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success || !id) return reply.code(400).send({ error: "invalid_body" });
    const patch: Parameters<typeof updateNumberHandlers>[2] = {};
    const publicApiBase = resolvePublicApiBase(body.data.origin);
    if (body.data.messaging === "loopcom") {
      patch.messageHandler = "laml_webhooks";
      patch.messageRequestUrl = inboundSmsWebhookUrl(publicApiBase);
      patch.messageRequestMethod = "POST";
    }
    if (body.data.voice === "sip_endpoint") {
      if (!body.data.sipEndpointId) return reply.code(400).send({ error: "invalid_body", message: "Pick the SIP endpoint the number should ring." });
      patch.callHandler = "relay_sip_endpoint";
      patch.callSipEndpointId = body.data.sipEndpointId;
    }
    if (!Object.keys(patch).length) return reply.code(400).send({ error: "invalid_body", message: "Nothing to change." });
    try {
      const number = await updateNumberHandlers(creds, id, patch);
      await recordSignalWireEvent(db, "number_handlers_updated", { by: user.sub, id, number: number.number, patch });
      return reply.send({ ok: true, number });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't update the number's routing.");
    }
  });

  app.delete("/admin/apps/signalwire/numbers/:id", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const id = String(req.params?.id ?? "");
    const confirm = String(req.query?.confirm ?? req.body?.confirm ?? "") === "true";
    if (!id || !confirm) return reply.code(400).send({ error: "confirm_required", message: "Confirm the release — a released number is gone from the account." });
    try {
      await releaseNumber(creds, id);
      await recordSignalWireEvent(db, "number_released", { by: user.sub, id });
      return reply.send({ ok: true });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't release the number.");
    }
  });

  // ── SMS ───────────────────────────────────────────────────────────────────
  app.post("/admin/apps/signalwire/sms/send", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      from: z.string(),
      to: z.string(),
      body: z.string().min(1).max(1600),
      origin: z.string().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const from = toE164(body.data.from);
    const to = toE164(body.data.to);
    if (!from || !to) return reply.code(400).send({ error: "invalid_number", message: "From and To must both be US/Canada numbers." });
    try {
      const sent = await sendMessage(creds, {
        from, to, body: body.data.body,
        statusCallback: smsStatusWebhookUrl(resolvePublicApiBase(body.data.origin)),
      });
      await recordSignalWireEvent(db, "sms_sent", { by: user.sub, from, to, sid: sent.sid, status: sent.status, segments: sent.numSegments, bodyLength: body.data.body.length });
      return reply.send({ ok: true, message: sent });
    } catch (err) {
      await recordSignalWireEvent(db, "sms_send_failed", { by: user.sub, from, to, error: err instanceof SignalWireError ? err.code : "unknown", message: String((err as any)?.message || err).slice(0, 300) });
      return sendFailure(reply, err, "The text could not be sent.");
    }
  });

  app.get("/admin/apps/signalwire/sms/:sid", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ ok: true, message: await getMessage(creds, String(req.params?.sid ?? "")) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't read that message back.");
    }
  });

  // ── Events (the record of the evaluation) ─────────────────────────────────
  app.get("/admin/apps/signalwire/events", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 50) || 50, 1), 200);
    const rows = await db.agentAuditLog.findMany({
      where: { event: { startsWith: SW_EVENT_PREFIX } },
      orderBy: { ts: "desc" },
      take: limit,
      select: { id: true, ts: true, actor: true, event: true, payload: true },
    });
    return reply.send({ events: rows.map((r: any) => ({ ...r, event: String(r.event).slice(SW_EVENT_PREFIX.length) })) });
  });

  // ── SIP ───────────────────────────────────────────────────────────────────
  app.get("/admin/apps/signalwire/sip", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const [endpoints, gateways, profile] = await Promise.all([
      listSipEndpoints(creds).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e instanceof SignalWireError ? e.userMessage : String(e?.message || e) })),
      listSipGateways(creds).then((v) => ({ ok: true as const, value: v })).catch((e) => ({ ok: false as const, error: e instanceof SignalWireError ? e.userMessage : String(e?.message || e) })),
      getSipProfile(creds).catch(() => null),
    ]);
    return reply.send({
      // ⛔ The registrar comes from the SIP profile, never from the Space name —
      // proven live 2026-08-18: loopcom.signalwire.com registers at
      // loopcom-ef2ea3442802.sip.signalwire.com. A guess here registers nothing.
      sipDomain: profile?.domain ?? null,
      sipProfile: profile ? { defaultCodecs: profile.defaultCodecs, defaultEncryption: profile.defaultEncryption, defaultSendAs: profile.defaultSendAs } : null,
      endpoints: endpoints.ok ? endpoints.value : [],
      endpointsError: endpoints.ok ? null : endpoints.error,
      gateways: gateways.ok ? gateways.value : [],
      gatewaysError: gateways.ok ? null : gateways.error,
    });
  });

  app.post("/admin/apps/signalwire/sip/endpoints", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      username: z.string().min(3).max(64).regex(/^[a-z0-9_.-]+$/i, "letters, digits, dot, dash and underscore only"),
      password: z.string().min(12).max(128).optional(),
      sendAs: z.string().optional(),
      callerId: z.string().max(32).optional(),
      encryption: z.enum(["optional", "required", "default"]).optional(),
      callHandler: z.enum(["default", "passthrough", "block-pstn"]).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    // A generated password is returned ONCE in this response and never stored
    // or logged by us — it goes into the PBX trunk by hand.
    const password = body.data.password || randomBytes(18).toString("base64url");
    const sendAs = body.data.sendAs ? toE164(body.data.sendAs) : null;
    if (body.data.sendAs && !sendAs) return reply.code(400).send({ error: "invalid_number", message: "Send-as must be a purchased or verified US/Canada number." });
    try {
      const endpoint = await createSipEndpoint(creds, {
        username: body.data.username, password,
        sendAs: sendAs ?? undefined, callerId: body.data.callerId,
        encryption: body.data.encryption, callHandler: body.data.callHandler ?? "passthrough",
      });
      await recordSignalWireEvent(db, "sip_endpoint_created", { by: user.sub, id: endpoint.id, username: body.data.username, sendAs, callHandler: endpoint.callHandler, via: endpoint.via });
      const profile = await getSipProfile(creds).catch(() => null);
      return reply.send({
        ok: true,
        endpoint,
        password,
        registrar: profile?.domain ?? null,
      });
    } catch (err) {
      await recordSignalWireEvent(db, "sip_endpoint_create_failed", { by: user.sub, username: body.data.username, error: err instanceof SignalWireError ? err.code : "unknown", message: String((err as any)?.message || err).slice(0, 300) });
      return sendFailure(reply, err, "Couldn't create the SIP endpoint.");
    }
  });

  app.post("/admin/apps/signalwire/sip/gateways", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      name: z.string().min(2).max(64),
      uri: z.string().min(3).max(200),
      encryption: z.enum(["optional", "required", "default"]).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const uri = body.data.uri.trim().replace(/^sips?:/i, "");
    try {
      const gateway = await createSipGateway(creds, { name: body.data.name, uri, encryption: body.data.encryption });
      await recordSignalWireEvent(db, "sip_gateway_created", { by: user.sub, id: gateway.id, name: body.data.name, uri });
      return reply.send({ ok: true, gateway });
    } catch (err) {
      await recordSignalWireEvent(db, "sip_gateway_create_failed", { by: user.sub, name: body.data.name, uri, error: err instanceof SignalWireError ? err.code : "unknown", message: String((err as any)?.message || err).slice(0, 300) });
      return sendFailure(reply, err, "Couldn't create the SIP gateway.");
    }
  });

  app.post("/admin/apps/signalwire/sip/routes", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      resourceId: z.string().min(1),
      phoneNumberId: z.string().min(1),
      handler: z.enum(["calling", "messaging"]).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    try {
      const result = await assignPhoneRoute(creds, body.data.resourceId, body.data.phoneNumberId, body.data.handler ?? "calling");
      await recordSignalWireEvent(db, "phone_route_assigned", { by: user.sub, ...body.data });
      return reply.send({ ok: true, result });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't point the number at that SIP resource.");
    }
  });

  // ── E911 ──────────────────────────────────────────────────────────────────
  app.get("/admin/apps/signalwire/e911/addresses", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    try {
      return reply.send({ addresses: await listE911Addresses(creds) });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't list the emergency addresses.");
    }
  });

  app.post("/admin/apps/signalwire/e911/addresses", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({
      label: z.string().min(1).max(32),
      firstName: z.string().min(1).max(60),
      lastName: z.string().min(1).max(60),
      streetNumber: z.string().min(1).max(16),
      streetName: z.string().min(1).max(80),
      city: z.string().min(1).max(60),
      state: z.string().length(2),
      postalCode: z.string().min(5).max(10),
      addressType: z.string().max(16).optional(),
      addressNumber: z.string().max(16).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    try {
      const address = await createE911Address(creds, { ...body.data, state: body.data.state.toUpperCase() });
      await recordSignalWireEvent(db, "e911_address_created", { by: user.sub, id: address.id, label: address.label, line: address.line });
      return reply.send({ ok: true, address });
    } catch (err) {
      await recordSignalWireEvent(db, "e911_address_failed", { by: user.sub, label: body.data.label, error: err instanceof SignalWireError ? err.code : "unknown", message: String((err as any)?.message || err).slice(0, 300) });
      return sendFailure(reply, err, "SignalWire wouldn't accept that emergency address.");
    }
  });

  app.post("/admin/apps/signalwire/e911/assign", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const body = z.object({ phoneNumberId: z.string().min(1), addressId: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_body", message: "Confirm the registration — E911 is billable and safety-critical.", detail: body.error.flatten() });
    try {
      const number = await assignE911Address(creds, body.data.phoneNumberId, body.data.addressId);
      await recordSignalWireEvent(db, "e911_assigned", { by: user.sub, phoneNumberId: body.data.phoneNumberId, addressId: body.data.addressId, number: number.number, e911Status: number.e911Status });
      return reply.send({ ok: true, number });
    } catch (err) {
      return sendFailure(reply, err, "Couldn't register the emergency address on that number.");
    }
  });

  // ── Lookup ────────────────────────────────────────────────────────────────
  app.post("/admin/apps/signalwire/lookup", async (req: any, reply: any) => {
    const user = await requireOwner(req, reply);
    if (!user) return;
    const creds = await requireCreds(reply);
    if (!creds) return;
    const e164 = toE164(req.body?.number);
    if (!e164) return reply.code(400).send({ error: "invalid_number", message: "Enter a US/Canada number." });
    try {
      const result = await lookupNumber(creds, e164);
      await recordSignalWireEvent(db, "lookup", { by: user.sub, number: e164, cnam: result.cnam, carrier: result.carrier, lineType: result.lineType });
      return reply.send({ ok: true, number: e164, ...result });
    } catch (err) {
      return sendFailure(reply, err, "The lookup failed.");
    }
  });

  // ── PUBLIC webhooks (JWT bypass; signature-verified; FAIL CLOSED) ─────────
  async function webhookGate(req: any, reply: any, kind: "inbound_sms" | "sms_status"): Promise<Record<string, string> | null> {
    const creds = await resolveSignalWireCredentials(db).catch(() => null);
    const params: Record<string, string> = {};
    const method = String(req.method || "").toUpperCase();
    // POST: signed params are the form body. GET: they are already in the URL.
    if (method === "POST" && req.body && typeof req.body === "object") {
      for (const [k, v] of Object.entries(req.body)) params[k] = Array.isArray(v) ? String(v[0]) : String(v ?? "");
    }
    const input = {
      signingKey: creds?.signingKey ?? null,
      signature: (req.headers["x-signalwire-signature"] ?? req.headers["x-twilio-signature"]) as string | undefined,
      candidateUrls: candidatePublicUrls(req),
      params,
    };
    if (!isSignalWireWebhookAuthorized(input)) {
      const reason = explainRefusal(input);
      if (refusalRowAllowed()) {
        await recordSignalWireEvent(db, "webhook_refused", { kind, reason, method, from: params.From ?? req.query?.From ?? null, to: params.To ?? req.query?.To ?? null }, "system");
      }
      reply.code(401).send({ error: "unauthorized", reason });
      return null;
    }
    const merged: Record<string, string> = { ...params };
    for (const [k, v] of Object.entries(req.query ?? {})) if (!(k in merged)) merged[k] = String(v ?? "");
    return merged;
  }

  const inboundHandler = async (req: any, reply: any) => {
    const p = await webhookGate(req, reply, "inbound_sms");
    if (!p) return;
    const numMedia = Number(p.NumMedia ?? 0) || 0;
    const media: string[] = [];
    for (let i = 0; i < numMedia; i += 1) if (p[`MediaUrl${i}`]) media.push(p[`MediaUrl${i}`]);
    await recordSignalWireEvent(db, "inbound_sms", {
      from: p.From ?? null, to: p.To ?? null, body: String(p.Body ?? "").slice(0, 1600),
      sid: p.MessageSid ?? null, numMedia, media,
    }, "system");
    // An empty cXML document = "received, do nothing" — no auto-reply.
    reply.header("content-type", "text/xml; charset=utf-8");
    return reply.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  };
  app.post(SIGNALWIRE_INBOUND_SMS_PATH, inboundHandler);
  app.get(SIGNALWIRE_INBOUND_SMS_PATH, inboundHandler);

  app.post(SIGNALWIRE_SMS_STATUS_PATH, async (req: any, reply: any) => {
    const p = await webhookGate(req, reply, "sms_status");
    if (!p) return;
    await recordSignalWireEvent(db, "sms_status", {
      sid: p.MessageSid ?? null, status: p.MessageStatus ?? null, from: p.From ?? null, to: p.To ?? null,
      errorCode: p.ErrorCode ?? null, segments: p.NumSegments ?? null,
    }, "system");
    return reply.send({ ok: true });
  });
}
