/**
 * Conference rooms — the /voice/conferences surface.
 *
 * Reads come from the Ombutel MariaDB (pbxConferenceDirectory.ts, the
 * `connect_read` grant); writes replay the VitalPBX panel's own Conferences
 * form (conferenceBuilder.ts). The route adds the safety a customer-facing
 * button needs, on the teamRoutes.ts model:
 *
 *   • The room number is allocated from the live picture of what's in use
 *     (extensions + ring groups + queues from the flow map, PLUS the existing
 *     conference rooms, which live in their own table). If the PBX can't be
 *     read we refuse — guessing could hand out a number that already rings.
 *   • The panel row id for edit/delete is resolved server-side from the room
 *     number via the live table, never taken from the client.
 *   • Every write is verified against ombu_conferences afterwards — a panel
 *     "success" notification alone is not proof (the two-step-delete lesson).
 *   • ⛔ Apply Changes: a saved room is NOT live until the PBX applies. The
 *     routes accept `applyNow` from a SUPER_ADMIN only, and then go through
 *     pbxConsole's applyAndRebake — Apply is whole-PBX and wipes the Connect
 *     doorway bake, so the re-bake sweep is not optional. For everyone else
 *     the response says plainly that the room goes live at the next apply.
 */

import { z } from "zod";
import { PanelSession, loadPanelConfig } from "../onboarding/panelClient";
import { applyAndRebake } from "../pbxConsole/pbxConsoleWrites";
import { createConference, deleteConference, updateConference } from "./conferenceBuilder";
import { listConferencesFromOmbutel, type ConferenceConfigRow } from "../pbxConferenceDirectory";
import { nextConferenceNumber, type UsedNumbers } from "@connect/shared";

export interface ConferenceRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces can_view_conferences, or replies. */
  requireConferenceViewer: (req: any, reply: any) => Promise<any | undefined>;
  /** Resolves the caller and enforces can_manage_conferences, or replies. */
  requireConferenceManager: (req: any, reply: any) => Promise<any | undefined>;
  /** Whether this caller may see admin/host PINs and use applyNow-adjacent detail. */
  userMayManage: (user: any) => Promise<boolean>;
  /** SUPER_ADMIN check — the only role whose `applyNow` fires Apply Changes. */
  isSuperAdmin: (user: any) => boolean;
  assertIvrTenantAccess: (user: any, tenantId: string) => void;
  resolveConnectTenantIdFromScope: (scope: string) => Promise<string | null>;
  /**
   * The queue feature's tenant resolver (Connect tenant OR super-admin
   * `vpbx:<slug>` override → vitalTenantId + PbxInstance). Shared so the two
   * screens can never disagree about whose PBX they are looking at.
   */
  resolvePbxTenantContext: (
    req: any,
    user: any,
  ) => Promise<
    | { ok: true; vitalTenantId: string; pbxInstance: { id: string; ombuMysqlUrlEncrypted: string | null } }
    | { ok: false; status: number; body: Record<string, unknown> }
  >;
  /** Live directory + used numbers, or null when the PBX can't be read. */
  readTeamDirectory: (
    pbxTenantId: string,
    pbxInstanceId: string | null,
  ) => Promise<{
    used: UsedNumbers;
    extensions: { id: number; number: string; name: string }[];
    tenantPath: string | null;
  } | null>;
}

const PIN = z.string().regex(/^\d{3,10}$/, "a PIN is 3–10 digits");

const CREATE_BODY = z.object({
  tenantId: z.string().optional(),
  name: z.string().min(1).max(60),
  /** Omit to auto-allocate from the 700-series. */
  extension: z.string().regex(/^\d{3,6}$/).optional(),
  userPin: PIN.optional(),
  adminPin: PIN.optional(),
  maxMembers: z.number().int().min(0).max(500).optional(),
  recordConference: z.boolean().optional(),
  startMuted: z.boolean().optional(),
  quiet: z.boolean().optional(),
  announceUserCount: z.boolean().optional(),
  announceJoinLeave: z.boolean().optional(),
  musicOnHoldWhenEmpty: z.boolean().optional(),
  waitForAdmin: z.boolean().optional(),
  endWhenAdminLeaves: z.boolean().optional(),
  /** SUPER_ADMIN only — anyone else's flag is ignored, never an error. */
  applyNow: z.boolean().optional(),
});

