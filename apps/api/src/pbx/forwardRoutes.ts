/**
 * Creating a "forward to a phone number" from the IVR Studio.
 *
 * The customer types an outside number; we create the pair on the PBX (see
 * forwardBuilder.ts) and hand back the internal number their menu key will
 * point at. The key itself is saved separately, by the Studio, through the
 * normal option route — this endpoint only makes the thing that answers.
 *
 * The safety this adds on top of the builder is the same a customer-facing
 * button always needs here:
 *
 *   • The number is validated and normalised to digits BEFORE anything is
 *     created; a number the dial plan can't reach is refused, not created.
 *   • The internal number is allocated from the live picture of what's in use,
 *     including forwards that already exist. If the PBX can't be read we
 *     refuse, because guessing could hand out a number that already rings.
 *   • Apply Changes is never called — the standing rule for every PBX write.
 */

import { z } from "zod";
import { PanelSession, loadPanelConfig } from "../onboarding/panelClient";
import { createForward, normaliseForwardNumber, phoneFromDescription } from "./forwardBuilder";
import { formatPhone, type UsedNumbers } from "@connect/shared";

export interface ForwardRouteDeps {
  app: any;
  db: any;
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
    customApplications: { id: number; number: string; name: string }[];
    tenantPath: string | null;
  } | null>;
}

const BODY = z.object({
  tenantId: z.string().optional(),
  /** The outside number, however the customer typed it. */
  phoneNumber: z.string().min(3).max(30),
  /** What this forward is for — "Sales", "Owner's cell". Optional; the number
   *  alone is a fine name. */
  label: z.string().max(40).optional(),
});

export function registerForwardRoutes(deps: ForwardRouteDeps): void {
  const { app, db, requireIvrManager, assertIvrTenantAccess, resolveConnectTenantIdFromScope, readTeamDirectory } = deps;

  /** Shared tenant resolution — a Studio caller may pass a `vpbx:` scope. */
  async function resolveTenant(req: any, reply: any, user: any): Promise<string | null> {
    const raw = (req.query?.tenantId as string) ?? (req.body?.tenantId as string) ?? user.tenantId ?? null;
    if (!raw) { reply.code(400).send({ error: "tenant_required" }); return null; }
    const tenantId = raw.startsWith("vpbx:") ? await resolveConnectTenantIdFromScope(raw) : raw;
    if (!tenantId) { reply.code(400).send({ error: "tenant_not_linked" }); return null; }
    assertIvrTenantAccess(user, tenantId);
    return tenantId;
  }

  // ── GET /voice/forwards ───────────────────────────────────────────────────
  // The outside numbers this tenant can already reach. The Studio needs these
  // to say WHICH number a saved key rings, instead of showing a bare internal
  // number the customer has never heard of.
  //
  // Soft-fails to an empty list with `read: false` when the PBX can't be read.
  // "This customer has no forwards" and "we couldn't find out" are different
  // facts, and conflating them is what makes a screen claim something is gone
  // when it is merely unreachable.
  app.get("/voice/forwards", async (req: any, reply: any) => {
    const user = await requireIvrManager(req, reply);
    if (!user) return;
    const tenantId = await resolveTenant(req, reply, user);
    if (!tenantId) return;

    const link = await db.tenantPbxLink.findUnique({
      where: { tenantId },
      select: { pbxTenantId: true, pbxInstanceId: true },
    });
    if (!link?.pbxTenantId) return reply.send({ forwards: [], read: false, reason: "tenant_not_linked_to_pbx" });

    const dir = await readTeamDirectory(String(link.pbxTenantId), link.pbxInstanceId ?? null);
    if (!dir) return reply.send({ forwards: [], read: false, reason: "pbx_unreachable" });

    return reply.send({
      read: true,
      forwards: dir.customApplications.map((a) => {
        const phone = phoneFromDescription(a.name);
        return {
          extension: a.number,
          phoneNumber: phone ?? "",
          // A Custom Application built by hand in the panel has no number in
          // its name; show what it IS called rather than inventing one.
          name: phone ? formatPhone(phone) : a.name || `Extension ${a.number}`,
        };
      }),
    });
  });

  // ── POST /voice/forwards ──────────────────────────────────────────────────
  app.post("/voice/forwards", async (req: any, reply: any) => {
    const user = await requireIvrManager(req, reply);
    if (!user) return;

    const parsed = BODY.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
    const b = parsed.data;

    // Validate the number before touching the PBX, so a typo can never leave a
    // half-built forward behind.
    const number = normaliseForwardNumber(b.phoneNumber);
    if (!number) {
      return reply.code(400).send({
        error: "bad_phone_number",
        message: "That doesn't look like a phone number we can dial. Use a 10-digit US number, like (845) 555-1234.",
      });
    }

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

    const dir = await readTeamDirectory(String(link.pbxTenantId), link.pbxInstanceId ?? null);
    if (!dir) {
      return reply.code(503).send({
        error: "pbx_unreachable",
        message: "I couldn't read your phone system just now, so I didn't create anything. Try again in a moment.",
      });
    }

    const panelCfg = loadPanelConfig();
    const account = panelCfg?.accounts?.[0];
    if (!panelCfg || !account) {
      return reply.code(503).send({
        error: "panel_not_configured",
        message: "Automatic setup isn't switched on for this system.",
      });
    }

    // Izzy's naming rule: the panel row says what it is and where it goes, so a
    // forward is recognisable months later without opening Connect.
    const description = `Forward – ${b.label?.trim() || "Menu key"} – ${formatPhone(number)}`.slice(0, 60);

    let result;
    try {
      const session = await new PanelSession(panelCfg.baseUrl, account).login();
      // Without this every write lands on whatever tenant the robot logged into
      // — which is how one customer's menu ended up filed under another.
      if (dir.tenantPath) session.setTenant(dir.tenantPath);

      // Straight from the PBX database via the helper — Custom Applications
      // live in their own table and are invisible to the extension / ring group
      // / queue lists, so without them a new forward could be handed a number
      // that is already forwarding somewhere.
      const existingForwards = dir.customApplications.map((a) => a.number);
      result = await createForward(session, { description, phoneNumber: number }, dir.used, existingForwards);
    } catch (err: any) {
      const msg = String(err?.message || err);
      app.log.error({ tenantId, err: msg }, "[FORWARD_CREATE] failed");
      if (/no_free_forward_number/.test(msg)) {
        return reply.code(409).send({
          error: "no_free_forward_number",
          message: "Every forwarding number is in use. Delete a forward you no longer need, or ask us to widen the range.",
        });
      }
      if (/destination_not_found_after_create/.test(msg)) {
        return reply.code(502).send({
          error: "forward_create_failed",
          message:
            "The phone system saved the number but wouldn't hand it back, so I stopped rather than build a menu key that goes nowhere. Nothing is pointing at it.",
        });
      }
      return reply.code(502).send({
        error: "forward_create_failed",
        message: "Couldn't set that up on the phone system.",
        detail: msg,
      });
    }

    app.log.info(
      { tenantId, extension: result.extension, phoneNumber: result.phoneNumber },
      "[FORWARD_CREATE] created (pending Apply Changes)",
    );

    return reply.send({
      ok: true,
      forward: {
        extension: result.extension,
        phoneNumber: result.phoneNumber,
        name: formatPhone(result.phoneNumber),
        description: result.description,
      },
      /** Deliberately surfaced: it exists but callers won't reach it yet. */
      live: false,
      message: `Calls will go to ${formatPhone(result.phoneNumber)}. It starts working the next time changes are applied to the phone system.`,
    });
  });
}
