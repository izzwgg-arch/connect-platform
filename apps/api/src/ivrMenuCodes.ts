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

export interface AstDbKeyValue { family: string; key: string; value: string }

/**
 * The per-menu code slate for one publish: `has_codes` plus
 * `code_<digits>/dest|type` for every code-shaped option row.
 *
 * Pure so it can be driven exhaustively — buildIvrKeys (server.ts) is inside
 * a module no test can import without booting the whole api. `refFor` is the
 * caller's ref pipeline (rewriteMenuNavRef ∘ normalizeTenantDestinationRef);
 * a DISABLED row still gets its slots written as "" so switching a code off
 * clears it on the very next publish.
 *
 * Rows are deduped by code, LAST wins — the same rule the fixed digit slate
 * applies via its Map. The DB's @@unique([profileId, optionDigit]) means a
 * duplicate can't happen through Prisma, but this function must not emit a
 * contradictory slate no matter what it is handed.
 */
export function buildMenuCodeKeys<T extends { optionDigit: string; enabled: boolean; destinationType: string }>(
  menuFam: string,
  rows: T[],
  refFor: (row: T) => string,
): AstDbKeyValue[] {
  const byCode = new Map<string, T>();
  for (const o of rows) {
    if (isIvrMenuCode(o.optionDigit)) byCode.set(o.optionDigit, o);
  }
  const codeRows = Array.from(byCode.values());
  const keys: AstDbKeyValue[] = [
    { family: menuFam, key: "has_codes", value: codeRows.some((o) => o.enabled) ? "1" : "0" },
  ];
  for (const opt of codeRows) {
    keys.push(
      { family: menuFam, key: `${ivrMenuCodeKey(opt.optionDigit)}/dest`, value: opt.enabled ? refFor(opt) : "" },
      { family: menuFam, key: `${ivrMenuCodeKey(opt.optionDigit)}/type`, value: opt.enabled ? opt.destinationType : "" },
    );
  }
  return keys;
}

/**
 * "" tombstones for code keys the LAST successful publish wrote and THIS
 * publish no longer carries — i.e. codes whose option row was deleted since.
 * Codes are the one variable-size part of the published key set; every fixed
 * slot self-clears by always being written, but a deleted code's key would
 * otherwise stay in AstDB forever, silently keeping a removed dial-through
 * code answering live calls.
 *
 * Diffed against the previous record's NON-EMPTY values only, so a tombstone
 * written once does not re-propagate through every later publish. Hostile or
 * malformed history rows are skipped, never thrown on — a publish must not be
 * blocked by bookkeeping.
 */
export function diffStaleIvrCodeTombstones(
  previousKeysWritten: unknown,
  currentKeys: Array<{ family: string; key: string }>,
): AstDbKeyValue[] {
  const prev: unknown[] = Array.isArray(previousKeysWritten) ? previousKeysWritten : [];
  const current = new Set(currentKeys.map((k) => `${k.family}|${k.key}`));
  const out: AstDbKeyValue[] = [];
  const seen = new Set<string>();
  for (const raw of prev) {
    const k = raw as { family?: unknown; key?: unknown; value?: unknown } | null;
    if (!k || typeof k.family !== "string" || typeof k.key !== "string") continue;
    if (!/^code_\d+\/(dest|type)$/.test(k.key)) continue;
    if (typeof k.value !== "string" || !k.value.trim()) continue;
    const id = `${k.family}|${k.key}`;
    if (current.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ family: k.family, key: k.key, value: "" });
  }
  return out;
}
