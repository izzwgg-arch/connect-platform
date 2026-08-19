/**
 * PBX Console — SUPER_ADMIN routes that replace the VitalPBX panel for tenants,
 * extensions, phone provisioning and the geo firewall. Reads come from the
 * read-only `connect_read` MySQL user; writes replay the panel through a robot
 * session (`PanelSession`), one build per robot account, always followed by the
 * doorway re-bake.
 *
 * ⛔ Every route is SUPER_ADMIN only (owner), gated twice: the global
 * `PORTAL_API_PERMISSION_RULES` entry AND `requireOwner` in each handler.
 * ⛔ Nothing here is tenant-scoped by a customer — it is the platform console.
 */
import { loadPanelConfig, PanelSession, PanelStepError, type PanelConfig, type RobotAccount } from "../onboarding/panelClient";
import { syncExtensionsFromPbx } from "../pbxExtensionSync";
import { acquireAccount, releaseAccount } from "../onboarding/setupOrchestrator";
import {
  findConsoleExtension, findConsoleTenant, extensionReferences, listConsoleExtensions, listConsolePhones,
  listConsoleTenants, listProvisioningCatalog, openReadConn, orphanMobileFlagDevices, readConsoleGeo,
  type ConsoleExtensionRow,
} from "./pbxConsoleReaders";
import {
  applyAndRebake, createExtension, deleteExtension, deleteTenant, rebootPhone,
  saveExtension, savePhone, saveTenant, unlinkDevice, MAIN_TENANT_PATH_DEFAULT,
  type DeviceSpec, type ExtensionCreateInput, type ExtensionSaveInput,
} from "./pbxConsoleWrites";

export interface PbxConsoleDeps {
  app: any;
  db: any;
  decryptJson: <T>(s: string) => T;
  requireOwner: (req: any, reply: any) => Promise<any | undefined>;
  audit: (e: { tenantId?: string | null; actorUserId?: string | null; action: string; entityType?: string; entityId?: string; metadata?: any }) => Promise<void> | void;
  log: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };
  /** Injected from server.ts so this module never imports it (no import cycle). */
  getVitalPbxClient: (cfg: { baseUrl?: string; token?: string; secret?: string; timeoutMs?: number }) => any;
}

type Instance = { id: string; baseUrl: string; apiAuthEncrypted: string; ombuMysqlUrlEncrypted: string | null };

