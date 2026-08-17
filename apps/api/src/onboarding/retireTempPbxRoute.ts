/**
 * retireTempPbxRoute — take the temporary number off the customer's phone
 * system once their port has completed.
 *
 * The carrier half of retirement has always worked: `portLanding.ts` routes the
 * temp DID back to the master VoIP.ms account and it rejoins the spare pool.
 * The PBX half never happened, so the customer's tenant kept an inbound route
 * for a number they no longer own — and because `pbxTenantInboundDidSync` reads
 * `ombu_inbound_routes` to populate `PbxTenantInboundDid`, and E911 is billed
 * `per_phone_number` off that table, **the customer went on being charged $3 a
 * month for it**. This closes that.
 *
 * ⛔⛔ THE GUARD IS THE POINT, NOT THE DELETE.
 * VitalPBX cascades `ombu_destinations` when a route that points at it is
 * deleted. Ports built before commit `5330620d` gave BOTH the temporary route
 * and the real "Main ported" route the SAME destination row — inii mini's
 * routes 239 and 240 both point at row 907 to this day. Deleting the temp route
 * there would cascade row 907 and **silently kill their live number**. So this
 * refuses to delete any route whose destination row another route also uses,
 * and says so out loud rather than guessing.
 *
 * ⛔ Apply Changes is deliberately NEVER fired. It wipes the Connect doorway off
 * every route of every tenant with pending changes (see the forward/Apply
 * Changes handoff), which is a platform-wide outage risk taken on behalf of a
 * $3 cleanup. The stale dialplan line left behind is inert: the number is back
 * on the master account, so no call can arrive on it. The next legitimate
 * regeneration clears it.
 */

import type { PanelSession } from "./panelClient";

export type PbxRouteRow = {
  routeId: string;
  did: string;
  destinationId: number | null;
  description?: string | null;
};

export type RetirementDecision =
  | { action: "delete"; routeId: string; destinationId: number | null; reason: string }
  | { action: "skip"; reason: string };

/**
 * Decide whether the temporary number's inbound route can be safely deleted.
 *
 * Pure on purpose: this is the half that can destroy a live customer number, so
 * it is unit-tested against the real shapes (Matamim's separate rows, inii
 * mini's shared row) without needing a PBX.
 *
 * `allRoutes` must be every route that could share a destination row — query it
 * by destination id across the whole PBX, not just this tenant, because nothing
 * constrains a destination row to one tenant.
 */
export function decideTempRouteDeletion(input: {
  tempDid: string;
  portedDid: string;
  /** The candidate tenant's routes. */
  tenantRoutes: PbxRouteRow[];
  /** Every route on the PBX sharing any destination id seen above. */
  allRoutes: PbxRouteRow[];
}): RetirementDecision {
  const temp = String(input.tempDid || "").replace(/\D/g, "");
  const ported = String(input.portedDid || "").replace(/\D/g, "");
  if (!temp) return { action: "skip", reason: "no temporary number on this sign-up" };
  if (temp === ported) {
    // Would delete the customer's live number. Cannot happen from the current
    // caller, but this function must be safe on its own terms.
    return { action: "skip", reason: "the temporary and ported numbers are the same — refusing" };
  }

  const matches = input.tenantRoutes.filter((r) => String(r.did || "").replace(/\D/g, "") === temp);
  if (matches.length === 0) {
    return { action: "skip", reason: "no leftover route for the temporary number — nothing to clean up" };
  }
  if (matches.length > 1) {
    return {
      action: "skip",
      reason: `${matches.length} routes carry the temporary number ${temp} — a person should decide which to remove`,
    };
  }
  const route = matches[0];

  // Never remove the route the customer's real number arrives on.
  const portedRoute = input.tenantRoutes.find((r) => String(r.did || "").replace(/\D/g, "") === ported);
  if (portedRoute && portedRoute.routeId === route.routeId) {
    return { action: "skip", reason: "that route carries the ported number — refusing" };
  }

  if (route.destinationId == null) {
    return {
      action: "skip",
      reason: `route ${route.routeId} has no destination row — cannot prove deleting it is safe`,
    };
  }

  // ⛔ The inii mini guard.
  const sharers = input.allRoutes.filter(
    (r) => r.destinationId === route.destinationId && r.routeId !== route.routeId,
  );
  if (sharers.length > 0) {
    const who = sharers.map((r) => `${r.routeId}:${r.did}`).join(", ");
    return {
      action: "skip",
      reason:
        `route ${route.routeId} shares destination row ${route.destinationId} with ${who} — ` +
        "deleting it would cascade that row and break the other number. Give the live route its own destination row first.",
    };
  }

  return {
    action: "delete",
    routeId: route.routeId,
    destinationId: route.destinationId,
    reason: `route ${route.routeId} (${route.did}) owns destination row ${route.destinationId} alone`,
  };
}

/**
 * The panel's two-step delete: ask, then re-post the confirmation form's hidden
 * inputs. Same contract the wipe scripts use for tenants/trunks/ARS; a
 * single-step delete answers success and deletes nothing.
 */
