/**
 * Who may READ or MODIFY a `TenantSmsNumber` row through the VoIP.ms number
 * admin routes (`connectChatRoutes.ts`).
 *
 * Pure on purpose: the two defects these close were both CALLERS getting the
 * scope wrong, so the guard tests read those call sites' source. A unit test of
 * a route handler's happy path passes straight through either bug.
 *
 * ⛔ Findings §6a and §6b of the 2026-08-17 tenant-isolation audit. Both are
 * LATENT rather than live: the routes gate on that file's `isTenantAdmin()`,
 * which admits only `SUPER_ADMIN` and `ADMIN` — and there are ZERO `ADMIN`-role
 * users on the platform (verified live 2026-08-18: 9 TENANT_ADMIN, 1
 * SUPER_ADMIN, 75 USER, 1 EXTENSION_USER, 0 ADMIN). ⛔ Creating one `ADMIN`
 * user arms both, exactly as §6h describes for the raw-PBX-id routes. The
 * audit's own text says "any tenant admin" for these two — that was read off
 * the helper's NAME, not its contents.
 */

export type SmsNumberScopeInput = {
  /** SUPER_ADMIN sees and edits the whole platform inventory, deliberately. */
  isSuper: boolean;
  /** The actor's effective tenant (`effectiveChatTenantId`). */
  actorTenantId: string | null | undefined;
  /** The row's owner. NULL means an unassigned spare, or a number mid-port. */
  rowTenantId: string | null | undefined;
};

/**
 * May this actor learn that this number exists and who it routes to?
 *
 * ⛔ A number owned by another tenant must read EXACTLY like a number that does
 * not exist. `routing-preview` takes an arbitrary E.164, so anything short of
 * that turns it into a walkable directory of which company owns which DID and
 * which of their staff it rings.
 */
export function canReadSmsNumberRow(input: SmsNumberScopeInput): boolean {
  if (input.isSuper) return true;
  if (!input.actorTenantId) return false;
  return input.rowTenantId === input.actorTenantId;
}

/**
 * May this actor write to this row?
 *
 * ⛔ Strict equality, so a NULL `tenantId` fails. The old guard was
 * `if (row.tenantId && row.tenantId !== effTenant) 403`, which SKIPPED itself
 * on unassigned rows — so an actor could claim a spare platform DID (57 live
 * on 2026-08-18), including one a port-in was landing for another customer, and
 * route its inbound SMS to themselves.
 *
 * ✅ Safe to tighten: the numbers LIST route filters `{ tenantId }` for
 * non-supers, so a non-super is never shown a NULL-tenant row in the first
 * place — no legitimate portal flow claims a spare this way.
 */
export function canModifySmsNumberRow(input: SmsNumberScopeInput): boolean {
  if (input.isSuper) return true;
  if (!input.actorTenantId) return false;
  return input.rowTenantId === input.actorTenantId;
}
