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
import { slugify } from "../onboarding/pbxTenantBuild";
import { resolveMirrorTenantCreator } from "../onboarding/setupOrchestrator";
import {
  consoleDeletePhone, consoleGeoSet, consoleGeoState, consoleRenderPhone, consoleSavePhone,
  resolvePbxRouteHelperConfig,
} from "../pbxInboundRouteHelperClient";
import { syncExtensionsFromPbx } from "../pbxExtensionSync";
import { acquireAccount, releaseAccount } from "../onboarding/setupOrchestrator";
import {
  findConsoleExtension, findConsoleTenant, extensionReferences, listConsoleExtensions, listConsolePhones,
  listConsoleTenants, listProvisioningCatalog, openReadConn, orphanMobileFlagDevices, readConsoleGeo,
  type ConsoleExtensionRow, listOutboundProfiles,} from "./pbxConsoleReaders";
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

  /* A REFUSAL IS NOT A CRASH. The helper answers some requests with "I will not
     do this, and here is why" — the geo rebuild needing root is the standing
     example. Those came back as 500 `pbx_console_write_failed`, which reads to
     the person at the screen as "the app broke" and sends them hunting a bug
     instead of doing the one setup step. A refusal we recognise is a 409 with
     the plain-English sentence as the message, logged at warn rather than
     error so it never pollutes the signal that something is genuinely wrong. */
  const REFUSALS: Array<{ match: string; message: string }> = [
    {
      // raised by the mirror when ombu_tenants.name is taken; reachable when the
      // route's own pre-check could not run because the database read was down
      match: "already exists",
      message:
        "The phone system already has a customer filed under that system name. Pick a different name, or edit the existing one.",
    },
    {
      match: "geo_build_not_permitted",
      message:
        "Blocking a country needs one more setup step on the phone system: rebuilding the firewall runs as root, which the Connect helper is not allowed to do yet. Nothing was changed — the countries you had blocked are still exactly as they were.",
    },
  ];

  const fail = (reply: any, e: any) => {
    const msg = e instanceof PanelStepError ? e.message : e?.message || "the phone system rejected the change";
    const refusal = REFUSALS.find((r) => String(msg).includes(r.match));
    if (refusal) {
      log.warn({ err: msg, step: e?.step }, "[PBX_CONSOLE] refused");
      return reply.status(409).send({ error: "pbx_console_refused", detail: refusal.message, reason: refusal.match });
    }
    log.error({ err: e?.message, step: e?.step }, "[PBX_CONSOLE] write failed");
    return reply.status(e instanceof PanelStepError ? 422 : 500).send({ error: "pbx_console_write_failed", detail: msg });
  };

  const body = <T>(req: any): T => (req.body || {}) as T;

  /* Phone provisioning and geo blocking are the TWO things the unlicensed
     panel refuses (20 phones / 1 country), so they go through the PBX helper,
     which writes the rows and renders with VitalPBX own generator. If the
     helper is not configured we say so plainly rather than falling back to a
     panel path that starts refusing the day the licence ends. */
  const helperCfg = (instance: Instance) => {
    const cfg = resolvePbxRouteHelperConfig(instance.id);
    if (!cfg) throw new PanelStepError("helper", "the PBX helper is not configured for this phone system, so phones and the geo firewall cannot be changed from here");
    return cfg;
  };

  /* ── tenants ───────────────────────────────────────────────────────────── */

  app.get("/admin/pbx-console/tenants", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    /* ⛔ ONE connection for both reads. `withRead` opens and closes a MySQL
       connection per call, and this is the console's most-loaded route — asking
       for the profile list separately would double the connection churn on
       every page load for a list that only the create form uses. */
    const r = await withRead(instance, async (c) => ({
      tenants: await listConsoleTenants(c),
      outboundProfiles: await listOutboundProfiles(c),
    }));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, tenants: r.data.tenants, outboundProfiles: r.data.outboundProfiles };
  });

  /**
   * Create a phone-system tenant.
   *
   * ⛔⛔ THIS IS THE ONE OPERATION THE UNLICENSED PANEL REFUSES OUTRIGHT
   * ("maximum number of free tenants"), which is exactly why it goes through the
   * MIRROR and not the panel form: the mirror writes the same `ombutel` rows the
   * panel would, in ONE transaction, and then renders the baseline itself.
   * ⛔ Rendering is not optional and is not something Apply Changes can do for
   * us: on prod (VitalPBX 4.5.3-1) neither the panel Apply nor the REST
   * per-tenant apply will perform a tenant's FIRST generation — both produced
   * zero files for a row-inserted tenant. Once the baseline exists every later
   * Apply behaves normally, which is why the 27 existing tenants keep working.
   *
   * ⛔ We deliberately do NOT re-implement any of that here. `buildPbxTenant`
   * already owns the mirror path for onboarding, and `resolveMirrorTenantCreator`
   * is its wiring — reusing it means there is exactly ONE tenant-creation
   * implementation. A second one is the failure shape this repo keeps hitting
   * (two IVR publish paths, two SMS ingest paths, two invite paths).
   *
   * What this route does NOT do, on purpose: no trunk, no outbound route, no
   * extensions, no VoIP.ms, no Connect tenant row. It is the panel's "add
   * tenant" button, not onboarding. Everything else is editable afterwards
   * through the ordinary tenant edit, which works unlicensed.
   */
  app.post("/admin/pbx-console/tenants", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ label?: string; slug?: string; dids?: string[]; outboundProfileIds?: Array<number | string> }>(req);
    const label = String(b.label || "").trim();
    if (!label) return reply.status(400).send({ error: "pbx_console_write_failed", detail: "give the customer a name" });
    // ⛔ the SAME slug rule onboarding uses — the PBX name is matched by other
    // code (findPbxDirectoryEntry matches on slug OR displayName), so a second
    // variant here would create tenants those lookups cannot find.
    const slug = slugify(b.slug || label);
    if (!slug) return reply.status(400).send({ error: "pbx_console_write_failed", detail: "that name has no letters or digits in it, so it cannot be turned into a system name" });
    const dids = (b.dids || []).map((d) => String(d).replace(/\D/g, "")).filter(Boolean);
    const arsIds = (b.outboundProfileIds || []).map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0);
    /* ⛔ The mirror door takes ONE profile. Accepting a list and quietly using
       the first would be a setting that looks applied and is not — say so
       instead. A tenant can be given more profiles afterwards through the
       ordinary edit, which posts the panel's own multi-select. */
    if (arsIds.length > 1) {
      return reply.status(400).send({
        error: "pbx_console_write_failed",
        detail: "Pick one outbound profile to start with. You can add the others by editing the customer once it exists.",
      });
    }

    // ⛔ Refuse a duplicate by NAME before writing anything. The mirror raises on
    // it too (the column is unique), but a refusal that names the existing
    // customer is the difference between "already taken" and a stack trace.
    const existing = await withRead(instance, (c) => listConsoleTenants(c));
    if (existing.ok) {
      const clash = existing.data.find((t) => t.name === slug || t.description.trim().toLowerCase() === label.toLowerCase());
      if (clash) {
        return reply.status(409).send({
          error: "pbx_console_refused",
          reason: "tenant_exists",
          detail: `The phone system already has a customer called "${clash.description}" (system name ${clash.name}). Pick a different name, or edit that one.`,
        });
      }
    }

    const creator = resolveMirrorTenantCreator(instance.id);
    if (!creator) {
      return reply.status(409).send({
        error: "pbx_console_refused",
        reason: "mirror_unavailable",
        detail: "Creating a customer needs the Connect helper on the phone system, and it is not reachable right now. Nothing was created.",
      });
    }

    try {
      const made = await creator({ slug, label, dids, arsId: arsIds.length ? String(arsIds[0]) : "" });
      if (!/^[0-9a-f]{16}$/.test(String(made.path || ""))) {
        throw new PanelStepError("tenant", `the phone system did not return a usable tenant path (${JSON.stringify(made)})`);
      }
      /* ⛔⛔ NO SECOND RENDER HERE, AND THAT IS DELIBERATE — it was tried on
         production and it is BOTH redundant and impossible.
         Redundant: onboarding re-renders at the very end because it keeps
         writing rows after the tenant exists (extensions, devices, routes), so
         its baseline is stale by the time it finishes. This route writes NOTHING
         after the create, so the baseline the mirror just rendered is already
         the final state.
         Impossible: the mirror's render hands each file it writes to www-data so
         the panel can keep managing it, and the ACL mask ends up `r--`. The
         helper runs as `asterisk`, so a second render cannot reopen the file it
         just created — proven on prod 2026-08-19, tenant 119:
         `[Errno 13] Permission denied: extensions__50-119-dialplan.conf`, with
         all 13 baseline files present and correct.
         ⛔ Do NOT "fix" that by widening permissions on /etc/asterisk/vitalpbx —
         CLAUDE.md already records a one-off chown and a bare ACL as non-fixes
         there. See the handoff before touching it. */
      const rendered = "baseline";
      await audit({
        actorUserId: admin.sub, action: "PBX_CONSOLE_TENANT_CREATED", entityType: "PbxTenant",
        entityId: String(made.tenantId), metadata: { name: slug, label, dids: dids.length, outboundProfileIds: arsIds },
      });
      return { createdTenantId: made.tenantId, name: slug, label, path: made.path, dids, outboundProfileIds: arsIds, rendered };
    } catch (e) { return fail(reply, e); }
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

  const handleDeleteExtension = async (req: any, reply: any, force: boolean) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const extensionId = Number((req.params as any).id);
    const info = await withRead(instance, async (c) => ({ ext: await findConsoleExtension(c, extensionId), refs: await extensionReferences(c, extensionId), orphans: await orphanMobileFlagDevices(c, extensionId) }));
    if (!info.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: info.reason });
    const { ext, refs, orphans } = info.data;
    if (!ext) return reply.status(404).send({ error: "extension_not_found" });
    if (refs.length && !force) return reply.status(409).send({ error: "extension_in_use", detail: `Extension ${ext.extension} is still used: ${refs.join("; ")}. Remove those first, or confirm to delete anyway.`, references: refs });
    if (orphans.length) return reply.status(409).send({ error: "extension_delete_would_crash", detail: `Extension ${ext.extension} has a device flagged as a mobile client with no mobile record — deleting it crashes the phone system. This needs a manual repair first.`, orphans });
    try {
      const out = await withPanel(instance, async (s) => { await deleteExtension(s, ext.tenantPath, extensionId, ext.extension); return { deletedExtensionId: extensionId }; }, ext.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_EXTENSION_DELETED", entityType: "PbxExtension", entityId: `${ext.tenantId}/${ext.extension}`, metadata: { name: ext.name, forced: force } });
      await syncConnectExtensions(instance, ext.tenantId).catch(() => {});
      return out;
    } catch (e) { return fail(reply, e); }
  };
  app.delete("/admin/pbx-console/extensions/:id", (req: any, reply: any) => handleDeleteExtension(req, reply, String((req.query || {}).force) === "1"));
  // apiDelete carries no body; a force delete (extension still referenced) uses this POST door
  app.post("/admin/pbx-console/extensions/:id/force-delete", (req: any, reply: any) => handleDeleteExtension(req, reply, true));

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

  /* Editing, adding and deleting a provisioned phone all go through the helper:
     the panel refuses these past 20 devices once the licence lapses, and we have
     55. The helper writes the rows and then renders the config with VitalPBX's
     OWN generator, so the file a handset downloads is byte-identical to what the
     panel would have produced. The config is a STATIC file, so every write here
     renders — otherwise the handset silently keeps its old settings. */
  const phoneSaveInput = (req: any) => {
    const b = body<{ mac?: string; pbxTenantId?: number; modelId?: number; templateId?: number | null; description?: string; accounts?: Array<number | null> }>(req);
    if (!b.mac) throw new PanelStepError("phone", "a MAC address is required");
    if (!b.pbxTenantId) throw new PanelStepError("phone", "pick a customer");
    if (!b.modelId) throw new PanelStepError("phone", "pick a phone model");
    return b;
  };

  app.post("/admin/pbx-console/phones", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    try {
      const b = phoneSaveInput(req);
      const out = await consoleSavePhone(helperCfg(instance), {
        mac: String(b.mac), tenantId: Number(b.pbxTenantId), modelId: Number(b.modelId),
        templateId: b.templateId ?? null, description: b.description || "", accounts: b.accounts,
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_CREATED", entityType: "PbxPhone", entityId: String(out.phoneId), metadata: { mac: out.mac, bytes: out.rendered?.bytes } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/admin/pbx-console/phones/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const phoneId = Number((req.params as any).id);
    try {
      const b = phoneSaveInput(req);
      const out = await consoleSavePhone(helperCfg(instance), {
        phoneId, mac: String(b.mac), tenantId: Number(b.pbxTenantId), modelId: Number(b.modelId),
        templateId: b.templateId ?? null, description: b.description || "", accounts: b.accounts,
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_UPDATED", entityType: "PbxPhone", entityId: String(phoneId), metadata: { mac: out.mac, bytes: out.rendered?.bytes } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/phones/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const phoneId = Number((req.params as any).id);
    try {
      const out = await consoleDeletePhone(helperCfg(instance), phoneId);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_DELETED", entityType: "PbxPhone", entityId: String(phoneId), metadata: { mac: out.mac, filesRemoved: out.filesRemoved?.length } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /** Push current settings to a handset without changing anything. */
  app.post("/admin/pbx-console/phones/:id/render", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const phoneId = Number((req.params as any).id);
    const info = await withRead(instance, (c) => listConsolePhones(c).then((ps) => ps.find((p) => p.id === phoneId) || null));
    const phone = info.ok ? info.data : null;
    if (!phone) return reply.status(404).send({ error: "phone_not_found" });
    try {
      const out = await consoleRenderPhone(helperCfg(instance), { mac: phone.mac, tenantId: phone.tenantId });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_PHONE_RENDERED", entityType: "PbxPhone", entityId: String(phoneId), metadata: { mac: phone.mac, bytes: out.rendered?.bytes } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /* ── geo firewall (READ) ───────────────────────────────────────────────── */

  app.get("/admin/pbx-console/geo", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => readConsoleGeo(c));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    let enforcement: any = null;
    try { enforcement = await consoleGeoState(helperCfg(instance)); } catch { /* the helper is optional for the read */ }
    return { available: true, instanceId: instance.id, ...r.data, enforcement };
  });

  /**
   * Block or unblock whole countries. The helper REFUSES when it cannot rebuild
   * the firewall rather than setting a flag it cannot enforce — a console that
   * says "blocked" while the traffic still arrives is worse than one that says
   * it could not do it.
   */
  app.post("/admin/pbx-console/geo", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ block?: string[]; unblock?: string[] }>(req);
    if (!(b.block || []).length && !(b.unblock || []).length) return reply.status(400).send({ error: "nothing_to_change" });
    try {
      const out = await consoleGeoSet(helperCfg(instance), { block: b.block || [], unblock: b.unblock || [] });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_GEO_UPDATED", entityType: "PbxGeoFirewall", entityId: "geo", metadata: { block: b.block, unblock: b.unblock, blockedAfter: out.blockedAfter } });
      return out;
    } catch (e) { return fail(reply, e); }
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