export async function deleteInboundRouteViaPanel(s: PanelSession, routeId: string): Promise<void> {
  const r = await s.post([
    ["class", "inbound_route"],
    ["method", "delete"],
    ["mode", "delete"],
    ["data", routeId],
  ]);
  const html = String((r as any).json?.html || "");
  if (/module-error-list/i.test(html)) {
    const items = (html.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || []).map((x) => x.replace(/<[^>]+>/g, " ").trim());
    throw new Error(`panel refused the delete: ${items.join(" | ")}`);
  }
  if (!/confirmation-modal/i.test(html)) {
    throw new Error(`unexpected delete response: ${String((r as any).text || "").slice(0, 200)}`);
  }
  const pairs: Array<[string, string]> = [];
  for (const m of html.matchAll(/<input\b[^>]*type=["']hidden["'][^>]*>/gi)) {
    const n = (m[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const v = (m[0].match(/value=["']([^"']*)["']/i) || [])[1] || "";
    if (n) pairs.push([n, v]);
  }
  if (!pairs.length) throw new Error("confirmation modal carried no hidden inputs");
  const r2 = await s.post(pairs);
  if ((r2 as any).json?.notification?.type !== "success") {
    throw new Error(`confirmation failed: ${String((r2 as any).text || "").slice(0, 200)}`);
  }
}

export type TempRouteRetirement = { deleted: boolean; reason: string; routeId?: string };

/**
 * The whole PBX half of retirement, safe to call blind: reads the routes,
 * applies the guard, and only then deletes.
 *
 * ⛔ Never throws. This runs inside port completion, and a customer's port must
 * not be held open by a $3 cleanup — the caller records the reason on the
 * sign-up timeline either way, so a refusal stays visible instead of silent.
 */
export async function retireTempPbxRoute(input: {
  vitalTenantId: string | number;
  tenantPath: string;
  tempDid: string;
  portedDid: string;
  ombuMysqlUrlEncrypted: string | null | undefined;
  connectMysql: typeof import("../pbxQueueDirectory").connectOmbutelMysql;
  openPanel: () => Promise<PanelSession | null>;
}): Promise<TempRouteRetirement> {
  let conn: any = null;
  try {
    const c = await input.connectMysql(input.ombuMysqlUrlEncrypted);
    if (!c.ok) return { deleted: false, reason: `could not read the phone system: ${c.skipReason}` };
    conn = c.conn;
    const { tenantRoutes, allRoutes } = await readRoutesForRetirement(conn, c.schema, input.vitalTenantId);
    const decision = decideTempRouteDeletion({
      tempDid: input.tempDid,
      portedDid: input.portedDid,
      tenantRoutes,
      allRoutes,
    });
    if (decision.action !== "delete") return { deleted: false, reason: decision.reason };

    const session = await input.openPanel();
    if (!session) return { deleted: false, reason: "the phone system panel is not configured here" };
    session.setTenant(input.tenantPath);
    await deleteInboundRouteViaPanel(session, decision.routeId);

    // Believe the database, not the panel's success notification.
    const after = await readRoutesForRetirement(conn, c.schema, input.vitalTenantId);
    if (after.tenantRoutes.some((r) => r.routeId === decision.routeId)) {
      return { deleted: false, reason: `the panel reported success but route ${decision.routeId} is still there` };
    }
    return { deleted: true, reason: decision.reason, routeId: decision.routeId };
  } catch (e: any) {
    return { deleted: false, reason: `phone-system cleanup failed: ${String(e?.message || e).slice(0, 200)}` };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/** Read a tenant's routes plus everything sharing their destination rows. */
export async function readRoutesForRetirement(
  conn: { query: (sql: string, params?: any[]) => Promise<any> },
  schema: string,
  vitalTenantId: string | number,
): Promise<{ tenantRoutes: PbxRouteRow[]; allRoutes: PbxRouteRow[] }> {
  const toRow = (r: any): PbxRouteRow => ({
    routeId: String(r.inbound_route_id),
    did: String(r.did ?? ""),
    destinationId: r.destination_id == null ? null : Number(r.destination_id),
    description: r.description ?? null,
  });

  const [tenantRows] = await conn.query(
    `SELECT inbound_route_id, description, did, destination_id FROM \`${schema}\`.ombu_inbound_routes WHERE tenant_id = ?`,
    [vitalTenantId],
  );
  const tenantRoutes = (tenantRows as any[]).map(toRow);

  const ids = tenantRoutes.map((r) => r.destinationId).filter((v): v is number => v != null);
  if (!ids.length) return { tenantRoutes, allRoutes: [] };

  // Deliberately NOT scoped to the tenant — a shared destination row is exactly
  // the thing we are looking for, and nothing stops it crossing tenants.
  const [allRows] = await conn.query(
    `SELECT inbound_route_id, description, did, destination_id FROM \`${schema}\`.ombu_inbound_routes WHERE destination_id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  return { tenantRoutes, allRoutes: (allRows as any[]).map(toRow) };
}