export function registerPbxConsoleRoutes(deps: PbxConsoleDeps): void {
  const { app, db, requireOwner, audit, log } = deps;

  const resolveInstance = async (instanceId?: string | null): Promise<Instance | null> =>
    instanceId
      ? db.pbxInstance.findUnique({ where: { id: instanceId } })
      : db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { updatedAt: "desc" } });

  const withRead = async <T>(instance: Instance, fn: (conn: any) => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; reason: string }> => {
    const c = await openReadConn(instance.ombuMysqlUrlEncrypted);
    if (!c.ok) return { ok: false, reason: c.reason };
    try { return { ok: true, data: await fn(c.conn) }; } finally { await c.conn.end().catch(() => {}); }
  };

  const panelConfig = (): PanelConfig => {
    const cfg = loadPanelConfig();
    if (!cfg) throw new PanelStepError("panel-config", "the PBX panel automation is not configured on this server");
    return cfg;
  };

  /** Run a panel write on a serialized robot session, then apply + re-bake. */
  const withPanel = async (instance: Instance, work: (s: PanelSession, mainPath: string) => Promise<any>, applyTenantPath?: string): Promise<any> => {
    const cfg = panelConfig();
    const account: RobotAccount = await acquireAccount(cfg);
    const s = new PanelSession(cfg.baseUrl, account);
    try {
      await s.login();
      const result = await work(s, cfg.mainTenant || MAIN_TENANT_PATH_DEFAULT);
      const applyResult = await applyAndRebake(s, applyTenantPath || cfg.mainTenant || MAIN_TENANT_PATH_DEFAULT, { db, log, pbxInstanceId: instance.id });
      return { ...result, apply: applyResult };
    } finally {
      releaseAccount(account);
    }
  };

  const fail = (reply: any, e: any) => {
    const msg = e instanceof PanelStepError ? e.message : e?.message || "the phone system rejected the change";
    log.error({ err: e?.message, step: e?.step }, "[PBX_CONSOLE] write failed");
    return reply.status(e instanceof PanelStepError ? 422 : 500).send({ error: "pbx_console_write_failed", detail: msg });
  };

  const body = <T>(req: any): T => (req.body || {}) as T;

  /* ── tenants ───────────────────────────────────────────────────────────── */

  app.get("/admin/pbx-console/tenants", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => listConsoleTenants(c));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, tenants: r.data };
  });

  app.patch("/admin/pbx-console/tenants/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const tenantId = Number((req.params as any).id);
    const input = body<{ set?: Record<string, string>; multi?: Record<string, string[]>; checks?: Record<string, boolean>; inboundNumbers?: Array<{ did: string; description: string }> }>(req);
    try {
      const info = await withRead(instance, (c) => findConsoleTenant(c, tenantId));
      const t = info.ok ? info.data : null;
      if (!t) return reply.status(404).send({ error: "tenant_not_found" });
      const out = await withPanel(instance, async (s, mainPath) => { await saveTenant(s, mainPath, tenantId, input); return { savedTenantId: tenantId }; });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_TENANT_UPDATED", entityType: "PbxTenant", entityId: String(tenantId), metadata: { fields: Object.keys(input.set || {}), inbound: !!input.inboundNumbers } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/tenants/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const tenantId = Number((req.params as any).id);
    const info = await withRead(instance, (c) => findConsoleTenant(c, tenantId));
    const t = info.ok ? info.data : null;
    if (!t) return reply.status(404).send({ error: "tenant_not_found" });
    if (t.isMain) return reply.status(422).send({ error: "pbx_console_write_failed", detail: "the Main tenant cannot be deleted" });
    try {
      const out = await withPanel(instance, async (s, mainPath) => { await deleteTenant(s, mainPath, tenantId, t.description); return { deletedTenantId: tenantId }; });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_TENANT_DELETED", entityType: "PbxTenant", entityId: String(tenantId), metadata: { name: t.description } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /* ── extensions ────────────────────────────────────────────────────────── */

  app.get("/admin/pbx-console/extensions", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const q = (req.query || {}) as { instanceId?: string; tenantId?: string };
    const instance = await resolveInstance(q.instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => listConsoleExtensions(c, { tenantId: q.tenantId ? Number(q.tenantId) : null }));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, extensions: r.data };
  });

  app.post("/admin/pbx-console/extensions", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const input = body<ExtensionCreateInput & { pbxTenantId: number }>(req);
    if (!input.pbxTenantId) return reply.status(400).send({ error: "pbx_tenant_id_required" });
    const info = await withRead(instance, (c) => findConsoleTenant(c, Number(input.pbxTenantId)));
    const t = info.ok ? info.data : null;
    if (!t) return reply.status(404).send({ error: "tenant_not_found" });
    try {
      const out = await withPanel(instance, async (s) => {
        const made = await createExtension(s, t.path, input, undefined, (m) => log.info({ ext: input.extension }, m));
        return { extensionId: made.extensionId };
      }, t.path);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_EXTENSION_CREATED", entityType: "PbxExtension", entityId: `${t.tenantId}/${input.extension}`, metadata: { name: input.name, devices: (input.devices || []).map((d) => d.kind) } });
      await syncConnectExtensions(instance, t.tenantId).catch(() => {});
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/admin/pbx-console/extensions/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const extensionId = Number((req.params as any).id);
    const input = body<ExtensionSaveInput>(req);
    const info = await withRead(instance, (c) => findConsoleExtension(c, extensionId));
    const ext = info.ok ? info.data : null;
    if (!ext) return reply.status(404).send({ error: "extension_not_found" });
    // callers who omit devices get the current device set carried, with each device's DB dtmf
    if (!input.devices) input.devices = extToDeviceSpecs(ext);
    try {
      const out = await withPanel(instance, async (s) => { const r = await saveExtension(s, ext.tenantPath, extensionId, input); return { savedExtensionId: extensionId, ...r }; }, ext.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_EXTENSION_UPDATED", entityType: "PbxExtension", entityId: `${ext.tenantId}/${ext.extension}`, metadata: { fields: Object.keys(input.set || {}) } });
      await syncConnectExtensions(instance, ext.tenantId).catch(() => {});
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/extensions/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const extensionId = Number((req.params as any).id);
    const info = await withRead(instance, async (c) => ({ ext: await findConsoleExtension(c, extensionId), refs: await extensionReferences(c, extensionId), orphans: await orphanMobileFlagDevices(c, extensionId) }));
    if (!info.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: info.reason });
    const { ext, refs, orphans } = info.data;
    if (!ext) return reply.status(404).send({ error: "extension_not_found" });
    const force = !!body<{ force?: boolean }>(req).force;
    if (refs.length && !force) return reply.status(409).send({ error: "extension_in_use", detail: `Extension ${ext.extension} is still used: ${refs.join("; ")}. Remove those first, or confirm to delete anyway.`, references: refs });
    if (orphans.length) return reply.status(409).send({ error: "extension_delete_would_crash", detail: `Extension ${ext.extension} has a device flagged as a mobile client with no mobile record — deleting it crashes the phone system. This needs a manual repair first.`, orphans });
    try {
      const out = await withPanel(instance, async (s) => { await deleteExtension(s, ext.tenantPath, extensionId, ext.extension); return { deletedExtensionId: extensionId }; }, ext.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_EXTENSION_DELETED", entityType: "PbxExtension", entityId: `${ext.tenantId}/${ext.extension}`, metadata: { name: ext.name } });
      await syncConnectExtensions(instance, ext.tenantId).catch(() => {});
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.post("/admin/pbx-console/extensions/:id/devices/:deviceId/unlink", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const extensionId = Number((req.params as any).id), deviceId = Number((req.params as any).deviceId);
    const info = await withRead(instance, (c) => findConsoleExtension(c, extensionId));
    const ext = info.ok ? info.data : null;
    if (!ext) return reply.status(404).send({ error: "extension_not_found" });
    if (ext.devices.length <= 1) return reply.status(422).send({ error: "pbx_console_write_failed", detail: "an extension needs at least one device" });
    try {
      const out = await withPanel(instance, async (s) => { s.setTenant(ext.tenantPath); await unlinkDevice(s, extensionId, deviceId); return { unlinkedDeviceId: deviceId }; }, ext.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_DEVICE_UNLINKED", entityType: "PbxExtension", entityId: `${ext.tenantId}/${ext.extension}`, metadata: { deviceId } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /* ── phone provisioning ────────────────────────────────────────────────── */

  app.get("/admin/pbx-console/phones", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const q = (req.query || {}) as { instanceId?: string; tenantId?: string };
    const instance = await resolveInstance(q.instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, async (c) => ({ phones: await listConsolePhones(c, { tenantId: q.tenantId ? Number(q.tenantId) : null }), catalog: await listProvisioningCatalog(c) }));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, ...r.data };
  });

  app.post("/admin/pbx-console/phones/:id/resync", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const phoneId = Number((req.params as any).id);
    const info = await withRead(instance, (c) => listConsolePhones(c).then((ps) => ps.find((p) => p.id === phoneId) || null));
    const phone = info.ok ? info.data : null;
    if (!phone) return reply.status(404).send({ error: "phone_not_found" });
    try {
      const cfg = panelConfig(); const account = await acquireAccount(cfg); const s = new PanelSession(cfg.baseUrl, account);
      try { await s.login(); await rebootPhone(s, phone.tenantPath, phoneId); } finally { releaseAccount(account); }
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_RESYNC", entityType: "PbxPhone", entityId: String(phoneId), metadata: { mac: phone.mac } });
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  // Editing/adding a provisioned phone goes through the panel, which is capped at
  // 20 devices once the licence lapses. While licensed it works; unlicensed and
  // over the cap it is refused — the handler surfaces that verbatim.
  app.patch("/admin/pbx-console/phones/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const phoneId = Number((req.params as any).id);
    const info = await withRead(instance, (c) => listConsolePhones(c).then((ps) => ps.find((p) => p.id === phoneId) || null));
    const phone = info.ok ? info.data : null;
    if (!phone) return reply.status(404).send({ error: "phone_not_found" });
    const input = body<{ mac?: string; description?: string; brandId?: string; modelId?: string; templateId?: string; lines?: Record<string, string>; set?: Record<string, string>; checks?: Record<string, boolean> }>(req);
    try {
      const cfg = panelConfig(); const account = await acquireAccount(cfg); const s = new PanelSession(cfg.baseUrl, account);
      try { await s.login(); await savePhone(s, phone.tenantPath, phoneId, input); } finally { releaseAccount(account); }
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_UPDATED", entityType: "PbxPhone", entityId: String(phoneId), metadata: { fields: Object.keys(input) } });
      return { ok: true };
    } catch (e) { return fail(reply, e); }
  });

  /* ── geo firewall (READ) ───────────────────────────────────────────────── */

  app.get("/admin/pbx-console/geo", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => readConsoleGeo(c));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, ...r.data };
  });

  /** After a panel extension write, pull the change into Connect's own tables. */
  async function syncConnectExtensions(instance: Instance, pbxTenantId: number): Promise<void> {
    try {
      const auth = deps.decryptJson<{ token: string; secret?: string }>(instance.apiAuthEncrypted);
      const client = deps.getVitalPbxClient({ baseUrl: instance.baseUrl, token: auth.token, secret: auth.secret, timeoutMs: 60000 });
      await syncExtensionsFromPbx(db, instance.id, client, { vitalTenantId: String(pbxTenantId) });
    } catch (e: any) {
      log.warn({ err: e?.message, pbxTenantId }, "[PBX_CONSOLE] connect extension sync after write failed (non-fatal)");
    }
  }
}

function extToDeviceSpecs(ext: ConsoleExtensionRow): DeviceSpec[] {
  return ext.devices.map((d) => ({
    id: d.deviceId,
    kind: d.technology === "virtual" ? "virtual" : d.isWebrtc ? "webrtc" : d.technology === "iax2" ? "iax" : "pjsip",
    dtmf: d.dtmf || undefined,
    number: d.number || undefined,
  }));
}
