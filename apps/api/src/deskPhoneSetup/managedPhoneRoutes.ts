import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { userHasActionPermission } from "../permissionGates";
import { ManagedPhoneService } from "./managedPhoneService";
import { DeviceError } from "./yealinkRps";
import { YEALINK_MANAGED_MODELS } from "./yealinkConfig";
import { managedPhoneDuration, managedPhoneOperations } from "./managedPhoneMetrics";

const text = z.string().trim().max(80).regex(/^[^\r\n\x00-\x1f#]*$/);
const options = z.object({ refreshMinutes: z.number().int().min(60).max(10080).optional(),
  vlan: z.number().int().min(1).max(4094).optional(), callWaiting: z.boolean().optional() }).strict();
const provision = z.object({ mac: z.string().max(32),
  // ⛔ Serial is mandatory: Yealink RPS forbids a MAC-only claim (403) and
  // requires the SN as proof of possession. Alphanumeric with - . _ separators.
  serialNumber: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9._-]+$/),
  model: z.string().max(16), extensionId: z.string().min(1).max(100),
  nickname: text.optional(), displayName: text.optional(), options: options.optional(), replacesId: z.string().max(100).optional() }).strict();
const update = provision.pick({ extensionId: true, nickname: true, displayName: true, options: true }).partial();

/**
 * ⛔ `req.ip` is the nginx hop on this platform (Fastify has no trustProxy). nginx
 * APPENDS the real peer as the LAST X-Forwarded-For entry; earlier entries are
 * client-controlled. Only a well-formed address is stored.
 */
export function handsetSourceIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const raw = req.headers["x-forwarded-for"];
  const last = String(Array.isArray(raw) ? raw[raw.length - 1] : raw ?? "").split(",").pop()?.trim() || "";
  const candidate = last || String(req.ip || "");
  return /^[0-9a-f:.]{2,45}$/i.test(candidate) ? candidate : "";
}

export async function registerManagedPhoneRoutes(app: FastifyInstance, injected?: ManagedPhoneService) {
  // Existing wizard remains usable without deploying/configuring the new service.
  const enabled = () => process.env.MANAGED_PHONE_PROVISIONING_ENABLED === "1" || !!injected;
  let singleton: ManagedPhoneService | undefined = injected;
  const service = () => singleton ??= new ManagedPhoneService();
  const actor = async (req: any) => {
    if (!req.user?.tenantId || !req.user?.sub) throw new DeviceError("unauthorized", 401);
    if (!(await userHasActionPermission(req.user, "can_setup_desk_phones"))) throw new DeviceError("forbidden", 403);
    if (!enabled()) throw new DeviceError("managed_provisioning_not_enabled", 503);
    return { tenantId: req.user.tenantId, sub: req.user.sub };
  };
  const guarded = (fn: (req: any, reply: any) => Promise<any>) => async (req: any, reply: any) => {
    const operation = req.routeOptions.url;
    const end = managedPhoneDuration.startTimer({ operation });
    try { const result = await fn(req, reply); managedPhoneOperations.inc({ operation, result: "accepted" }); return result; } catch (e) {
      managedPhoneOperations.inc({ operation, result: "failed" });
      if (e instanceof DeviceError) return reply.code(e.status).send({ error: e.code });
      if (e instanceof z.ZodError) return reply.code(400).send({ error: "invalid_phone_settings", fields: e.issues.map(i => i.path.join(".")) });
      // Do not log upstream errors or their SQL/parameters (may contain secrets).
      req.log.warn({ code: "managed_phone_operation_failed", requestId: req.id }, "Managed phone request failed");
      return reply.code(503).send({ error: "phone_service_unavailable_retry_to_reconcile" });
    } finally { end(); }
  };
  app.get("/desk-phones/managed/capabilities", guarded(async (req) => {
    if (!req.user?.tenantId) throw new DeviceError("unauthorized", 401);
    const allowed = await userHasActionPermission(req.user, "can_setup_desk_phones");
    return { enabled: enabled() && allowed, models: enabled() && allowed ? YEALINK_MANAGED_MODELS : [] };
  }));
  app.get("/desk-phones/managed", guarded(async req => { const who = await actor(req); return { devices: await service().list(who) }; }));
  app.get("/desk-phones/managed/:id", guarded(async req => { const who = await actor(req); return service().detail(who, req.params.id); }));
  app.post("/desk-phones/managed", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, guarded(async req => {
    const who = await actor(req); return service().provision(who, provision.parse(req.body), req.id);
  }));
  app.post("/desk-phones/managed/:id/update", guarded(async req => {
    const who = await actor(req); await service().detail(who, req.params.id);
    return service().update(who, req.params.id, update.parse(req.body), req.id);
  }));
  app.post("/desk-phones/managed/:id/reconcile", guarded(async req => {
    const who = await actor(req); await service().reconcile(who, req.params.id, req.id);
    return service().detail(who, req.params.id);
  }));
  app.post("/desk-phones/managed/:id/release", guarded(async req => { const who = await actor(req); return service().release(who, req.params.id, req.id); }));
  app.post("/desk-phones/managed/:id/remove", guarded(async req => {
    const who = await actor(req); await service().retire(who, req.params.id, req.id); return { removed: true };
  }));
  app.post("/desk-phones/managed/:id/complete-replacement", guarded(async req => {
    const who = await actor(req);
    const body = z.object({ attestedWorking: z.boolean().optional() }).strict().parse(req.body ?? {});
    await service().completeReplacement(who, req.params.id, req.id, body.attestedWorking === true); return { completed: true };
  }));
  app.get("/phone-provisioning/:mac/:filename", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    // A successful response flush is transport evidence, not proof the handset applied it.
    onResponse: async (req: any, reply) => {
      if (reply.statusCode === 200 && req.managedPhoneDelivery && !req.raw.aborted) {
        try { await service().served(req.managedPhoneDelivery, req.id); }
        catch { req.log.warn({ code: "phone_delivery_audit_failed", requestId: req.id }, "Phone delivery tracking failed"); }
      }
    },
  }, guarded(async (req, reply) => {
    if (!enabled()) throw new DeviceError("configuration_not_found", 404);
    // The HTTPS reverse proxy must supply the transport; direct loopback is not
    // a production handset access path. Never accept a browser tenant parameter.
    if (req.protocol !== "https" && req.headers["x-forwarded-proto"] !== "https") throw new DeviceError("https_required", 403);
    reply.header("Cache-Control", "no-store, private").header("Pragma", "no-cache").header("X-Content-Type-Options", "nosniff");
    if (!req.headers.authorization) reply.header("WWW-Authenticate", 'Basic realm="Loopcom phone provisioning"');
    try {
      const result = await service().configuration(req.params.mac, req.params.filename, req.headers.authorization, req.id, handsetSourceIp(req), String(req.headers["user-agent"] || ""));
      if (typeof result === "string") return reply.type("text/plain; charset=utf-8").send(result);
      req.managedPhoneDelivery = { id: result.id, tenantId: result.tenantId, version: result.version };
      return reply.type("text/plain; charset=utf-8").send(result.config);
    } catch (e) {
      if (e instanceof DeviceError && e.status === 401) reply.header("WWW-Authenticate", 'Basic realm="Loopcom phone provisioning"');
      throw e;
    }
  }));
}
