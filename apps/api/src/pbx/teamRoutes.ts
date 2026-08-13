/**
 * Creating a team (ring group or queue) from the IVR Studio.
 *
 * There is no API for either on this PBX — see teamBuilder.ts. Everything here
 * goes through the panel robot, replaying the exact form the panel's own save
 * sends.
 *
 * What this file adds on top of teamBuilder is the safety a customer-facing
 * button needs:
 *
 *   • Members arrive as extension NUMBERS (what a person knows) and are
 *     resolved to VitalPBX row ids against the live directory. A number that
 *     doesn't exist stops the whole request — never a team that silently rings
 *     nobody.
 *   • The number is allocated from the live picture of what's in use. If the
 *     PBX can't be read we refuse, because guessing could hand out a number
 *     that already rings somewhere.
 *   • Apply Changes is never called. Writes sit pending until the owner
 *     applies them, which is the standing rule for every PBX write.
 */

import { z } from "zod";
import { PanelSession, loadPanelConfig } from "../onboarding/panelClient";
import { createRingGroup, createQueue, deleteTeam, LAST_DESTINATION_CATEGORIES } from "./teamBuilder";
import type { UsedNumbers } from "@connect/shared";

export interface TeamRouteDeps {
  app: any;
  db: any;
  /** Resolves the caller and enforces IVR management, or replies. */
  requireIvrManager: (req: any, reply: any) => Promise<any | undefined>;
  assertIvrTenantAccess: (user: any, tenantId: string) => void;
  resolveConnectTenantIdFromScope: (scope: string) => Promise<string | null>;
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

const MEMBER_LIST = z.array(z.string().min(1)).min(1).max(50);

const LAST_DEST = z
  .object({
    kind: z.enum(["extension", "voicemail", "ivr"]),
    /** Extension number, or the PBX row id for an IVR. */
    target: z.string().min(1),
  })
  .optional();

const BODY = z.object({
  tenantId: z.string().optional(),
  kind: z.enum(["ring_group", "queue"]),
  name: z.string().min(1).max(60),
  prefix: z.string().max(20).optional(),
  /** Ring groups only. Queues always ring everyone available. */
  strategy: z.enum(["ringall", "one_by_one"]).optional(),
  /** Extension numbers, IN THE ORDER they should ring. */
  members: MEMBER_LIST,
  ringTime: z.number().int().min(0).max(300).optional(),
  lastDestination: LAST_DEST,

  // ── queue-only ──────────────────────────────────────────────────────────
  retry: z.number().int().min(0).max(120).optional(),
  musicGroupId: z.string().optional(),
  joinAnnouncementId: z.string().optional(),
  periodicAnnouncementId: z.string().optional(),
  periodicAnnounceFrequency: z.number().int().min(0).max(3600).optional(),
  /** true = the gap between repeats starts when the message ENDS, so an
   *  announcement never talks over the previous one. */
  relativePeriodicAnnounce: z.boolean().optional(),
  announcePosition: z.boolean().optional(),
  maxCallers: z.number().int().min(0).max(999).optional(),
  maxWaitSeconds: z.number().int().min(0).max(7200).optional(),
});

export function registerTeamRoutes(deps: TeamRouteDeps): void {
  const { app, db, requireIvrManager, assertIvrTenantAccess, resolveConnectTenantIdFromScope, readTeamDirectory } = deps;

  // ── POST /voice/teams ─────────────────────────────────────────────────────
  app.post("/voice/teams", async (req: any, reply: any) => {
    const user = await requireIvrManager(req, reply);
    if (!user) return;

    const parsed = BODY.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const b = parsed.data;

    const raw = b.tenantId ?? user.tenantId ?? null;
    if (!raw) return reply.code(400).send({ error: "tenant_required" });
    const tenantId = raw.startsWith("vpbx:") ? await resolveConnectTenantIdFromScope(raw) : raw;
    if (!tenantId) return reply.code(400).send({ error: "tenant_not_linked" });
    assertIvrTenantAccess(user, tenantId);

    const link = await db.tenantPbxLink.findUnique({
      where: { tenantId },
      select: { pbxTenantId: true, pbxInstanceId: true },
    });
    if (!link?.pbxTenantId) return reply.code(409).send({ error: "tenant_not_linked_to_pbx" });

    // Read the live picture ONCE — the same read gives us free numbers and the
    // extension ids, so there's no window where they could disagree.
    const dir = await readTeamDirectory(String(link.pbxTenantId), link.pbxInstanceId ?? null);
    if (!dir) {
      return reply.code(503).send({
        error: "pbx_unreachable",
        message: "I couldn't read your phone system just now, so I didn't create anything. Try again in a moment.",
      });
    }

    // Members: numbers in, row ids out. An unknown number is fatal — a team
    // that silently rings nobody is worse than a refusal.
    const byNumber = new Map(dir.extensions.map((e) => [String(e.number), e]));
    const members: { extensionId: string }[] = [];
    const missing: string[] = [];
    for (const num of b.members) {
      const hit = byNumber.get(String(num).trim());
      if (!hit) missing.push(String(num));
      else members.push({ extensionId: String(hit.id) });
    }
    if (missing.length) {
      return reply.code(400).send({
        error: "unknown_extensions",
        message: `These extensions aren't on your phone system: ${missing.join(", ")}.`,
        missing,
      });
    }
    // Same person twice would ring one phone twice and skew a queue's fairness.
    const seen = new Set<string>();
    const deduped = members.filter((m) => (seen.has(m.extensionId) ? false : (seen.add(m.extensionId), true)));

    // Last destination: the customer picks a person or an IVR; we translate to
    // the panel's category id + target the same way the Studio does.
    let lastDestination: { categoryId: string; targetId: string } | undefined;
    if (b.lastDestination) {
      const { kind, target } = b.lastDestination;
      if (kind === "ivr") {
        lastDestination = { categoryId: LAST_DESTINATION_CATEGORIES.ivr, targetId: String(target) };
      } else {
        const hit = byNumber.get(String(target).trim());
        if (!hit) {
          return reply.code(400).send({
            error: "unknown_destination",
            message: `Extension ${target} isn't on your phone system.`,
          });
        }
        lastDestination = {
          categoryId: kind === "voicemail" ? LAST_DESTINATION_CATEGORIES.voicemail : LAST_DESTINATION_CATEGORIES.extension,
          targetId: String(hit.id),
        };
      }
    }

    const panelCfg = loadPanelConfig();
    if (!panelCfg) {
      return reply.code(503).send({
        error: "panel_not_configured",
        message: "Automatic setup isn't switched on for this system.",
      });
    }
    const account = panelCfg.accounts[0];
    if (!account) return reply.code(503).send({ error: "panel_not_configured" });

    let result;
    try {
      const session = await new PanelSession(panelCfg.baseUrl, account).login();
      // Without this every write lands on whatever tenant the robot logged
      // into — which is how one customer's menu ended up filed under another.
      if (dir.tenantPath) session.setTenant(dir.tenantPath);

      result =
        b.kind === "ring_group"
          ? await createRingGroup(
              session,
              {
                name: b.name,
                prefix: b.prefix,
                strategy: b.strategy ?? "ringall",
                members: deduped,
                ringTime: b.ringTime,
                lastDestination,
              },
              dir.used,
            )
          : await createQueue(
              session,
              {
                name: b.name,
                prefix: b.prefix,
                members: deduped,
                ringTime: b.ringTime,
                retry: b.retry,
                musicGroupId: b.musicGroupId,
                joinAnnouncementId: b.joinAnnouncementId,
                periodicAnnouncementId: b.periodicAnnouncementId,
                periodicAnnounceFrequency: b.periodicAnnounceFrequency,
                relativePeriodicAnnounce: b.relativePeriodicAnnounce,
                announcePosition: b.announcePosition,
                maxCallers: b.maxCallers,
                maxWaitSeconds: b.maxWaitSeconds,
                lastDestination,
              },
              dir.used,
            );
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, kind: b.kind, err: msg }, "[TEAM_CREATE] failed");
      if (/no_free_.*_number/.test(msg)) {
        return reply.code(409).send({
          error: "no_free_number",
          message: b.kind === "ring_group"
            ? "Every group number is taken. Delete one you no longer use, or ask us to add more."
            : "Every queue number is taken. Delete one you no longer use, or ask us to add more.",
        });
      }
      return reply.code(502).send({
        error: "team_create_failed",
        message: "Couldn't set that up on the phone system. Nothing was changed.",
        detail: msg,
      });
    }

    app.log.info(
      { tenantId, kind: result.kind, number: result.number, name: result.name, members: deduped.length },
      "[TEAM_CREATE] created (pending Apply Changes)",
    );

    return reply.send({
      ok: true,
      team: {
        kind: result.kind,
        number: result.number,
        name: result.name,
        memberCount: deduped.length,
      },
      /** Deliberately surfaced: it exists but callers won't reach it yet. */
      live: false,
      message: `“${result.name}” is set up on ${result.number}. It goes live the next time changes are applied to the phone system.`,
    });
  });

  // ── DELETE /voice/teams ───────────────────────────────────────────────────
  // "Cannot delete teams" — teams could be created from the Studio since
  // 2026-08-04 but never removed, so every experiment left a permanent ring
  // group behind. Same panel-robot discipline as create, with three fences:
  //   1. the panel row id is resolved server-side FROM THE NUMBER via the live
  //      Ombutel read — never taken from the client;
  //   2. a team any menu key still points at is refused BY NAME (a key routing
  //      callers into a deleted team is a dead end a caller discovers first);
  //   3. the delete is the panel's own two-step confirm, then verified GONE by
  //      re-reading the table — a success notification alone is not proof.
  app.delete("/voice/teams/:kind/:number", async (req: any, reply: any) => {
    const user = await requireIvrManager(req, reply);
    if (!user) return;

    // Path params + query tenant scope (the Studio's `qs`), because the portal's
    // apiDelete sends no body — a body-only DELETE would be uncallable from it.
    const parsed = z.object({
      kind: z.enum(["ring_group", "queue"]),
      number: z.string().regex(/^\d{3,6}$/),
    }).safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_params", detail: parsed.error.flatten() });
    const b = { ...parsed.data, tenantId: (req.query as any)?.tenantId ? String((req.query as any).tenantId) : undefined };

    const raw = b.tenantId ?? user.tenantId ?? null;
    if (!raw) return reply.code(400).send({ error: "tenant_required" });
    const tenantId = raw.startsWith("vpbx:") ? await resolveConnectTenantIdFromScope(raw) : raw;
    if (!tenantId) return reply.code(400).send({ error: "tenant_not_linked" });
    assertIvrTenantAccess(user, tenantId);

    const link = await db.tenantPbxLink.findUnique({
      where: { tenantId },
      select: { pbxTenantId: true, pbxInstanceId: true },
    });
    if (!link?.pbxTenantId) return reply.code(409).send({ error: "tenant_not_linked_to_pbx" });

    // Fence 2 first — cheapest, and the refusal a person can act on.
    const marker = b.kind === "queue" ? `ext-queues,${b.number},` : `ext-group,${b.number},`;
    const pointingKeys = await db.ivrOptionRoute.findMany({
      where: { destinationRef: { contains: marker }, profile: { tenantId } },
      select: { digit: true, profile: { select: { name: true } } },
      take: 10,
    });
    if (pointingKeys.length > 0) {
      const wheres = pointingKeys.map((k: any) => `key ${k.digit} of “${k.profile?.name ?? "a menu"}”`).join(", ");
      return reply.code(409).send({
        error: "team_in_use",
        message: `That team still answers ${wheres}. Point those keys somewhere else first, then delete it.`,
      });
    }

    const pbxInstance = link.pbxInstanceId
      ? await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } })
      : await db.pbxInstance.findFirst({ where: { isEnabled: true } });
    if (!pbxInstance) return reply.code(503).send({ error: "no_enabled_pbx_instance" });

    // Fence 1 — resolve the panel row id from the live table.
    const { listTeamsFromOmbutel } = await import("../pbxOmbutelRingGroupList");
    const listed = await listTeamsFromOmbutel(b.kind, String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    if (listed.source === "skipped") {
      return reply.code(503).send({ error: "pbx_unreachable", detail: listed.skipReason });
    }
    const row = listed.rows.find((r) => r.number === b.number);
    if (!row) return reply.code(404).send({ error: "team_not_found", message: `No ${b.kind === "queue" ? "queue" : "ring group"} ${b.number} exists on your phone system.` });
    if (!row.id) return reply.code(503).send({ error: "team_id_unresolved", message: "The phone system didn't report an id for that team — nothing was deleted." });

    const panelCfg = loadPanelConfig();
    const account = panelCfg?.accounts[0];
    if (!panelCfg || !account) return reply.code(503).send({ error: "panel_not_configured" });

    const dir = await readTeamDirectory(String(link.pbxTenantId), link.pbxInstanceId ?? null);
    try {
      const session = await new PanelSession(panelCfg.baseUrl, account).login();
      if (dir?.tenantPath) session.setTenant(dir.tenantPath);
      await deleteTeam(session, b.kind, String(row.id));
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, kind: b.kind, number: b.number, err: msg }, "[TEAM_DELETE] failed");
      return reply.code(502).send({
        error: "team_delete_failed",
        message: "Couldn't remove that from the phone system. Nothing was changed.",
        detail: msg,
      });
    }

    // Fence 3 — believe the table, not the notification.
    const after = await listTeamsFromOmbutel(b.kind, String(link.pbxTenantId), pbxInstance.ombuMysqlUrlEncrypted);
    const stillThere = after.source !== "skipped" && after.rows.some((r) => r.number === b.number);
    if (stillThere) {
      app.log.error({ tenantId, kind: b.kind, number: b.number }, "[TEAM_DELETE] panel said success but the row is still there");
      return reply.code(502).send({ error: "team_delete_unverified", message: "The phone system reported success but the team is still there. Nothing else was changed — try again or tell us." });
    }

    app.log.info({ tenantId, kind: b.kind, number: b.number, panelRowId: row.id }, "[TEAM_DELETE] deleted and verified gone");
    return reply.send({
      ok: true,
      message: `${b.kind === "queue" ? "Queue" : "Team"} ${b.number}${row.name ? ` (“${row.name}”)` : ""} is deleted. Callers stop reaching it the next time changes are applied to the phone system.`,
    });
  });
}
