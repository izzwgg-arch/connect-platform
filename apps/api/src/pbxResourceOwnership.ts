/**
 * Ownership rules for the raw VitalPBX resource write routes
 * (`PATCH`/`DELETE /voice/pbx/resources/:resource/:id`, server.ts).
 *
 * ⛔ Audit finding §6h (2026-08-17): those routes took the caller's OWN
 * `tenantPbxLink` for the PBX instance, then passed the resource `:id` straight
 * to VitalPBX with the platform app-key. For `extensions`, `ring-groups`, `ivr`,
 * `routes`, `trunks` and `tenants` no tenant scope reached the PBX call, so a
 * caller who could reach the route could update or delete ANOTHER company's
 * record by id — including `DELETE …/tenants/<other customer>`.
 *
 * It was latent, not live: `TENANT_ADMIN` is absent from
 * `VITALPBX_ROLE_PERMISSIONS`, so it falls back to the view-only `USER` set, and
 * there are zero `ADMIN`-role users. Zero PATCH/DELETE hits in 14 days of nginx
 * logs (3,438 GETs). Fixed anyway — one `ADMIN` user arms it.
 *
 * The rule needs no knowledge of VitalPBX's per-resource field names: before a
 * non-SUPER_ADMIN write, the caller's own PBX tenant's list of that resource is
 * fetched (the GET route already does exactly that) and the write is refused
 * unless the id appears in it. `tenants` and `trunks` are refused outright for
 * non-supers — a customer must never write a tenant record, and every trunk on
 * this PBX lives in the Main tenant.
 */

/** Resources a non-SUPER_ADMIN may never write, whatever the role table says. */
export const SUPER_ONLY_VITAL_WRITE_RESOURCES: ReadonlySet<string> = new Set(["tenants", "trunks"]);

/**
 * Does any row in the tenant's own list carry this id in an id-shaped field?
 * Rows are VitalPBX's raw JSON, so the id key varies (`id`, `extension_id`,
 * `ivr_id`, `ring_group_id`, …). Any key that IS `id` or ENDS IN `_id` counts;
 * matching is by string equality. Fails closed on anything that is not a row.
 */
export function vitalResourceRowsContainId(rows: unknown, id: string): boolean {
  const target = String(id ?? "").trim();
  if (!target || !Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (key !== "id" && !key.endsWith("_id") && !key.endsWith("Id")) continue;
      if (value == null) continue;
      if (typeof value === "object") continue;
      if (String(value).trim() === target) return true;
    }
  }
  return false;
}

export type VitalWriteDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * The whole decision, pure. `ownRows` is the caller's tenant-scoped list for
 * this resource (or null when it could not be fetched — which is a refusal,
 * never a pass).
 */
export function decideVitalResourceWrite(input: {
  isSuperAdmin: boolean;
  resource: string;
  id: string;
  hasPbxTenantId: boolean;
  ownRows: unknown | null;
}): VitalWriteDecision {
  if (input.isSuperAdmin) return { ok: true };
  if (SUPER_ONLY_VITAL_WRITE_RESOURCES.has(input.resource)) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (!input.hasPbxTenantId) {
    // A link with no PBX tenant cannot be scoped — refuse rather than pass a raw id through.
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (input.ownRows == null) return { ok: false, status: 403, error: "forbidden" };
  if (!vitalResourceRowsContainId(input.ownRows, input.id)) {
    // A foreign record must answer exactly like a record that does not exist.
    return { ok: false, status: 404, error: "not_found" };
  }
  return { ok: true };
}
