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
import { loadPanelConfig, PanelSession, PanelStepError, assertSaved, type PanelConfig, type RobotAccount } from "../onboarding/panelClient";
import { loadParsedForm, accessDeniedReason } from "./panelForm";
import { describeForm, parseSchema } from "./panelSchema";
import {
  PANEL_MODULES, isPanelModule, buildPanelEditPairs, summariseEdit, PanelEditError,
  type PanelModuleKey, type PanelEditInput,
} from "./panelFormWrite";
import { createOutboundRoute, createRouteSelection, createTrunk, slugify } from "../onboarding/pbxTenantBuild";
import { setMembersEnabled } from "../billing/serviceInterruption/arsMemberToggle";
import { createQueue, createRingGroup, deleteTeam, type QueueSpec, type RingGroupSpec } from "../pbx/teamBuilder";
import { resolveMirrorTenantCreator } from "../onboarding/setupOrchestrator";
import {
  consoleDeletePhone, consoleGeoSet, consoleGeoState, consoleRenderPhone, consoleSavePhone,
  mirrorEditPbxExtension, resolvePbxRouteHelperConfig,
} from "../pbxInboundRouteHelperClient";
import { syncExtensionsFromPbx } from "../pbxExtensionSync";
import { acquireAccount, releaseAccount } from "../onboarding/setupOrchestrator";
import {
  findConsoleExtension, findConsoleTenant, extensionReferences, listConsoleExtensions, listConsolePhones,
  listConsoleTenants, listProvisioningCatalog, openReadConn, orphanMobileFlagDevices, readConsoleGeo,
  type ConsoleExtensionRow, listOutboundProfiles, listConsoleRouting, listConsoleTeams,} from "./pbxConsoleReaders";
