// ── Hidden menu dial codes ───────────────────────────────────────────────────
//
// A "code" is a multi-digit string a caller types AT a menu to jump straight
// through — B Visible's 0478 (dial-through/DISA) and 55648752 (straight to
// voicemail box 101), Gesheft's 750/13132 (queue), etc. VitalPBX menus have
// always supported these; until 2026-08-25 a Connect menu could not hold one,
// which is why the IVR migration filed every one under "Connect can't
// reproduce these".
//
// A code is stored as an ordinary IvrOptionRoute row whose optionDigit IS the
// code (the column is a plain string, so no migration was needed). At publish
// time buildIvrKeys writes it into the per-menu AstDB family as
//   connect/t_<slug>/menu/<profileId>/code_<digits>/dest  (Goto-able ref)
//   connect/t_<slug>/menu/<profileId>/code_<digits>/type  (destination type)
// plus a per-menu `has_codes` flag that widens TIMEOUT(digit) to 1s so a
// caller can actually type the whole code. The [connect-menu] dialplan
// (scripts/pbx/patch-connect-menu-codes.sh) checks code_<EXTEN>/dest FIRST on
// its _XXX.._XXXXXXXX patterns and routes a hit through [connect-exit-router]
// — the identical Goto target the PBX's own literal exten used, so a carried
// code behaves byte-for-byte like it did before the migration.
//
// ⛔ The length range here MUST match the dialplan's pattern set (_XXX through
// _XXXXXXXX = 3..8 digits). Widening this regex without adding dialplan
// patterns ships codes that can never fire — the caller types them and gets
// "that option is invalid". Every real code on the estate (measured
// 2026-08-24) is 3–8 digits: 750, 303 (3), 0478/1818/1159/7879/1708 (4),
// 13132 (5), 55648752 (8).
//
// ⛔ Codes are matched BEFORE direct dial in the dialplan, so a code that
// equals an extension number shadows dialling that extension from that menu.
// The migration never creates that shape (extension-numbered shortcuts go the
// dial-by-extension route instead), but a hand-built one would — same
// precedence a literal exten has over a pattern in VitalPBX's own menus.

export const IVR_MENU_CODE_REGEX = /^\d{3,8}$/;

/** True when an IvrOptionRoute.optionDigit is a hidden multi-digit code rather
 *  than a keypad key ("0".."9" | "star" | "hash"). Single digits fail the
 *  length floor, so the fixed digit slate and the code set can never overlap. */
export function isIvrMenuCode(value: string | null | undefined): boolean {
  return IVR_MENU_CODE_REGEX.test(String(value ?? ""));
}

/** The AstDB key prefix for one code, e.g. "code_0478". */
export function ivrMenuCodeKey(code: string): string {
  return `code_${code}`;
}
