/**
 * SIDEBAR VISIBILITY — the platform owner's own switch for each sidebar page,
 * kept deliberately SEPARATE from the permission that gates the page.
 *
 * WHY THIS EXISTS (Izzy, 2026-08-31): "every single page, I should have a
 * toggle on and off for view in the sidebar, aside from the custom role
 * permission." A role permission answers "may this person use the page"; this
 * answers "does the link appear at all". They cannot be the same control,
 * because several sidebar entries deliberately SHARE one permission key —
 * Direct rides Chat's key, Meetings rides Overview's, Install rides Contacts',
 * and all five Store pages ride can_view_supermarket_orders. With the
 * permission as the only lever, hiding one of those hides its siblings too.
 *
 * ⛔ THIS LAYER CAN ONLY EVER TAKE AWAY, NEVER GRANT. A page switched ON here
 * still needs its section permission AND its own permission; the server-side
 * PORTAL_API_PERMISSION_RULES gate is untouched by anything in this file. So
 * the worst a mistake here can do is hide a link, never expose a page.
 *
 * ⛔ IT ALSO FAILS OPEN. An unreadable or absent setting means "nothing is
 * hidden" — the sidebar behaves exactly as it did before this feature. A
 * storage hiccup must never empty every customer's sidebar.
 */

/**
 * Nav ids that may NEVER be hidden, however the setting is edited.
 *
 * ⛔ The shell denies the ROUTE for a hidden item, not just the link
 * (PageShell computes routeAllowed from the same function) — so hiding the
 * Permissions page would lock the owner out of the only screen that can undo
 * it. `normalizeNavVisibility` drops these from `hidden` on both read and
 * write, so even a hand-edited database row cannot cause that lockout.
 */
export const NAV_ITEMS_ALWAYS_VISIBLE: readonly string[] = ["admin.permissions"];

export type PortalNavVisibility = {
  /** Sidebar pages the owner has switched OFF. Absent id = visible. */
  hidden: string[];
  /**
   * Pages whose built-in "platform owner only" default the owner has
   * deliberately lifted, so an ordinary permission grant can reveal them.
   * ⛔ Lifting one is the LAUNCH of that page to whoever holds its key — it is
   * an explicit action on the Permissions screen and never a side effect.
   */
  ownerOnlyLifted: string[];
};

export const EMPTY_NAV_VISIBILITY: PortalNavVisibility = { hidden: [], ownerOnlyLifted: [] };

const ALWAYS_VISIBLE = new Set<string>(NAV_ITEMS_ALWAYS_VISIBLE);

/** A nav id is a short dotted slug; anything else is ignored rather than trusted. */
const NAV_ID_SHAPE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

function normalizeIdList(input: unknown, dropProtected: boolean): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id.length > 64) continue;
    if (!NAV_ID_SHAPE.test(id)) continue;
    if (dropProtected && ALWAYS_VISIBLE.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}

/**
 * Read a stored value into a usable record. Tolerant on purpose: an older
 * snapshot has no such key at all, and this must degrade to "nothing hidden"
 * rather than throw on the path that renders every user's sidebar.
 */
export function normalizeNavVisibility(raw: unknown): PortalNavVisibility {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...EMPTY_NAV_VISIBILITY };
  const obj = raw as { hidden?: unknown; ownerOnlyLifted?: unknown };
  return {
    hidden: normalizeIdList(obj.hidden, true),
    ownerOnlyLifted: normalizeIdList(obj.ownerOnlyLifted, false),
  };
}

/** True when the owner has switched this sidebar page off for everybody. */
export function isNavItemHiddenBySetting(navItemId: string, visibility?: PortalNavVisibility | null): boolean {
  if (!visibility) return false;
  if (ALWAYS_VISIBLE.has(navItemId)) return false;
  return visibility.hidden.includes(navItemId);
}

/** True when the owner has lifted a page's built-in platform-owner-only default. */
export function isNavItemOwnerOnlyLifted(navItemId: string, visibility?: PortalNavVisibility | null): boolean {
  if (!visibility) return false;
  return visibility.ownerOnlyLifted.includes(navItemId);
}

/** Is anything at all configured? Used to report "defaults" honestly in the UI. */
export function navVisibilityIsEmpty(visibility?: PortalNavVisibility | null): boolean {
  if (!visibility) return true;
  return visibility.hidden.length === 0 && visibility.ownerOnlyLifted.length === 0;
}