const EDIT_BODY = z.object({
  tenantId: z.string().optional(),
  name: z.string().min(1).max(60).optional(),
  /** null clears the PIN (open room); undefined leaves it untouched. */
  userPin: PIN.nullable().optional(),
  adminPin: PIN.nullable().optional(),
  maxMembers: z.number().int().min(0).max(500).nullable().optional(),
  recordConference: z.boolean().optional(),
  startMuted: z.boolean().optional(),
  quiet: z.boolean().optional(),
  announceUserCount: z.boolean().optional(),
  announceJoinLeave: z.boolean().optional(),
  musicOnHoldWhenEmpty: z.boolean().optional(),
  waitForAdmin: z.boolean().optional(),
  endWhenAdminLeaves: z.boolean().optional(),
  applyNow: z.boolean().optional(),
});

const PENDING_APPLY_NOTE = "It goes live the next time changes are applied to the phone system.";

function maskForViewer(row: ConferenceConfigRow, mayManage: boolean): ConferenceConfigRow {
  // The host PIN is what makes a caller the room's admin — viewers get the
  // dial-in details (number + participant PIN) but never the host PIN.
  return mayManage ? row : { ...row, adminPin: row.adminPin ? "•••" : null };
}

export function registerConferenceRoutes(deps: ConferenceRouteDeps): void {
  const {
    app,
    db,
    requireConferenceViewer,
    requireConferenceManager,
    userMayManage,
    isSuperAdmin,
    assertIvrTenantAccess,
    resolveConnectTenantIdFromScope,
    resolvePbxTenantContext,
    readTeamDirectory,
  } = deps;

  // Shared write-path preamble: caller → tenant → PBX link → live directory.
  async function resolveWriteContext(req: any, reply: any, user: any, bodyTenantId: string | undefined) {
    const raw = bodyTenantId ?? user.tenantId ?? null;
    if (!raw) {
      reply.code(400).send({ error: "tenant_required" });
      return null;
    }
    const tenantId = raw.startsWith("vpbx:") ? await resolveConnectTenantIdFromScope(raw) : raw;
    if (!tenantId) {
      reply.code(400).send({ error: "tenant_not_linked" });
      return null;
    }
    assertIvrTenantAccess(user, tenantId);

    const link = await db.tenantPbxLink.findUnique({
      where: { tenantId },
      select: { pbxTenantId: true, pbxInstanceId: true },
    });
    if (!link?.pbxTenantId) {
      reply.code(409).send({ error: "tenant_not_linked_to_pbx" });
      return null;
    }

    const pbxInstance = link.pbxInstanceId
      ? await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } })
      : await db.pbxInstance.findFirst({ where: { isEnabled: true } });
    if (!pbxInstance) {
      reply.code(503).send({ error: "no_enabled_pbx_instance" });
      return null;
    }

    const dir = await readTeamDirectory(String(link.pbxTenantId), link.pbxInstanceId ?? null);
    if (!dir) {
      reply.code(503).send({
        error: "pbx_unreachable",
        message: "I couldn't read your phone system just now, so I didn't change anything. Try again in a moment.",
      });
      return null;
    }
    // ⛔ Without the tenant path every panel write lands on whatever tenant the
    // robot logged into. teamRoutes tolerates a missing path; here we refuse —
    // a meeting room filed under another company is worse than a retry.
    if (!dir.tenantPath) {
      reply.code(503).send({
        error: "tenant_path_unresolved",
        message: "I couldn't confirm which phone-system tenant to write to, so I didn't change anything. Try again in a moment.",
      });
      return null;
    }

    const existing = await listConferencesFromOmbutel(String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    if (existing.source === "skipped") {
      reply.code(503).send({ error: "pbx_unreachable", detail: existing.skipReason });
      return null;
    }

    return { tenantId, link, pbxInstance, dir, existing: existing.rows };
  }

  function openPanelSession() {
    const panelCfg = loadPanelConfig();
    const account = panelCfg?.accounts[0];
    if (!panelCfg || !account) return null;
    return { panelCfg, account };
  }

  async function maybeApply(
    session: PanelSession,
    user: any,
    applyNow: boolean | undefined,
    tenantPath: string,
    pbxInstanceId: string | null,
  ): Promise<{ live: boolean }> {
    if (!applyNow || !isSuperAdmin(user)) return { live: false };
    // Apply is whole-PBX; applyAndRebake re-bakes the Connect doorway on every
    // Connect-routed number afterwards. Never call applyChanges bare here.
    await applyAndRebake(session, tenantPath, { db, log: app.log, pbxInstanceId }, "conference-apply");
    return { live: true };
  }

  // ── GET /voice/conferences ────────────────────────────────────────────────
  app.get("/voice/conferences", async (req: any, reply: any) => {
    const user = await requireConferenceViewer(req, reply);
    if (!user) return;

    const ctx = await resolvePbxTenantContext(req, user);
    if (!ctx.ok) {
      const b: any = ctx.body;
      return reply
        .code(ctx.status)
        .send(
          ctx.status === 200
            ? { conferences: [], source: "skipped", skipReason: b.skipReason ?? "no tenant context" }
            : b,
        );
    }

    const result = await listConferencesFromOmbutel(ctx.vitalTenantId, ctx.pbxInstance.ombuMysqlUrlEncrypted);
    if (result.source === "skipped") {
      return reply.send({ conferences: [], source: "skipped", skipReason: result.skipReason });
    }

    const mayManage = await userMayManage(user);
    return reply.send({
      conferences: result.rows.map((r) => maskForViewer(r, mayManage)),
      source: result.source,
      vitalTenantId: ctx.vitalTenantId,
      mayManage,
    });
  });

  // ── POST /voice/conferences ───────────────────────────────────────────────
  app.post("/voice/conferences", async (req: any, reply: any) => {
    const user = await requireConferenceManager(req, reply);
    if (!user) return;

    const parsed = CREATE_BODY.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const b = parsed.data;

    // Same PIN for participants and host would make every caller the host.
    if (b.userPin && b.adminPin && b.userPin === b.adminPin) {
      return reply.code(400).send({
        error: "pins_must_differ",
        message: "The host PIN has to be different from the participant PIN — it is what makes a caller the host.",
      });
    }

    const wctx = await resolveWriteContext(req, reply, user, b.tenantId);
    if (!wctx) return;
    const { tenantId, link, pbxInstance, dir, existing } = wctx;

    const conferenceNumbers = existing.map((r) => r.extension);
    let number: string;
    if (b.extension) {
      const taken = new Set(
        [
          ...(dir.used.extensions ?? []),
          ...(dir.used.ringGroups ?? []),
          ...(dir.used.queues ?? []),
          ...conferenceNumbers,
        ].map((n) => String(n).trim()),
      );
      if (taken.has(b.extension)) {
        return reply.code(409).send({
          error: "number_in_use",
          message: `${b.extension} already answers something on your phone system. Pick another number or leave it blank and I'll choose one.`,
        });
      }
      number = b.extension;
    } else {
      const auto = nextConferenceNumber(dir.used, conferenceNumbers);
      if (!auto) {
        return reply.code(409).send({
          error: "no_free_number",
          message: "Every conference number is taken. Delete a room you no longer use, or ask us to add more.",
        });
      }
      number = auto;
    }

    const panel = openPanelSession();
    if (!panel) {
      return reply.code(503).send({ error: "panel_not_configured", message: "Automatic setup isn't switched on for this system." });
    }

    let session: PanelSession;
    let skippedFields: string[] = [];
    try {
      session = await new PanelSession(panel.panelCfg.baseUrl, panel.account).login();
      session.setTenant(dir.tenantPath!);
      const result = await createConference(session, {
        name: b.name,
        extension: number,
        userPin: b.userPin ?? null,
        adminPin: b.adminPin ?? null,
        maxMembers: b.maxMembers ?? null,
        recordConference: b.recordConference,
        startMuted: b.startMuted,
        quiet: b.quiet,
        announceUserCount: b.announceUserCount,
        announceJoinLeave: b.announceJoinLeave,
        musicOnHoldWhenEmpty: b.musicOnHoldWhenEmpty,
        waitForAdmin: b.waitForAdmin,
        endWhenAdminLeaves: b.endWhenAdminLeaves,
      });
      skippedFields = result.skippedFields;
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, number, err: msg }, "[CONFERENCE_CREATE] failed");
      return reply.code(502).send({
        error: "conference_create_failed",
        message: "Couldn't set that up on the phone system. Nothing was changed.",
        detail: msg,
      });
    }

    // Believe the table, not the notification.
    const after = await listConferencesFromOmbutel(String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    const row = after.source !== "skipped" ? after.rows.find((r) => r.extension === number) : undefined;
    if (!row) {
      app.log.error({ tenantId, number }, "[CONFERENCE_CREATE] panel said success but the row is absent");
      return reply.code(502).send({
        error: "conference_create_unverified",
        message: "The phone system reported success but the room doesn't show up. Nothing else was changed — try again or tell us.",
      });
    }

    let live = false;
    try {
      live = (await maybeApply(session, user, b.applyNow, dir.tenantPath!, link.pbxInstanceId ?? null)).live;
    } catch (err: any) {
      app.log.error({ tenantId, number, err: String(err?.message || err) }, "[CONFERENCE_CREATE] apply failed after save");
      // The room exists and is pending — say so rather than failing the create.
    }

    if (skippedFields.length) {
      app.log.warn({ tenantId, number, skippedFields }, "[CONFERENCE_CREATE] panel form did not offer these fields");
    }
    app.log.info({ tenantId, number, name: b.name, live }, "[CONFERENCE_CREATE] created");

    return reply.send({
      ok: true,
      conference: row,
      live,
      skippedFields,
      message: live
        ? `“${b.name}” is live on ${number}. Anyone on your phone system can dial ${number} to join.`
        : `“${b.name}” is set up on ${number}. ${PENDING_APPLY_NOTE}`,
    });
  });

  // ── PATCH /voice/conferences/:extension ───────────────────────────────────
  app.patch("/voice/conferences/:extension", async (req: any, reply: any) => {
    const user = await requireConferenceManager(req, reply);
    if (!user) return;

    const params = z.object({ extension: z.string().regex(/^\d{3,6}$/) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    const parsed = EDIT_BODY.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const b = parsed.data;
    if (b.userPin && b.adminPin && b.userPin === b.adminPin) {
      return reply.code(400).send({
        error: "pins_must_differ",
        message: "The host PIN has to be different from the participant PIN — it is what makes a caller the host.",
      });
    }

    const wctx = await resolveWriteContext(req, reply, user, b.tenantId);
    if (!wctx) return;
    const { tenantId, link, pbxInstance, dir, existing } = wctx;

    const target = existing.find((r) => r.extension === params.data.extension);
    if (!target) {
      return reply.code(404).send({ error: "conference_not_found", message: `No conference room ${params.data.extension} exists on your phone system.` });
    }

    const panel = openPanelSession();
    if (!panel) return reply.code(503).send({ error: "panel_not_configured" });

    let session: PanelSession;
    let skippedFields: string[] = [];
    try {
      session = await new PanelSession(panel.panelCfg.baseUrl, panel.account).login();
      session.setTenant(dir.tenantPath!);
      const result = await updateConference(session, target.id, target.extension, {
        name: b.name,
        userPin: b.userPin,
        adminPin: b.adminPin,
        maxMembers: b.maxMembers,
        recordConference: b.recordConference,
        startMuted: b.startMuted,
        quiet: b.quiet,
        announceUserCount: b.announceUserCount,
        announceJoinLeave: b.announceJoinLeave,
        musicOnHoldWhenEmpty: b.musicOnHoldWhenEmpty,
        waitForAdmin: b.waitForAdmin,
        endWhenAdminLeaves: b.endWhenAdminLeaves,
      });
      skippedFields = result.skippedFields;
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, number: target.extension, err: msg }, "[CONFERENCE_UPDATE] failed");
      return reply.code(502).send({
        error: "conference_update_failed",
        message: "Couldn't save that on the phone system. Nothing was changed.",
        detail: msg,
      });
    }

    const after = await listConferencesFromOmbutel(String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    const row = after.source !== "skipped" ? after.rows.find((r) => r.extension === target.extension) : undefined;
    if (!row || (b.name != null && row.name !== b.name)) {
      app.log.error({ tenantId, number: target.extension }, "[CONFERENCE_UPDATE] panel said success but the row doesn't reflect it");
      return reply.code(502).send({
        error: "conference_update_unverified",
        message: "The phone system reported success but the change doesn't show up. Try again or tell us.",
      });
    }

    let live = false;
    try {
      live = (await maybeApply(session, user, b.applyNow, dir.tenantPath!, link.pbxInstanceId ?? null)).live;
    } catch (err: any) {
      app.log.error({ tenantId, number: target.extension, err: String(err?.message || err) }, "[CONFERENCE_UPDATE] apply failed after save");
    }

    app.log.info({ tenantId, number: target.extension, live }, "[CONFERENCE_UPDATE] saved");
    return reply.send({
      ok: true,
      conference: row,
      live,
      skippedFields,
      message: live ? `“${row.name}” is updated and live.` : `“${row.name}” is updated. ${PENDING_APPLY_NOTE}`,
    });
  });

  // ── DELETE /voice/conferences/:extension ──────────────────────────────────
  app.delete("/voice/conferences/:extension", async (req: any, reply: any) => {
    const user = await requireConferenceManager(req, reply);
    if (!user) return;

    const params = z.object({ extension: z.string().regex(/^\d{3,6}$/) }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_params" });
    const qTenant = (req.query as any)?.tenantId ? String((req.query as any).tenantId) : undefined;

    const wctx = await resolveWriteContext(req, reply, user, qTenant);
    if (!wctx) return;
    const { tenantId, link, pbxInstance, dir, existing } = wctx;

    const target = existing.find((r) => r.extension === params.data.extension);
    if (!target) {
      return reply.code(404).send({ error: "conference_not_found", message: `No conference room ${params.data.extension} exists on your phone system.` });
    }
    if (!target.id) {
      return reply.code(503).send({ error: "conference_id_unresolved", message: "The phone system didn't report an id for that room — nothing was deleted." });
    }

    const panel = openPanelSession();
    if (!panel) return reply.code(503).send({ error: "panel_not_configured" });

    try {
      const session = await new PanelSession(panel.panelCfg.baseUrl, panel.account).login();
      session.setTenant(dir.tenantPath!);
      await deleteConference(session, target.id, `conference ${target.extension} (“${target.name}”)`);
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, number: target.extension, err: msg }, "[CONFERENCE_DELETE] failed");
      return reply.code(502).send({
        error: "conference_delete_failed",
        message: "Couldn't remove that from the phone system. Nothing was changed.",
        detail: msg,
      });
    }

    // Believe the table, not the notification.
    const after = await listConferencesFromOmbutel(String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    const stillThere = after.source !== "skipped" && after.rows.some((r) => r.extension === target.extension);
    if (stillThere) {
      app.log.error({ tenantId, number: target.extension }, "[CONFERENCE_DELETE] panel said success but the row is still there");
      return reply.code(502).send({
        error: "conference_delete_unverified",
        message: "The phone system reported success but the room is still there. Nothing else was changed — try again or tell us.",
      });
    }

    app.log.info({ tenantId, number: target.extension, panelRowId: target.id }, "[CONFERENCE_DELETE] deleted and verified gone");
    return reply.send({
      ok: true,
      message: `Conference room ${target.extension}${target.name ? ` (“${target.name}”)` : ""} is deleted. Callers stop reaching it the next time changes are applied to the phone system.`,
    });
  });
}
