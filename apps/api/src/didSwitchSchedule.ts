/**
 * Which phone number rings a menu — and WHEN.
 *
 * The Studio's top step ("Someone calls…") became a real control: pick a
 * number for the menu, or "no phone number" for a menu reached only from other
 * menus. If a number is picked, the switch-over can happen at publish, or on a
 * booked date — with an optional end date after which calls go back to exactly
 * how they were routed before.
 *
 * The one architectural decision worth defending: the scheduler does NOT
 * reimplement the flip. `/voice/did/:id/switch-to-connect` and
 * `/voice/did/:id/switch-to-pbx` are the most delicate routes in the product —
 * they snapshot the PBX's original destination, retarget the inbound route,
 * publish AstDB, and log every step. The scheduler mints itself a short-lived
 * service token and calls those SAME routes through Fastify's inject (an
 * in-process request — no network). A scheduled flip and an admin's manual
 * flip are therefore literally one code path; there is no second
 * implementation to drift.
 *
 * Failure policy: a failed flip alerts the admin email and RETRIES on
 * following ticks (status stays pending) until the schedule is 30 minutes
 * overdue, at which point it is marked failed — a switch that happens an hour
 * after the promised moment is no longer the thing that was promised.
 */

import { z } from "zod";

export interface DidSwitchDeps {
  app: any;
  db: any;
  /** Publish-level gate: flipping live routing is the same weight as Publish. */
  requirePublisher: (req: any, reply: any) => Promise<any | undefined>;
  /** Draft-level gate for assigning which menu a number points at. */
  requireManager: (req: any, reply: any) => Promise<any | undefined>;
  assertIvrTenantAccess: (user: any, tenantId: string) => void;
  resolveConnectTenantIdFromScope: (scope: string) => Promise<string | null>;
  sendAdminAlert: (key: string, subject: string, lines: string[], minIntervalMs?: number) => Promise<void>;
  /** Tenant's dialplan slug (the `t_<slug>` AstDB family). */
  getTenantSlug: (tenantId: string) => Promise<string>;
  /** Write keys to AstDB via the telephony service. */
  publishAstDbKeys: (tenantSlug: string, keys: Array<{ family: string; key: string; value: string }>) => Promise<void>;
}

const RETRY_WINDOW_MS = 30 * 60 * 1000;
const TICK_MS = 60 * 1000;

/** Same normalisation the DID mapping routes use: digits only, "+"-prefixed. */
export function normalizeDidNumber(raw: string): string | null {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 20) return null;
  return `+${digits}`;
}

/**
 * The Studio's picker must offer every number the tenant already owns on the
 * PBX — the synced list the Phone Numbers page shows (PbxTenantInboundDid) —
 * not just numbers someone hand-registered in DidRouteMapping. Any owned
 * number without a mapping row gets one created here: a draft-only row
 * (routingMode "pbx") that changes nothing for callers until a switch.
 *
 * A number whose e164 is already mapped elsewhere (another tenant, or a
 * deliberately disabled row) is skipped — the unique e164 constraint is the
 * arbiter, and hijacking is not on offer.
 */
export async function ensureMappingsForOwnedNumbers(
  db: any,
  tenantId: string,
  existingMappings: any[],
  createdBy: string | null,
  log?: (msg: string, e164: string) => void,
): Promise<any[]> {
  const owned = await db.pbxTenantInboundDid.findMany({
    where: { connectTenantId: tenantId, active: true },
  });
  const mapped = new Set(existingMappings.map((m: any) => String(m.e164)));
  const added: any[] = [];
  for (const d of owned) {
    const e164 = normalizeDidNumber(d.e164);
    if (!e164 || mapped.has(e164)) continue;
    try {
      const created = await db.didRouteMapping.create({
        data: {
          tenantId,
          e164,
          pbxInstanceId: d.pbxInstanceId ?? null,
          enabled: true,
          createdBy,
        },
      });
      mapped.add(e164);
      added.push(created);
      log?.("auto-registered PBX-synced number for the Studio picker", e164);
    } catch {
      // Unique-e164 violation: mapped under another tenant or disabled here.
      // Either way this number is not ours to offer.
    }
  }
  return added;
}

/** In-process call to a real route, as a short-lived service principal. The
 *  switch log then shows exactly who acted: "scheduler:<scheduleId>". */
