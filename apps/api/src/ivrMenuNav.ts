/**
 * Submenu navigation refs — how "press N → another menu" actually reaches a
 * menu at call time.
 *
 * History: the Studio stored "Another menu" destinations as
 * `connect-tenant-ivr,<profileId>,1`. That context only matches DIGIT extens
 * (`_X!`), so a cuid exten matched nothing and every submenu key was dead on
 * the live dialplan. The real engine is the additive [connect-menu] context
 * (scripts/pbx/patch-connect-menu.sh), which reads per-menu AstDB families
 * `connect/t_<slug>/menu/<profileId>/*` published by buildIvrKeys.
 *
 * Menu extens carry an `m` prefix (`connect-menu,m<profileId>,1`) ON
 * PURPOSE: without it, single digit presses inside a menu are a prefix of the
 * menu-id pattern and Asterisk holds every keypress for the inter-digit
 * timeout before matching. The prefix keeps digit matching instant. It is
 * deliberately hyphen-free — Asterisk strips '-' during pattern matching
 * (an `_m-.` pattern displays and matches as `_m.`), which burned the first
 * patch attempt's verify step.
 *
 * Stored rows are NOT migrated — refs are rewritten at publish time, so
 * every already-saved menu heals on its next publish and the Studio's save
 * format stays untouched.
 */

export const MENU_EXTEN_PREFIX = "m";

/** The Goto ref that enters a menu through the submenu engine. */
export function menuEntryRef(profileId: string): string {
  return `connect-menu,${MENU_EXTEN_PREFIX}${profileId},1`;
}

/** Rewrite a stored destination ref for the live dialplan.
 *
 *  - "ivr"-typed refs `connect-tenant-ivr,<profileId>,1` (a cuid exten the
 *    top context can never match) → the submenu engine. Digit extens and the
 *    literal `s` are left alone — those are real extens in the top context.
 *  - Inside a per-menu family, recording refs must run the per-menu
 *    play-prompt variant (the tenant-global one reads the wrong opt keys).
 *
 *  Every other ref passes through byte-identical. */
export function rewriteMenuNavRef(
  destinationType: string | null | undefined,
  ref: string | null | undefined,
  opts: { inMenuFamily: boolean },
): string {
  const value = String(ref ?? "").trim();
  if (!value) return value;
  if (destinationType === "ivr") {
    const m = value.match(/^connect-tenant-ivr,([^,]+),\d+$/);
    if (m && m[1] !== "s" && !/^\d+$/.test(m[1])) {
      return menuEntryRef(m[1]);
    }
    return value;
  }
  if (opts.inMenuFamily && destinationType === "announcement" && value.startsWith("connect-play-prompt,")) {
    return value.replace(/^connect-play-prompt,/, "connect-menu-play-prompt,");
  }
  return value;
}