import {
  applyAndRebake, createExtension, deleteExtension, deleteTenant, editOutboundRoute, editQueue, editRingGroup, panelDelete, rebootPhone,
  saveExtension, savePhone, saveTenant, unlinkDevice, MAIN_TENANT_PATH_DEFAULT,
  isExtensionCapRefusal, mapExtensionSaveToMirrorEdit,
  type TeamEditInput,
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
      /* ⛔ PROVEN ON THE COMMUNITY-EDITION CLONE, 2026-08-21, and it corrects a
         claim this repo had recorded as settled ("extension create/edit/delete
         works unlicensed"). Over the free tier's 12-extension cap the panel
         refuses an extension SAVE both ways round: carry the device fields and
         it answers this, because it reads the save as a device add; drop them
         and its own validator crashes on `Undefined array key "user"`. Every
         other console module — tenants, trunks, outbound routes, route
         selections, ring groups, queues — saves cleanly unlicensed.
         Since 2026-08-22 an extension EDIT falls back to the helper's
         /mirror/extension-edit (saveExtensionOrMirror), so this refusal only
         reaches a person when that fallback is unavailable: no helper
         configured for the PBX, or a CREATE (which the mirror never fakes). */
      match: "maximum number of al",
      message:
        "The phone system's free edition will not save an extension while it is over its own 12-extension limit, and the Connect helper that edits around that limit is not reachable on this phone system. Nothing was changed.",
    },
    {
      match: "geo_build_not_permitted",
      message:
        "Blocking a country needs one more setup step on the phone system: rebuilding the firewall runs as root, which the Connect helper is not allowed to do yet. Nothing was changed — the countries you had blocked are still exactly as they were.",
    },
  ];

  const fail = (reply: any, e: any) => {
    const msg = e instanceof PanelStepError ? e.message : e?.message || "the phone system rejected the change";
    /* The mirror fallback's own refusals carry a field-specific plain-English
       sentence, so they answer with their OWN message rather than a fixed one. */
    if (e instanceof PanelStepError && (e.step === "mirror-edit-unsupported" || e.step === "mirror-edit-noop")) {
      log.warn({ err: msg, step: e.step }, "[PBX_CONSOLE] refused");
      return reply.status(409).send({ error: "pbx_console_refused", detail: msg, reason: e.step });
    }
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

  /**
   * Save an extension through the panel; when the free edition's 12-extension
   * cap refuses the save (the ONE console operation the unlicensed panel
   * refuses — clone-proven 2026-08-21), hand the SAME save to the helper's
   * /mirror/extension-edit, which UPDATEs the rows the panel would and splices
   * only that extension's pjsip blocks + voicemail line into the live files.
   * ⛔ The panel goes FIRST, always — while the licence is live nothing here
   * behaves differently, and a test pins that order. A field the mirror cannot
   * honour is refused by name (mapExtensionSaveToMirrorEdit), never dropped.
   */
  const saveExtensionOrMirror = async (
    s: PanelSession, instance: Instance, ext: ConsoleExtensionRow, extId: number, input: ExtensionSaveInput,
  ): Promise<{ posts: number; devicesSaved: number; devicesRemoved: number; viaMirror: boolean }> => {
    try {
      return { ...(await saveExtension(s, ext.tenantPath, extId, input)), viaMirror: false };
    } catch (e) {
      if (!isExtensionCapRefusal(e)) throw e;
      const cfg = resolvePbxRouteHelperConfig(instance.id);
      if (!cfg) throw e; // no helper on this PBX — the honest cap refusal stands
      const mapped = mapExtensionSaveToMirrorEdit(input, ext.devices);
      log.warn({ ext: ext.extension, tenantId: ext.tenantId }, "[PBX_CONSOLE] panel refused the extension save at the licence cap — editing through the mirror");
      const r = await mirrorEditPbxExtension(cfg, { tenantId: ext.tenantId, extension: ext.extension, ...mapped });
      const applyErr = (r.applied as any)?.error;
      if (applyErr) {
        /* The rows ARE updated; saying "saved" while the phone still runs the old
           config would be the static-file trap. Loud, with what to do next. */
        throw new PanelStepError("mirror-edit-apply", `the change was recorded but making it live on the phone system failed (${applyErr}) — save again, or re-render the customer from the console`);
      }
      return { posts: 0, devicesSaved: mapped.devices.length, devicesRemoved: 0, viaMirror: true };
    }
  };

  /* ── the panel form, whole ─────────────────────────────────────────────────
     Every field the phone system's own form offers, for any of the seven
     modules, drawn and saved without this file naming a single one of them.
     A VitalPBX upgrade that adds or renames a field shows up in Connect the
     same day. See panelSchema.ts for why that rule matters. */

  /**
   * ⛔ A READ MUST NOT APPLY. `withPanel` ends in `applyAndRebake`, which is a
   * whole-PBX Apply Changes — merely OPENING a form would regenerate every
   * tenant with pending changes and re-bake the Connect doorway. Opening a
   * form is a GET in the panel and must stay one here.
   */
  const withPanelRead = async <T>(work: (s: PanelSession) => Promise<T>): Promise<T> => {
    const cfg = panelConfig();
    const account: RobotAccount = await acquireAccount(cfg);
    const s = new PanelSession(cfg.baseUrl, account);
    try {
      await s.login();
      return await work(s);
    } finally {
      releaseAccount(account);
    }
  };

  /** Point the session at the right tenant for this module. */
  const scopeSession = (s: PanelSession, mod: PanelModuleKey, tenantPath: string | undefined, mainPath: string): string => {
    const scope = PANEL_MODULES[mod].scope;
    if (scope === "tenant") {
      if (!tenantPath) throw new PanelStepError("scope", `${PANEL_MODULES[mod].label} belong to a customer — pick one first`);
      s.setTenant(tenantPath);
      return tenantPath;
    }
    s.setTenant(mainPath);
    return mainPath;
  };

  /** Draw a record: every tab, every field, every option, as the panel has it. */
  app.get("/admin/pbx-console/panel/:module/form", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const mod = String((req.params || {}).module || "");
    if (!isPanelModule(mod)) return reply.status(404).send({ error: "unknown_module" });
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const q = req.query || {};
    const id = q.id != null && String(q.id) !== "" ? String(q.id) : null;
    const tenantPath = q.tenantPath ? String(q.tenantPath) : undefined;
    try {
      const cfg = panelConfig();
      const out = await withPanelRead(async (s) => {
        scopeSession(s, mod, tenantPath, cfg.mainTenant || MAIN_TENANT_PATH_DEFAULT);
        const { html } = await loadParsedForm(s, PANEL_MODULES[mod].cls, id ? "edit" : "add", id);
        const denied = accessDeniedReason(html);
        if (denied) throw new PanelStepError("panel-access", denied);
        const schema = describeForm(html);
        return {
          module: mod,
          label: PANEL_MODULES[mod].label,
          panelClass: PANEL_MODULES[mod].cls,
          scope: PANEL_MODULES[mod].scope,
          id,
          tabs: schema.tabs,
          values: schema.form.values,
          checks: schema.form.checks,
          multi: schema.form.multi,
        };
      });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /** Save a record by re-posting the panel's own form with the changes applied. */
  app.post("/admin/pbx-console/panel/:module/save", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const mod = String((req.params || {}).module || "");
    if (!isPanelModule(mod)) return reply.status(404).send({ error: "unknown_module" });
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<PanelEditInput & { id?: string | number | null; tenantPath?: string }>(req);
    const id = b.id != null && String(b.id) !== "" ? String(b.id) : null;
    const tenantPath = b.tenantPath ? String(b.tenantPath) : undefined;
    try {
      const cfg = panelConfig();
      const mainPath = cfg.mainTenant || MAIN_TENANT_PATH_DEFAULT;
      /* The apply runs in the tenant whose config actually changed. Applying
         in the robot's own tenant returns success and regenerates nothing. */
      const applyPath = PANEL_MODULES[mod].scope === "tenant" ? tenantPath : mainPath;

      /* ⛔ EXTENSIONS ARE THE ONE MODULE THAT CANNOT TAKE A GENERIC POST, and
         the phone system says so in two different voices depending on what you
         send. Re-post the rendered device fields with the general save and an
         unlicensed panel answers "You've reached the maximum number of allowed
         extensions" (it reads the save as a device ADD); drop them and its own
         validator crashes with `Undefined array key "user"`. Both were seen on
         the Community-edition clone. The save must carry each device's fields
         from THAT DEVICE'S OWN form — which `saveExtension` already does, with
         the dtmf carried from the database so a desk phone is not silently
         flipped to rfc2833. It is proven on production; the generic path hands
         over to it rather than growing a second implementation. */
      if (mod === "extensions") {
        if (!id) return reply.status(400).send({ error: "unsupported", detail: "Creating an extension goes through the Extensions screen, which builds its devices too." });
        const info = await withRead(instance, (c) => findConsoleExtension(c, Number(id)));
        const ext = info.ok ? info.data : null;
        if (!ext) return reply.status(404).send({ error: "extension_not_found" });
        const out = await withPanel(instance, async (s) => {
          const r = await saveExtensionOrMirror(s, instance, ext, Number(id), {
            set: b.set as any, checks: b.checks, multi: b.multi, devices: extToDeviceSpecs(ext),
          });
          return { module: mod, id, saved: true, ...r };
        }, ext.tenantPath);
        await audit({
          actorUserId: admin.sub, action: "PBX_CONSOLE_PANEL_UPDATED", entityType: "PbxPanelRecord",
          entityId: `${mod}:${id}`, metadata: { module: mod, tenantPath: ext.tenantPath, ...summariseEdit(b) },
        });
        await syncConnectExtensions(instance, ext.tenantId).catch(() => {});
        return out;
      }
      const out = await withPanel(instance, async (s) => {
        scopeSession(s, mod, tenantPath, mainPath);
        const cls = PANEL_MODULES[mod].cls;
        const { html, form } = await loadParsedForm(s, cls, id ? "edit" : "add", id);
        const denied = accessDeniedReason(html);
        if (denied) throw new PanelStepError("panel-access", denied);
        const tabs = parseSchema(html);
        const pairs = buildPanelEditPairs(form, tabs, b, { module: mod });
        /* `class`/`method`/`mode`/`csfr_token` come from the form we just
           loaded, never from the request — the schema refuses them by name. */
        assertSaved(`${mod} save`, await s.post(pairs));
        return { module: mod, id, saved: true };
      }, applyPath);
      await audit({
        actorUserId: admin.sub,
        action: id ? "PBX_CONSOLE_PANEL_UPDATED" : "PBX_CONSOLE_PANEL_CREATED",
        entityType: "PbxPanelRecord",
        entityId: `${mod}:${id ?? "new"}`,
        metadata: { module: mod, tenantPath, ...summariseEdit(b) },
      });
      return out;
    } catch (e) {
      if (e instanceof PanelEditError) return reply.status(400).send({ error: e.code, detail: e.message });
      return fail(reply, e);
    }
  });

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
      const out = await withPanel(instance, async (s) => { const r = await saveExtensionOrMirror(s, instance, ext, extensionId, input); return { savedExtensionId: extensionId, ...r }; }, ext.tenantPath);
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

  /* -- trunks / outbound routes / route selection (2026-08-20) -------------
     Izzy: "bring over controlling the outbound routes and trunks from inside
     Connect's UI... keep the robot." Reads are connect_read SELECTs; every
     write reuses a PROVEN implementation - onboarding's createTrunk /
     createOutboundRoute / createRouteSelection, the console's panelDelete,
     the cutoff's setMembersEnabled (the members[N][enabled] checkbox rule
     lives THERE and nowhere else) - and every delete is REFUSED while
     something still references the object, because the panel would cascade
     or strand it (a shared destinations row once nearly killed a live
     number). NO trunk edit, deliberately: the trunk edit form's JS-ticked
     checkboxes read as absent and a re-post breaks registration. */

  app.get("/admin/pbx-console/routing", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => listConsoleRouting(c));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, ...r.data };
  });

  /** Create a registration trunk (the onboarding shape: user/pass/server). */
  app.post("/admin/pbx-console/trunks", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ description?: string; username?: string; password?: string; server?: string }>(req);
    const description = String(b.description || "").trim();
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    const server = String(b.server || "").trim();
    if (!description || !username || !password || !server) {
      return reply.status(400).send({ error: "missing_fields", detail: "a trunk needs a name, a username, a password and a server" });
    }
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        const trunkId = await createTrunk(s, description, { user: username, pass: password, server });
        return { trunkId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_TRUNK_CREATED", entityType: "PbxTrunk", entityId: String(out.trunkId), metadata: { description, username, server } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/trunks/:trunkId", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const trunkId = Number((req.params || {}).trunkId);
    if (!Number.isFinite(trunkId)) return reply.status(400).send({ error: "bad_trunk_id" });
    // Refuse while any outbound route still lists it - deleting a member
    // trunk out from under a route leaves customers' calls with a dead leg.
    const r = await withRead(instance, (c) => listConsoleRouting(c));
    if (!r.ok) return reply.status(503).send({ error: "pbx_unavailable", detail: r.reason });
    const trunk = r.data.trunks.find((t) => t.id === trunkId);
    if (!trunk) return reply.status(404).send({ error: "trunk_not_found" });
    if (trunk.usedByRoutes.length) {
      return reply.status(409).send({ error: "trunk_in_use", detail: "This trunk is inside " + trunk.usedByRoutes.map((x) => '"' + x.description + '"').join(", ") + " - take it out of those outbound routes first. Nothing was deleted." });
    }
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        await panelDelete(s, "trunks", trunkId, "trunk " + trunk.description);
        return { deleted: trunkId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_TRUNK_DELETED", entityType: "PbxTrunk", entityId: String(trunkId), metadata: { description: trunk.description } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /** Create an outbound route. trunkIds is the DIAL ORDER (primary first). */
  app.post("/admin/pbx-console/outbound-routes", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ description?: string; cidName?: string; cidNumber?: string; trunkIds?: Array<string | number> }>(req);
    const description = String(b.description || "").trim();
    const cidNumber = String(b.cidNumber || "").replace(/\D/g, "");
    const trunkIds = (b.trunkIds || []).map((x) => String(x)).filter(Boolean);
    if (!description || !trunkIds.length) return reply.status(400).send({ error: "missing_fields", detail: "an outbound route needs a name and at least one trunk" });
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        const routeId = await createOutboundRoute(s, description, String(b.cidName || description), cidNumber, trunkIds);
        return { routeId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ROUTE_CREATED", entityType: "PbxOutboundRoute", entityId: String(out.routeId), metadata: { description, trunkIds } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/admin/pbx-console/outbound-routes/:routeId", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const routeId = Number((req.params || {}).routeId);
    if (!Number.isFinite(routeId)) return reply.status(400).send({ error: "bad_route_id" });
    const b = body<{ trunkIds?: Array<string | number>; cidName?: string; cidNumber?: string; description?: string }>(req);
    const trunkIds = b.trunkIds ? b.trunkIds.map((x) => String(x)).filter(Boolean) : undefined;
    if (trunkIds && !trunkIds.length) return reply.status(400).send({ error: "missing_fields", detail: "an outbound route needs at least one trunk" });
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        await editOutboundRoute(s, mainPath, routeId, { trunkIds, cidName: b.cidName, cidNumber: b.cidNumber, description: b.description });
        return { routeId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ROUTE_UPDATED", entityType: "PbxOutboundRoute", entityId: String(routeId), metadata: { trunkIds, cidName: b.cidName, cidNumber: b.cidNumber } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/outbound-routes/:routeId", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const routeId = Number((req.params || {}).routeId);
    if (!Number.isFinite(routeId)) return reply.status(400).send({ error: "bad_route_id" });
    const r = await withRead(instance, (c) => listConsoleRouting(c));
    if (!r.ok) return reply.status(503).send({ error: "pbx_unavailable", detail: r.reason });
    const route = r.data.routes.find((x) => x.id === routeId);
    if (!route) return reply.status(404).send({ error: "route_not_found" });
    if (route.usedByArs.length) {
      return reply.status(409).send({ error: "route_in_use", detail: "This route is inside " + route.usedByArs.map((x) => '"' + x.description + '"').join(", ") + " - take it out of those route selections first. Nothing was deleted." });
    }
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        await panelDelete(s, "trunk_group", routeId, "outbound route " + route.description);
        return { deleted: routeId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ROUTE_DELETED", entityType: "PbxOutboundRoute", entityId: String(routeId), metadata: { description: route.description } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /** Create a route selection pointing at one outbound route. */
  app.post("/admin/pbx-console/route-selections", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ description?: string; outboundRouteId?: string | number }>(req);
    const description = String(b.description || "").trim();
    const routeId = String(b.outboundRouteId || "").trim();
    if (!description || !routeId) return reply.status(400).send({ error: "missing_fields", detail: "a route selection needs a name and an outbound route" });
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        const arsId = await createRouteSelection(s, description, routeId);
        return { arsId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ARS_CREATED", entityType: "PbxRouteSelection", entityId: String(out.arsId), metadata: { description, routeId } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /** Enable/disable members of a route selection. Reuses the cutoff's
      setMembersEnabled - the ONE place the members[N][enabled] checkbox rule
      (omit to disable; "=0" ENABLES) is implemented, with its full-replace
      guards. Never reimplement it here. */
  app.patch("/admin/pbx-console/route-selections/:arsId/members", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const arsId = String((req.params || {}).arsId || "");
    const b = body<{ outboundRouteIds?: Array<string | number>; enabled?: boolean }>(req);
    const ids = (b.outboundRouteIds || []).map((x) => String(x)).filter(Boolean);
    if (!ids.length || typeof b.enabled !== "boolean") return reply.status(400).send({ error: "missing_fields", detail: "pick the outbound routes and whether to enable or disable them" });
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        const changed = await setMembersEnabled(s, { mainTenantPath: mainPath, arsId, outboundRouteIds: ids, enabled: b.enabled! });
        return { arsId, changed };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ARS_MEMBERS_UPDATED", entityType: "PbxRouteSelection", entityId: arsId, metadata: { outboundRouteIds: ids, enabled: b.enabled } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/route-selections/:arsId", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const arsId = Number((req.params || {}).arsId);
    if (!Number.isFinite(arsId)) return reply.status(400).send({ error: "bad_ars_id" });
    const r = await withRead(instance, (c) => listConsoleRouting(c));
    if (!r.ok) return reply.status(503).send({ error: "pbx_unavailable", detail: r.reason });
    const row = r.data.ars.find((x) => x.id === arsId);
    if (!row) return reply.status(404).send({ error: "route_selection_not_found" });
    if (row.usedByTenants.length) {
      return reply.status(409).send({ error: "route_selection_in_use", detail: row.usedByTenants.join(", ") + (row.usedByTenants.length === 1 ? " still points" : " still point") + " at this route selection - move " + (row.usedByTenants.length === 1 ? "it" : "them") + " to another one first. Nothing was deleted." });
    }
    try {
      const out = await withPanel(instance, async (s, mainPath) => {
        s.setTenant(mainPath);
        await panelDelete(s, "ars", arsId, "route selection " + (row.description || ("#" + arsId)));
        return { deleted: arsId };
      });
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_ARS_DELETED", entityType: "PbxRouteSelection", entityId: String(arsId), metadata: { description: row.description } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  /* -- ring groups & queues (2026-08-20) ------------------------------------
     Izzy: "a copy of how we set it up in the PBX: every option... completely
     wired." Creates reuse teamBuilder's browser-captured replay (the same code
     the /queues page and the IVR Studio already drive); edits load the panel's
     own form and re-post it, so EVERY option rides along; deletes reuse
     deleteTeam's two-step dance and are REFUSED while anything points at the
     team through ombu_destinations (an IVR key or inbound route whose
     destination row would cascade away with it). Unlike the Studio flow
     (where Apply is Izzy's click), the console IS the panel replacement, so
     every write here applies + re-bakes, same as its other modules. */

  const findTeam = async (instance: Instance, kind: "ringGroups" | "queues", id: number) => {
    const r = await withRead(instance, (c) => listConsoleTeams(c));
    if (!r.ok) return { err: { status: 503, body: { error: "pbx_unavailable", detail: r.reason } } as const };
    const row = r.data[kind].find((x) => x.id === id);
    if (!row) return { err: { status: 404, body: { error: kind === "queues" ? "queue_not_found" : "ring_group_not_found" } } as const };
    return { row, data: r.data };
  };

  app.get("/admin/pbx-console/teams", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const r = await withRead(instance, (c) => listConsoleTeams(c));
    if (!r.ok) return reply.status(200).send({ available: false, reason: "pbx_unavailable", detail: r.reason });
    return { available: true, instanceId: instance.id, ...r.data };
  });

  app.post("/admin/pbx-console/ring-groups", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ pbxTenantId?: number; spec?: Partial<RingGroupSpec> & { members?: Array<{ extensionId: string | number }> } }>(req);
    const tenantId = Number(b.pbxTenantId);
    const spec = b.spec || {};
    if (!Number.isFinite(tenantId) || !String(spec.name || "").trim() || !(spec.members || []).length) {
      return reply.status(400).send({ error: "missing_fields", detail: "a ring group needs a customer, a name and at least one member" });
    }
    const teams = await withRead(instance, (c) => listConsoleTeams(c));
    if (!teams.ok) return reply.status(503).send({ error: "pbx_unavailable", detail: teams.reason });
    const tenant = teams.data.tenants.find((t) => t.tenantId === tenantId);
    if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });
    try {
      const out = await withPanel(instance, async (s) => {
        s.setTenant(tenant.path);
        return await createRingGroup(s, {
          name: String(spec.name).trim(), prefix: spec.prefix, strategy: (spec.strategy as any) || "ringall",
          members: (spec.members || []).map((m: any) => ({ extensionId: String(m.extensionId) })),
          ringTime: spec.ringTime, number: spec.number, musicGroupId: spec.musicGroupId, announcementId: spec.announcementId,
          lastDestination: spec.lastDestination,
        }, tenant.usedNumbers);
      }, tenant.path);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_RING_GROUP_CREATED", entityType: "PbxRingGroup", entityId: String(out.number), metadata: { tenantId, name: spec.name } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/admin/pbx-console/ring-groups/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const id = Number((req.params || {}).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: "bad_id" });
    const found = await findTeam(instance, "ringGroups", id);
    if ("err" in found && found.err) return reply.status(found.err.status).send(found.err.body);
    const b = body<TeamEditInput>(req);
    try {
      const out = await withPanel(instance, async (s) => {
        await editRingGroup(s, found.row!.tenantPath, id, { set: b.set, checks: b.checks, rgMembers: b.rgMembers });
        return { ringGroupId: id };
      }, found.row!.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_RING_GROUP_UPDATED", entityType: "PbxRingGroup", entityId: String(id), metadata: { set: b.set, checks: b.checks, members: b.rgMembers } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/ring-groups/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const id = Number((req.params || {}).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: "bad_id" });
    const found = await findTeam(instance, "ringGroups", id);
    if ("err" in found && found.err) return reply.status(found.err.status).send(found.err.body);
    if (found.row!.referencedBy.length) {
      return reply.status(409).send({ error: "ring_group_in_use", detail: `Ring group ${found.row!.extension} is ${found.row!.referencedBy.join("; ")} - point those somewhere else first. Nothing was deleted.` });
    }
    try {
      const out = await withPanel(instance, async (s) => {
        s.setTenant(found.row!.tenantPath);
        await deleteTeam(s, "ring_group", String(id));
        return { deleted: id };
      }, found.row!.tenantPath);
      const still = await withRead(instance, (c) => listConsoleTeams(c));
      if (still.ok && still.data.ringGroups.some((x) => x.id === id)) {
        return reply.status(500).send({ error: "delete_not_confirmed", detail: "the phone system still lists this ring group after the delete" });
      }
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_RING_GROUP_DELETED", entityType: "PbxRingGroup", entityId: String(id), metadata: { extension: found.row!.extension, name: found.row!.description } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.post("/admin/pbx-console/queues", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const b = body<{ pbxTenantId?: number; spec?: Partial<QueueSpec> & { members?: Array<{ extensionId: string | number; penalty?: number }> } }>(req);
    const tenantId = Number(b.pbxTenantId);
    const spec = b.spec || {};
    if (!Number.isFinite(tenantId) || !String(spec.name || "").trim() || !(spec.members || []).length) {
      return reply.status(400).send({ error: "missing_fields", detail: "a queue needs a customer, a name and at least one agent" });
    }
    if (!spec.lastDestination?.categoryId || !spec.lastDestination?.targetId) {
      // the panel refuses a queue with no last destination at the very end of
      // the form - refuse up front instead (proven on a real create, 2c7657f3)
      return reply.status(400).send({ error: "missing_fields", detail: "a queue needs a last destination - where callers go when the queue gives up" });
    }
    const teams = await withRead(instance, (c) => listConsoleTeams(c));
    if (!teams.ok) return reply.status(503).send({ error: "pbx_unavailable", detail: teams.reason });
    const tenant = teams.data.tenants.find((t) => t.tenantId === tenantId);
    if (!tenant) return reply.status(404).send({ error: "tenant_not_found" });
    try {
      const out = await withPanel(instance, async (s) => {
        s.setTenant(tenant.path);
        return await createQueue(s, {
          ...spec, name: String(spec.name).trim(),
          members: (spec.members || []).map((m: any) => ({ extensionId: String(m.extensionId), penalty: m.penalty })),
        } as QueueSpec, tenant.usedNumbers);
      }, tenant.path);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_QUEUE_CREATED", entityType: "PbxQueue", entityId: String(out.number), metadata: { tenantId, name: spec.name } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.patch("/admin/pbx-console/queues/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const id = Number((req.params || {}).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: "bad_id" });
    const found = await findTeam(instance, "queues", id);
    if ("err" in found && found.err) return reply.status(found.err.status).send(found.err.body);
    const b = body<TeamEditInput>(req);
    try {
      const out = await withPanel(instance, async (s) => {
        await editQueue(s, found.row!.tenantPath, id, { set: b.set, checks: b.checks, queueMembers: b.queueMembers });
        return { queueId: id };
      }, found.row!.tenantPath);
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_QUEUE_UPDATED", entityType: "PbxQueue", entityId: String(id), metadata: { set: b.set, checks: b.checks, members: b.queueMembers } });
      return out;
    } catch (e) { return fail(reply, e); }
  });

  app.delete("/admin/pbx-console/queues/:id", async (req: any, reply: any) => {
    const admin = await requireOwner(req, reply); if (!admin) return;
    const instance = await resolveInstance((req.query || {}).instanceId);
    if (!instance) return reply.status(404).send({ error: "PBX_INSTANCE_NOT_FOUND" });
    const id = Number((req.params || {}).id);
    if (!Number.isFinite(id)) return reply.status(400).send({ error: "bad_id" });
    const found = await findTeam(instance, "queues", id);
    if ("err" in found && found.err) return reply.status(found.err.status).send(found.err.body);
    if (found.row!.referencedBy.length) {
      return reply.status(409).send({ error: "queue_in_use", detail: `Queue ${found.row!.extension} is ${found.row!.referencedBy.join("; ")} - point those somewhere else first. Nothing was deleted.` });
    }
    try {
      const out = await withPanel(instance, async (s) => {
        s.setTenant(found.row!.tenantPath);
        await deleteTeam(s, "queue", String(id));
        return { deleted: id };
      }, found.row!.tenantPath);
      const still = await withRead(instance, (c) => listConsoleTeams(c));
      if (still.ok && still.data.queues.some((x) => x.id === id)) {
        return reply.status(500).send({ error: "delete_not_confirmed", detail: "the phone system still lists this queue after the delete" });
      }
      await audit({ actorUserId: admin.sub, action: "PBX_CONSOLE_QUEUE_DELETED", entityType: "PbxQueue", entityId: String(id), metadata: { extension: found.row!.extension, name: found.row!.description } });
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
