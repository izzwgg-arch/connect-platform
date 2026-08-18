/**
 * Give a new tenant a name nobody else already has.
 *
 * ⛔ WHY. Two live tenants were both called "Connect Communications" for months,
 * and on 2026-08-18 a sign-up created a second "a plus center" beside the real
 * one from April. Duplicate names are not cosmetic here:
 *   - `docs/agent-knowledge` filenames are derived from the tenant name, so the
 *     second tenant's knowledge document silently OVERWRITES the first's
 *     (buildSlugMap already carries a special case for exactly this);
 *   - every "look the customer up by name" query becomes ambiguous, and support
 *     has no way to tell which row is which;
 *   - the tenant switcher shows two identical rows.
 *
 * Izzy's rule, 2026-08-18: when two companies share a name, number them.
 * The FIRST holder keeps its name untouched — renaming an existing customer to
 * add a "1" would change what staff and their own screens already call them —
 * so the newcomer starts at 2: "a plus center", then "a plus center 2", "3"…
 *
 * ⛔ REMOVED TENANTS STILL COUNT. A tenant with `pbxRemovedAt` set is hidden
 * from the screens but still answers a name lookup (see CLAUDE.md,
 * "removed tenants still answer name lookups"), so reusing its exact name
 * recreates the ambiguity this function exists to prevent.
 *
 * ⛔ Best-effort against a simultaneous race: `Tenant.name` has no unique
 * index (it cannot get one — duplicates already exist in production), so two
 * sign-ups landing in the same instant could still pick the same suffix. That
 * is acceptable; the case this guards is two customers who happen to share a
 * name, not a thundering herd.
 */

/** Where the numbering starts. The first holder is "1" by implication. */
const FIRST_SUFFIX = 2;

/** Stop rather than spin forever if something is pathologically wrong. */
const MAX_ATTEMPTS = 200;

export type TenantNameLookup = {
  tenant: { findFirst: (args: any) => Promise<{ id: string } | null> };
};

/**
 * `desired` with a numeric suffix appended only if it is already taken.
 * Comparison is case-insensitive and ignores surrounding whitespace, so
 * "A plus center" and "a plus center" collide, which is the point.
 */
export async function uniqueTenantName(db: TenantNameLookup, desired: string): Promise<string> {
  const base = String(desired ?? "").trim().replace(/\s+/g, " ");
  if (!base) return base;

  const taken = async (name: string): Promise<boolean> => {
    // `mode: "insensitive"` on `equals` is the exact-but-case-blind match;
    // `contains` would wrongly collide "Acme" with "Acme Holdings".
    const hit = await db.tenant.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    return !!hit;
  };

  if (!(await taken(base))) return base;

  for (let n = FIRST_SUFFIX; n < FIRST_SUFFIX + MAX_ATTEMPTS; n++) {
    const candidate = `${base} ${n}`;
    if (!(await taken(candidate))) return candidate;
  }
  // Nothing free in 200 tries — hand back the base rather than block a paid
  // sign-up over a naming nicety. A duplicate name is survivable; a refused
  // checkout is not.
  return base;
}