async function injectAsService(
  app: any,
  method: "POST",
  url: string,
  actor: string,
): Promise<{ statusCode: number; body: any }> {
  const token = app.jwt.sign({ sub: actor, role: "SUPER_ADMIN", email: "scheduler@connect.internal" }, { expiresIn: "2m" });
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: {} });
  let body: any = null;
  try { body = res.json(); } catch { body = { raw: String(res.body).slice(0, 300) }; }
  return { statusCode: res.statusCode, body };
}

export function registerDidSwitchScheduleRoutes(deps: DidSwitchDeps): void {
  const { app, db, requirePublisher, requireManager, assertIvrTenantAccess, resolveConnectTenantIdFromScope } = deps;

  async function resolveTenant(user: any, raw: string | null | undefined, reply: any): Promise<string | null> {
    const scope = raw ?? user.tenantId ?? null;
    if (!scope) { reply.code(400).send({ error: "tenant_required" }); return null; }
    const tenantId = String(scope).startsWith("vpbx:") ? await resolveConnectTenantIdFromScope(String(scope)) : String(scope);
    if (!tenantId) { reply.code(400).send({ error: "tenant_not_linked" }); return null; }
    try { assertIvrTenantAccess(user, tenantId); } catch { reply.code(403).send({ error: "forbidden" }); return null; }
    return tenantId;
  }

  // ── GET /voice/ivr/numbers ────────────────────────────────────────────────
  // Everything the Studio's number step needs in one read: each number, where
  // it points RIGHT NOW (in words a customer understands), and any booked
  // switch. "Where it points now" is what makes the picker safe — nobody
  // should take over a number without being told what it currently does.
  app.get("/voice/ivr/numbers", async (req: any, reply: any) => {
    const user = await requireManager(req, reply);
    if (!user) return;
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const tenantId = await resolveTenant(user, q.tenantId, reply);
    if (!tenantId) return;

    const [mappings, profiles, schedules] = await Promise.all([
      db.didRouteMapping.findMany({ where: { tenantId, enabled: true }, orderBy: { e164: "asc" } }),
      db.ivrRouteProfile.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      db.didSwitchSchedule.findMany({ where: { tenantId, status: "pending" } }),
    ]);

    // Numbers the tenant owns on the PBX but nobody ever registered for
    // routing appear here too — otherwise the picker is empty for every
    // tenant that never went through the migration screen.
    const autoAdded = await ensureMappingsForOwnedNumbers(
      db,
      tenantId,
      mappings,
      String((user as any).id ?? user.sub ?? "") || null,
      (msg, e164) => app.log.info({ e164, tenantId }, `[DID_ASSIGN] ${msg}`),
    );
    if (autoAdded.length > 0) {
      mappings.push(...autoAdded);
      mappings.sort((a: any, b: any) => String(a.e164).localeCompare(String(b.e164)));
    }
    const nameById = new Map(profiles.map((p: any) => [p.id, p.name]));
    const scheduleByMapping = new Map<string, any>(schedules.map((s: any) => [String(s.mappingId), s]));

    return reply.send({
      numbers: mappings.map((m: any) => {
        const sched = scheduleByMapping.get(m.id) ?? null;
        return {
          mappingId: m.id,
          e164: m.e164,
          routingMode: m.routingMode,
          ivrProfileId: m.ivrProfileId,
          ivrProfileName: m.ivrProfileId ? (nameById.get(m.ivrProfileId) ?? null) : null,
          /** One plain sentence for the picker row. */
          currentlyLabel:
            m.routingMode === "connect"
              ? m.ivrProfileId && nameById.has(m.ivrProfileId)
                ? `Right now: goes to "${nameById.get(m.ivrProfileId)}"`
                : "Right now: handled by Connect"
              : "Right now: handled by your old phone system",
          pendingSwitch: sched
            ? { id: sched.id, ivrProfileId: sched.ivrProfileId, activateAt: sched.activateAt, endAt: sched.endAt }
            : null,
        };
      }),
    });
  });

  // ── POST /voice/ivr/numbers/:mappingId/assign ─────────────────────────────
  // Point the mapping at a menu (a DRAFT action — nothing changes for callers
  // until a publish or a booked switch flips the route). If the number is
  // already live on Connect, republishing its AstDB values is the caller's
  // follow-up via the existing /voice/did/publish.
  app.post("/voice/ivr/numbers/:mappingId/assign", async (req: any, reply: any) => {
    const user = await requireManager(req, reply);
    if (!user) return;
    const { mappingId } = req.params as { mappingId: string };
    const body = z.object({ profileId: z.string().min(1).nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const mapping = await db.didRouteMapping.findUnique({ where: { id: mappingId } });
    if (!mapping) return reply.code(404).send({ error: "mapping_not_found" });
    try { assertIvrTenantAccess(user, mapping.tenantId); } catch { return reply.code(403).send({ error: "forbidden" }); }

    if (body.data.profileId) {
      const profile = await db.ivrRouteProfile.findFirst({ where: { id: body.data.profileId, tenantId: mapping.tenantId } });
      if (!profile) return reply.code(404).send({ error: "profile_not_found" });
    }

    const updated = await db.didRouteMapping.update({
      where: { id: mappingId },
      data: { ivrProfileId: body.data.profileId },
    });
    app.log.info({ mappingId, e164: mapping.e164, profileId: body.data.profileId, by: user.sub }, "[DID_ASSIGN] menu assignment changed");
    return reply.send({ ok: true, mappingId: updated.id, ivrProfileId: updated.ivrProfileId });
  });

  // ── POST /voice/ivr/numbers/:mappingId/schedule ───────────────────────────
  // Book the switch. One pending schedule per number: booking replaces any
  // previous booking, because two competing bookings for one number is a
  // question with no right answer.
  app.post("/voice/ivr/numbers/:mappingId/schedule", async (req: any, reply: any) => {
    const user = await requirePublisher(req, reply);
    if (!user) return;
    const { mappingId } = req.params as { mappingId: string };
    const body = z
      .object({
        profileId: z.string().min(1),
        activateAt: z.string().datetime(),
        endAt: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const mapping = await db.didRouteMapping.findUnique({ where: { id: mappingId } });
    if (!mapping) return reply.code(404).send({ error: "mapping_not_found" });
    try { assertIvrTenantAccess(user, mapping.tenantId); } catch { return reply.code(403).send({ error: "forbidden" }); }

    const activateAt = new Date(body.data.activateAt);
    const endAt = body.data.endAt ? new Date(body.data.endAt) : null;
    if (activateAt.getTime() < Date.now() - 60_000) {
      return reply.code(400).send({ error: "activate_in_past", message: "That start time has already passed. Pick a time in the future, or choose to switch when you publish." });
    }
    if (endAt && endAt.getTime() <= activateAt.getTime()) {
      return reply.code(400).send({ error: "end_before_start", message: "The end date has to be after the start date." });
    }

    const [, schedule] = await db.$transaction([
      db.didSwitchSchedule.updateMany({
        where: { mappingId, status: "pending" },
        data: { status: "canceled" },
      }),
      db.didSwitchSchedule.create({
        data: {
          tenantId: mapping.tenantId,
          mappingId,
          ivrProfileId: body.data.profileId,
          activateAt,
          endAt,
          createdBy: String(user.sub ?? ""),
        },
      }),
      // The menu must already be assigned when the tick fires — the flip reads
      // mapping.ivrProfileId, and a scheduler cannot ask anyone questions.
      db.didRouteMapping.update({ where: { id: mappingId }, data: { ivrProfileId: body.data.profileId } }),
    ]);

    app.log.info(
      { scheduleId: schedule.id, mappingId, e164: mapping.e164, activateAt, endAt, by: user.sub },
      "[DID_SCHEDULE] switch booked",
    );
    return reply.send({ ok: true, schedule: { id: schedule.id, activateAt, endAt } });
  });

  // ── POST /voice/ivr/numbers/schedule/:id/cancel ───────────────────────────
  app.post("/voice/ivr/numbers/schedule/:id/cancel", async (req: any, reply: any) => {
    const user = await requirePublisher(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const sched = await db.didSwitchSchedule.findUnique({ where: { id } });
    if (!sched) return reply.code(404).send({ error: "schedule_not_found" });
    try { assertIvrTenantAccess(user, sched.tenantId); } catch { return reply.code(403).send({ error: "forbidden" }); }
    if (sched.status !== "pending") {
      return reply.code(409).send({ error: "not_pending", message: "That switch has already happened or was already canceled." });
    }
    await db.didSwitchSchedule.update({ where: { id }, data: { status: "canceled" } });
    app.log.info({ scheduleId: id, by: user.sub }, "[DID_SCHEDULE] canceled");
    return reply.send({ ok: true });
  });

  // ═══ Pre-menu announcements ═══════════════════════════════════════════════
  // A tenant-wide message played BEFORE the menu ("closed Thursday for the
  // holiday"). Runtime is one AstDB key — connect/t_<slug>/pre_announce — set
  // at startAt and cleared at endAt by the same scheduler tick. The dialplan
  // plays it once per call, then falls into the menu.
  //
  // ⛔ Until the connect-tenant-ivr dialplan carries the pre_announce read
  //    (scripts/pbx/patch-connect-ivr-pre-announce.sh, applied with Izzy's
  //    go-ahead), the key is written but inert — safe rollout order.

  async function setPreAnnounceKey(deps2: DidSwitchDeps, tenantId: string, value: string): Promise<void> {
    const slug = await deps2.getTenantSlug(tenantId);
    await deps2.publishAstDbKeys(slug, [{ family: `connect/t_${slug}`, key: "pre_announce", value }]);
  }

  // ── GET /voice/ivr/announcement ─────────────────────────────────────────
  app.get("/voice/ivr/announcement", async (req: any, reply: any) => {
    const user = await requireManager(req, reply);
    if (!user) return;
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const tenantId = await resolveTenant(user, q.tenantId, reply);
    if (!tenantId) return;
    const rows = await db.ivrAnnouncementSchedule.findMany({
      where: { tenantId, status: { in: ["pending", "active"] } },
      orderBy: { startAt: "asc" },
    });
    return reply.send({ announcements: rows });
  });

  // ── POST /voice/ivr/announcement ────────────────────────────────────────
  // Book (or start) the announcement. One live booking per tenant: a new one
  // replaces whatever was pending, and ends whatever is active — two
  // announcements before one menu is a queue nobody asked for.
  app.post("/voice/ivr/announcement", async (req: any, reply: any) => {
    const user = await requirePublisher(req, reply);
    if (!user) return;
    const body = z
      .object({
        tenantId: z.string().optional(),
        promptRef: z.string().min(1).max(160),
        startAt: z.union([z.literal("now"), z.string().datetime()]),
        endAt: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const tenantId = await resolveTenant(user, body.data.tenantId, reply);
    if (!tenantId) return;

    const startsNow = body.data.startAt === "now";
    const startAt = startsNow ? new Date() : new Date(body.data.startAt);
    const endAt = body.data.endAt ? new Date(body.data.endAt) : null;
    if (endAt && endAt.getTime() <= startAt.getTime()) {
      return reply.code(400).send({ error: "end_before_start", message: "The end date has to be after the start date." });
    }

    // Replace, don't stack.
    await db.ivrAnnouncementSchedule.updateMany({
      where: { tenantId, status: "pending" },
      data: { status: "canceled" },
    });
    const wasActive = await db.ivrAnnouncementSchedule.findFirst({ where: { tenantId, status: "active" } });

    const row = await db.ivrAnnouncementSchedule.create({
      data: {
        tenantId,
        promptRef: body.data.promptRef,
        startAt,
        endAt,
        createdBy: String(user.sub ?? ""),
      },
    });

    if (startsNow) {
      try {
        await setPreAnnounceKey(deps, tenantId, body.data.promptRef);
        await db.ivrAnnouncementSchedule.update({ where: { id: row.id }, data: { status: "active", startedAt: new Date() } });
        if (wasActive) {
          await db.ivrAnnouncementSchedule.update({ where: { id: wasActive.id }, data: { status: "ended", endedAt: new Date() } });
        }
      } catch (err: any) {
        await db.ivrAnnouncementSchedule.update({ where: { id: row.id }, data: { lastError: String(err?.message ?? err).slice(0, 300) } });
        return reply.code(502).send({ error: "announce_publish_failed", message: "The announcement was saved but couldn't be switched on yet. It will keep retrying." });
      }
    }

    app.log.info({ id: row.id, tenantId, promptRef: body.data.promptRef, startsNow, endAt, by: user.sub }, "[ANNOUNCE] booked");
    return reply.send({ ok: true, announcement: { id: row.id, status: startsNow ? "active" : "pending", startAt, endAt } });
  });

  // ── POST /voice/ivr/announcement/:id/stop ───────────────────────────────
  // Stops an active announcement, or cancels a pending one.
  app.post("/voice/ivr/announcement/:id/stop", async (req: any, reply: any) => {
    const user = await requirePublisher(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const row = await db.ivrAnnouncementSchedule.findUnique({ where: { id } });
    if (!row) return reply.code(404).send({ error: "not_found" });
    try { assertIvrTenantAccess(user, row.tenantId); } catch { return reply.code(403).send({ error: "forbidden" }); }

    if (row.status === "pending") {
      await db.ivrAnnouncementSchedule.update({ where: { id }, data: { status: "canceled" } });
      return reply.send({ ok: true, status: "canceled" });
    }
    if (row.status === "active") {
      await setPreAnnounceKey(deps, row.tenantId, "");
      await db.ivrAnnouncementSchedule.update({ where: { id }, data: { status: "ended", endedAt: new Date() } });
      return reply.send({ ok: true, status: "ended" });
    }
    return reply.code(409).send({ error: "not_running" });
  });
}

/**
 * The tick. Runs inside the API process (same pattern as the receipt
 * reconciliation sweep) so a booked switch happens even when nobody is logged
 * in anywhere.
 */
export function startDidSwitchScheduler(deps: DidSwitchDeps): NodeJS.Timeout {
  const { app, db, sendAdminAlert } = deps;
  let running = false;

  const tick = async () => {
    if (running) return; // a slow PBX must not stack ticks
    running = true;
    try {
      const now = new Date();

      // 1) Due activations.
      const due = await db.didSwitchSchedule.findMany({
        where: { status: "pending", activateAt: { lte: now } },
        take: 10,
      });
      for (const sched of due) {
        const mapping = await db.didRouteMapping.findUnique({ where: { id: sched.mappingId } });
        if (!mapping || !mapping.enabled) {
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "failed", lastError: "mapping_missing_or_disabled" } });
          continue;
        }
        // Already live on Connect (someone flipped it by hand in the
        // meantime): the booking is satisfied, not failed.
        if (mapping.routingMode === "connect" && mapping.ivrProfileId === sched.ivrProfileId) {
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "activated", activatedAt: now } });
          continue;
        }

        const r = await injectAsService(app, "POST", `/voice/did/${encodeURIComponent(sched.mappingId)}/switch-to-connect`, `scheduler:${sched.id}`);
        if (r.statusCode >= 200 && r.statusCode < 300) {
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "activated", activatedAt: new Date(), lastError: null } });
          app.log.info({ scheduleId: sched.id, e164: mapping.e164 }, "[DID_SCHEDULE] switched to Connect on schedule");
        } else {
          const detail = `${r.statusCode}: ${JSON.stringify(r.body).slice(0, 300)}`;
          const overdue = now.getTime() - new Date(sched.activateAt).getTime() > RETRY_WINDOW_MS;
          await db.didSwitchSchedule.update({
            where: { id: sched.id },
            data: overdue ? { status: "failed", lastError: detail } : { lastError: detail },
          });
          app.log.error({ scheduleId: sched.id, e164: mapping.e164, detail, overdue }, "[DID_SCHEDULE] switch failed");
          await sendAdminAlert(
            `did-schedule-${sched.id}`,
            `Scheduled number switch ${overdue ? "FAILED" : "failing"} for ${mapping.e164}`,
            [
              `Number: ${mapping.e164}`,
              `Schedule: ${sched.id} (activate ${new Date(sched.activateAt).toISOString()})`,
              `Error: ${detail}`,
              overdue ? "Marked FAILED — no more retries. The number still routes the old way." : "Will retry every minute for up to 30 minutes.",
            ],
            30 * 60_000,
          );
        }
      }

      // 2) Due endings — hand the number back to its original PBX routing.
      const ending = await db.didSwitchSchedule.findMany({
        where: { status: "activated", endAt: { not: null, lte: now } },
        take: 10,
      });
      for (const sched of ending) {
        const mapping = await db.didRouteMapping.findUnique({ where: { id: sched.mappingId } });
        if (!mapping) {
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "ended", endedAt: now, lastError: "mapping_missing_at_end" } });
          continue;
        }
        if (mapping.routingMode !== "connect") {
          // Someone already restored it by hand — the booking's end is done.
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "ended", endedAt: now } });
          continue;
        }

        const r = await injectAsService(app, "POST", `/voice/did/${encodeURIComponent(sched.mappingId)}/switch-to-pbx`, `scheduler:${sched.id}`);
        if (r.statusCode >= 200 && r.statusCode < 300) {
          await db.didSwitchSchedule.update({ where: { id: sched.id }, data: { status: "ended", endedAt: new Date(), lastError: null } });
          app.log.info({ scheduleId: sched.id, e164: mapping.e164 }, "[DID_SCHEDULE] handed back to PBX on schedule");
        } else {
          const detail = `${r.statusCode}: ${JSON.stringify(r.body).slice(0, 300)}`;
          const overdue = now.getTime() - new Date(sched.endAt!).getTime() > RETRY_WINDOW_MS;
          await db.didSwitchSchedule.update({
            where: { id: sched.id },
            // An end that cannot execute leaves the number on Connect — the
            // safe direction — so after the retry window we stop trying and
            // keep the schedule 'activated' with the error visible.
            data: { lastError: overdue ? `end_failed_gave_up: ${detail}` : detail },
          });
          app.log.error({ scheduleId: sched.id, e164: mapping.e164, detail, overdue }, "[DID_SCHEDULE] hand-back failed");
          await sendAdminAlert(
            `did-schedule-end-${sched.id}`,
            `Scheduled hand-back ${overdue ? "gave up" : "failing"} for ${mapping.e164}`,
            [
              `Number: ${mapping.e164} is still routed to Connect.`,
              `Schedule: ${sched.id} (end ${new Date(sched.endAt!).toISOString()})`,
              `Error: ${detail}`,
            ],
            30 * 60_000,
          );
        }
      }
      // 3) Announcements due to start.
      const annDue = await db.ivrAnnouncementSchedule.findMany({
        where: { status: "pending", startAt: { lte: now } },
        take: 10,
      });
      for (const ann of annDue) {
        try {
          const slug = await deps.getTenantSlug(ann.tenantId);
          await deps.publishAstDbKeys(slug, [{ family: `connect/t_${slug}`, key: "pre_announce", value: ann.promptRef }]);
          // Only one active per tenant: starting this one ends any other.
          await db.ivrAnnouncementSchedule.updateMany({
            where: { tenantId: ann.tenantId, status: "active" },
            data: { status: "ended", endedAt: now },
          });
          await db.ivrAnnouncementSchedule.update({ where: { id: ann.id }, data: { status: "active", startedAt: new Date(), lastError: null } });
          app.log.info({ id: ann.id, tenantId: ann.tenantId, promptRef: ann.promptRef }, "[ANNOUNCE] started on schedule");
        } catch (err: any) {
          const detail = String(err?.message ?? err).slice(0, 300);
          const overdue = now.getTime() - new Date(ann.startAt).getTime() > RETRY_WINDOW_MS;
          await db.ivrAnnouncementSchedule.update({
            where: { id: ann.id },
            data: overdue ? { status: "failed", lastError: detail } : { lastError: detail },
          });
          await sendAdminAlert(`announce-${ann.id}`, `Scheduled announcement ${overdue ? "FAILED" : "failing"}`,
            [`Tenant: ${ann.tenantId}`, `Recording: ${ann.promptRef}`, `Error: ${detail}`], 30 * 60_000);
        }
      }

      // 4) Announcements due to stop.
      const annEnding = await db.ivrAnnouncementSchedule.findMany({
        where: { status: "active", endAt: { not: null, lte: now } },
        take: 10,
      });
      for (const ann of annEnding) {
        try {
          const slug = await deps.getTenantSlug(ann.tenantId);
          await deps.publishAstDbKeys(slug, [{ family: `connect/t_${slug}`, key: "pre_announce", value: "" }]);
          await db.ivrAnnouncementSchedule.update({ where: { id: ann.id }, data: { status: "ended", endedAt: new Date(), lastError: null } });
          app.log.info({ id: ann.id, tenantId: ann.tenantId }, "[ANNOUNCE] stopped on schedule");
        } catch (err: any) {
          const detail = String(err?.message ?? err).slice(0, 300);
          await db.ivrAnnouncementSchedule.update({ where: { id: ann.id }, data: { lastError: detail } });
          await sendAdminAlert(`announce-end-${ann.id}`, "Scheduled announcement failed to stop",
            [`Tenant: ${ann.tenantId}`, `Recording ${ann.promptRef} is still playing before the menu.`, `Error: ${detail}`], 30 * 60_000);
        }
      }
    } catch (err: any) {
      app.log.error({ err: err?.message }, "[DID_SCHEDULE] tick crashed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  (timer as any).unref?.();
  return timer as any;
}
