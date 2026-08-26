/**
 * CRM modes (supermarket plan Phase 2). Every tenant has a mode; "classic"
 * (the default) is byte-identical to life before modes existed. "supermarket"
 * opens the supermarket cockpit — and closes the cold-calling campaign
 * surface for that tenant, SERVER-SIDE.
 *
 * ⛔ The mode is enforced on the server on every gated path, never only hidden
 * in menus (the plan's non-negotiable). Two directions, both here:
 *  - supermarket surfaces require mode === "supermarket";
 *  - the cold-calling campaign prefixes refuse for a supermarket tenant.
 *
 * ⛔ Fail directions differ on purpose:
 *  - requireSupermarketMode fails CLOSED (a lookup error refuses — a
 *    supermarket door must never open for a classic tenant by accident);
 *  - the campaign-block hook fails OPEN (a lookup error changes nothing —
 *    a transient DB blip must never break every classic tenant's CRM).
 */

export const CRM_MODES = ["classic", "supermarket"] as const;
export type CrmMode = (typeof CRM_MODES)[number];

/**
 * Cold-calling surfaces parked behind classic mode. Deliberately narrow: the
 * campaign machinery is the cold-calling core; chat/SMS/contacts stay open in
 * every mode (Gesheft lives in those).
 */
export const CLASSIC_ONLY_PREFIXES = ["/crm/campaigns", "/admin/sms/campaigns"] as const;

const MODE_CACHE_TTL_MS = 60_000;
const modeCache = new Map<string, { mode: CrmMode; at: number }>();

export function clearCrmModeCache(): void {
  modeCache.clear();
}

export async function tenantCrmMode(db: any, tenantId: string): Promise<CrmMode> {
  const hit = modeCache.get(tenantId);
  if (hit && Date.now() - hit.at < MODE_CACHE_TTL_MS) return hit.mode;
  const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { crmMode: true } });
  const mode: CrmMode = row?.crmMode === "supermarket" ? "supermarket" : "classic";
  modeCache.set(tenantId, { mode, at: Date.now() });
  return mode;
}

/**
 * Gate for supermarket routes. Returns the mode when allowed, or answers 403
 * and returns null. SUPER_ADMIN passes regardless (the owner must be able to
 * look at any tenant's screens while setting them up).
 */
export async function requireSupermarketMode(
  db: any,
  req: any,
  reply: any,
): Promise<CrmMode | null> {
  const user = req?.user ?? {};
  const tenantId = String(user.tenantId ?? "");
  if (user.role === "SUPER_ADMIN") return "supermarket";
  if (!tenantId) {
    reply.status(403).send({ error: "forbidden" });
    return null;
  }
  let mode: CrmMode;
  try {
    mode = await tenantCrmMode(db, tenantId);
  } catch {
    reply.status(503).send({ error: "service_unavailable" });
    return null;
  }
  if (mode !== "supermarket") {
    reply.status(403).send({ error: "wrong_crm_mode", message: "This company is not set up for supermarket mode." });
    return null;
  }
  return mode;
}

/**
 * Pure decision for the campaign-block hook: should this request be refused?
 * Split out so the stress suite can sweep it exhaustively.
 */
export function decideCampaignBlock(input: {
  path: string;
  role: string | undefined;
  mode: CrmMode;
}): boolean {
  if (input.role === "SUPER_ADMIN") return false;
  if (input.mode !== "supermarket") return false;
  const path = input.path.startsWith("/api/") ? input.path.slice(4) : input.path;
  return CLASSIC_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Fastify preHandler that parks the cold-calling surface for supermarket
 * tenants. Registered once from server.ts. Skips anonymous requests (public
 * routes carry no tenant) and fails OPEN on lookup errors.
 */
export function crmModeEnforcementHook(db: any) {
  return async (req: any, reply: any) => {
    const user = req?.user;
    if (!user?.tenantId) return;
    const rawPath = String(req.url ?? "").split("?")[0];
    // Cheap prefix test BEFORE any db read — this hook rides every request.
    const path = rawPath.startsWith("/api/") ? rawPath.slice(4) : rawPath;
    if (!CLASSIC_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return;
    let mode: CrmMode = "classic";
    try {
      mode = await tenantCrmMode(db, String(user.tenantId));
    } catch {
      return; // fail open — a DB blip must not break classic CRM
    }
    if (decideCampaignBlock({ path: rawPath, role: user.role, mode })) {
      reply
        .status(403)
        .send({ error: "wrong_crm_mode", message: "Cold-calling campaigns are switched off in supermarket mode." });
    }
  };
}
