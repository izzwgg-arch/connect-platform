/**
 * Shared helpers for normalizing Asterisk channel / peer / context strings into
 * the plain 3-digit (or 2-6 digit) dialplan extension. These are the single
 * source of truth for:
 *   - CallStateStore.call.extensions  (live call → owning extension)
 *   - ExtensionStateStore keys        (ExtensionStatus / PeerStatus → extension)
 *   - any downstream diagnostic / tenant-mapping code
 *
 * Why this exists: raw channel strings from VitalPBX often carry tenant
 * prefixes or uniqueid suffixes (e.g. `PJSIP/T11_105-00002d2a`). Before this
 * helper we captured the whole `T11_105` token which then never matched the
 * Connect directory's 3-digit `extNumber`, breaking BLF↔live-call agreement.
 */

const VALID_EXT = /^\d{2,6}$/;

/**
 * Extracts the dialplan extension from a channel or peer string. Returns the
 * bare digits (e.g. "105") when the channel clearly represents a SIP endpoint
 * associated with an extension, or null for trunks / helper channels / unknown
 * formats. Safe to call on any non-empty string.
 *
 * Accepted shapes:
 *   PJSIP/105                   → "105"
 *   SIP/105-000b1               → "105"
 *   PJSIP/105@host              → "105"
 *   PJSIP/T11_105-00002d2a      → "105"   (strip VitalPBX T-prefix)
 *   PJSIP/T11_105               → "105"
 *   Local/105@from-internal;1   → "105"
 *   Local/105@T11_ivr-only-ext  → "105"
 *   IAX2/1001                   → "1001"
 *   105                         → "105"   (already-bare digits pass through)
 *
 * Rejected (returns null):
 *   PJSIP/344022_gesheft-XXXX   → null    (trunk: multi-digit prefix + slug)
 *   PJSIP/provider-fqdn         → null    (non-numeric)
 *   mixing/ConfBridge/...        → null
 */
export function normalizeExtensionFromChannel(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // Helper channels never represent a subscriber extension.
  if (/^(?:mixing|Multicast|ConfBridge|Message|AsyncGoto)\//i.test(raw)) return null;

  // 1. Strip any leading driver prefix (PJSIP/, SIP/, IAX2/, Local/).
  let token = raw.replace(/^(?:PJSIP|SIP|IAX2?|Local)\//i, "");

  // 2. Strip any `@host` portion (PJSIP/105@ip, Local/105@from-internal;prio).
  const atIdx = token.indexOf("@");
  if (atIdx >= 0) token = token.slice(0, atIdx);

  // 3. Strip trailing uniqueid suffix introduced by Asterisk (`-00002d2a`, `-000b1`).
  //    The uniqueid tail is always `-<hex>` with 4+ chars; a real subscriber
  //    extension on VitalPBX is never formatted with a `-hex` suffix.
  token = token.replace(/-[0-9a-f]{3,}$/i, "");

  // 4. Drop trailing `;<digit>` priority marker that Local/ channels use.
  token = token.replace(/;[\d]+$/, "");

  // 5. Peel a VitalPBX tenant prefix (e.g. `T11_105` → `105`). The prefix is
  //    always `[A-Za-z]+digits+_` — anything else is NOT a tenant prefix.
  const tenantPrefixed = /^[A-Za-z]\d+_(\d{2,6})$/.exec(token);
  if (tenantPrefixed) return tenantPrefixed[1] ?? null;

  // 6. Already a bare extension? Accept 2-6 digits.
  if (VALID_EXT.test(token)) return token;

  return null;
}

/**
 * Returns true when the given string looks like a dialed extension rather than
 * a PSTN number, feature code, or helper target. Used to decide whether to
 * push `exten` into `call.extensions`.
 */
export function looksLikeExtension(input: string | null | undefined): boolean {
  if (!input) return false;
  const s = String(input).trim();
  if (!s) return false;
  // Feature codes and dialplan helpers we don't want to treat as extensions.
  if (s === "s" || s === "h" || s === "t" || s === "i" || s === "o") return false;
  if (s.startsWith("*") || s.startsWith("#")) return false;
  return VALID_EXT.test(s);
}
