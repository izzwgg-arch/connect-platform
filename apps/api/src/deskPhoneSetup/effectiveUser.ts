/**
 * WHOSE PHONES a desk-phone request is about.
 *
 * Izzy, 2026-09-18: "from the super admin account, I can run the wizard for any customer
 * just by selecting the tenant dropdown… if I'm at the tenant's location, connected to
 * their network, I can just run the wizard for them from my computer."
 *
 * The portal's tenant switcher already sends `x-tenant-context: <tenant uuid>` on every
 * api call while a super-admin is acting as a tenant (`browserTenantContext()` in
 * apiClient.ts), and other doors honour it (`getEffectiveEmailTenantId`, chat). The
 * desk-phone doors read `req.user.tenantId` — the admin's OWN tenant — so the run, the
 * extensions, the provisioning folder and the PnP responder's pending list were all
 * Loopcom's, not the customer's. This is the one place that decides, for every
 * desk-phone route (the routes file's `getUser`, and the managed-phone panel's `actor`).
 *
 * ⛔ SUPER_ADMIN ONLY. A tenant admin's header is ignored: their token's tenant is the
 * only tenant they may touch, and ownership checks (`ownRun`) stay tenant-scoped.
 * ⛔ The tenant id is validated by SHAPE only (a UUID); a wrong id simply owns nothing
 * and every ownership check 404s. Nothing here grants — it only chooses the scope the
 * existing gates then enforce.
 */

export type DeskPhoneUser = { sub: string; tenantId: string; email: string; role: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantContextOf(req: any): string | null {
  const raw = String(req?.headers?.["x-tenant-context"] ?? "").trim();
  return UUID.test(raw) ? raw : null;
}

/** The request's user, with `tenantId` = the selected tenant when a super-admin is acting as one. */
export function effectiveDeskPhoneUser(req: any): DeskPhoneUser {
  const u = req?.user as DeskPhoneUser | undefined;
  if (!u) return u as any;
  if (String(u.role ?? "").toUpperCase() !== "SUPER_ADMIN") return u;
  const ctx = tenantContextOf(req);
  if (!ctx || ctx === u.tenantId) return u;
  return { ...u, tenantId: ctx };
}
