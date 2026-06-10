/**
 * Normalized caller-identity model + deterministic display helpers.
 *
 * Single source of truth for how the mobile app interprets the caller identity
 * that VitalPBX delivers, so Recent Calls, the Incoming Call screen, and
 * Add-to-Contact all agree.
 *
 * ── What the PBX actually sends (proven from the PBX brain snapshot) ──────────
 * VitalPBX ring groups run, in the inbound dialplan
 * (`extensions__50-9-dialplan.conf`, e.g. ring group "Estimates"):
 *
 *     Set(CALLERID(name)=Estimates:${CALLERID(name)})
 *
 * i.e. the ring-group prefix is PREPENDED to the CallerID *name* with a colon,
 * while CALLERID(num) (the real external PSTN number) is left untouched. The
 * Connect wake hook then forwards BOTH fields verbatim
 * (`extensions__60_custom.conf`):
 *
 *     fromNumber = ${CALLERID(num)}     → the raw external number
 *     fromDisplay = ${CALLERID(name)}   → "Prefix:OriginalCallerName"
 *
 * So the prefix lives inside the display-name field, colon-separated, and the
 * external number is a separate field. Observed display-name shapes:
 *
 *     "New Tires:8453050021"   — no CNAM; PBX put the caller number after ":"
 *     "New Tires:John Smith"   — CNAM available
 *     "New Tires:New Tires:"   — no CNAM; PBX duplicated the group name
 *     "New Tires:"             — empty original caller name
 *     "A PLUS CENTER NY"       — plain CNAM, no ring group prefix (no colon)
 *
 * The fields below keep every piece separate so display logic is deterministic
 * and we NEVER replace the external number with an extension/user name.
 */

export type CallerDirection = "inbound" | "outbound" | "internal" | "unknown";

export interface NormalizedCallerIdentity {
  /** Raw external PSTN number when this party is external, else null. */
  externalNumber: string | null;
  /** Human caller name (CNAM / contact name), prefix-stripped. Never the
   *  logged-in user's own extension/user name for an inbound external call. */
  displayName: string | null;
  /** Ring-group / context prefix the PBX prepended (e.g. "Sales"), else null. */
  ringGroupPrefix: string | null;
  /** Internal extension number when this party is internal, else null. */
  extensionNumber: string | null;
  /** Internal extension/user display name when known, else null. */
  extensionName: string | null;
  /** Raw SIP From user part (uri.user) exactly as received. */
  rawSipCallerId: string | null;
  /** Raw PBX-delivered CallerID name (SIP From display-name), unparsed. */
  rawPbxCallerId: string | null;
  direction: CallerDirection;
}

export interface CallerIdentityInput {
  /** SIP From user part / CALLERID(num) — the external number for inbound. */
  number?: string | null;
  /** SIP From display-name / CALLERID(name) — may carry "Prefix:Caller". */
  displayName?: string | null;
  /** Destination number for outbound calls (the dialed external number). */
  toNumber?: string | null;
  direction?: CallerDirection;
  /** The logged-in user's own extension numbers — never used as the external
   *  caller's display name for an inbound external call. */
  selfExtensionNumbers?: ReadonlyArray<string>;
  /** The logged-in user's own display names (user/extension names). */
  selfNames?: ReadonlyArray<string>;
}

const PSTN_MIN_DIGITS = 7;

function clean(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

function digitsOnly(v: string | null | undefined): string {
  return clean(v).replace(/[^\d]/g, "");
}

/** True when the value looks like a short internal extension (2–6 digits). */
export function looksLikeExtension(v: string | null | undefined): boolean {
  const t = clean(v);
  return /^\+?\d{2,6}$/.test(t) && digitsOnly(t).length <= 6;
}

/** True when the value looks like an external PSTN number (>= 7 digits). */
export function looksLikePstn(v: string | null | undefined): boolean {
  return digitsOnly(v).length >= PSTN_MIN_DIGITS;
}

/**
 * Split a PBX display-name into its ring-group prefix and the remaining caller
 * info. Only the FIRST colon is treated as the prefix separator. A trailing
 * colon (the "New Tires:" empty-CNAM shape) is stripped from the remainder.
 *
 * Returns prefix=null when there is no colon, or when the part before the colon
 * is itself a phone number (so we don't mistake "1:2" style junk for a prefix).
 */
export function splitRingGroupPrefix(rawDisplayName: string | null | undefined): {
  prefix: string | null;
  rest: string;
} {
  const name = clean(rawDisplayName);
  const colonIdx = name.indexOf(":");
  if (colonIdx <= 0) return { prefix: null, rest: name };
  const prefix = name.slice(0, colonIdx).trim();
  // A numeric "prefix" is not a ring-group label — treat whole thing as caller.
  if (!prefix || looksLikePstn(prefix)) return { prefix: null, rest: name };
  const rest = name
    .slice(colonIdx + 1)
    .replace(/:\s*$/, "")
    .trim();
  return { prefix, rest };
}

function matchesAny(value: string, list: ReadonlyArray<string> | undefined): boolean {
  if (!value || !list || list.length === 0) return false;
  const v = value.trim().toLowerCase();
  const vDigits = digitsOnly(value);
  return list.some((entry) => {
    const e = clean(entry).toLowerCase();
    if (e && e === v) return true;
    const eDigits = digitsOnly(entry);
    return eDigits.length > 0 && eDigits === vDigits;
  });
}

/**
 * Build the normalized identity of the *remote* party of a call.
 *
 * Deterministic rules:
 *  - internal call (both ends extension-shaped, or direction="internal"):
 *      extensionNumber/extensionName populated, externalNumber=null.
 *  - inbound external: externalNumber is the real PSTN number; ringGroupPrefix
 *      is extracted from the display name; displayName is the CNAM (or null).
 *      The external number is NEVER replaced by a name, and the logged-in
 *      user's own extension/name is NEVER used as the caller's displayName.
 *  - outbound: externalNumber is the dialed number; displayName is the
 *      resolved contact name (if any).
 */
export function normalizeCallerIdentity(input: CallerIdentityInput): NormalizedCallerIdentity {
  const rawSipCallerId = clean(input.number) || null;
  const rawPbxCallerId = clean(input.displayName) || null;
  const direction: CallerDirection = input.direction ?? "unknown";
  const { prefix, rest } = splitRingGroupPrefix(input.displayName);

  const base: NormalizedCallerIdentity = {
    externalNumber: null,
    displayName: null,
    ringGroupPrefix: prefix,
    extensionNumber: null,
    extensionName: null,
    rawSipCallerId,
    rawPbxCallerId,
    direction,
  };

  // ── Outbound: the remote party is the dialed number ──────────────────────
  if (direction === "outbound") {
    const dialed = clean(input.toNumber) || clean(input.number);
    if (looksLikeExtension(dialed) && !looksLikePstn(dialed)) {
      return { ...base, extensionNumber: dialed || null, extensionName: rest || null };
    }
    return {
      ...base,
      externalNumber: dialed || null,
      displayName: rest && !looksLikePstn(rest) ? rest : null,
    };
  }

  const fromNumber = clean(input.number);
  const toNumber = clean(input.toNumber);

  // ── Internal: extension → extension ───────────────────────────────────────
  const internalByShape =
    looksLikeExtension(fromNumber) &&
    (toNumber === "" || looksLikeExtension(toNumber)) &&
    !looksLikePstn(fromNumber);
  if (direction === "internal" || (direction !== "inbound" && internalByShape)) {
    return {
      ...base,
      extensionNumber: fromNumber || null,
      extensionName: rest && !looksLikePstn(rest) ? rest : null,
      ringGroupPrefix: prefix,
    };
  }

  // ── Inbound external (and unknown that isn't extension-shaped) ────────────
  // Prefer the SIP user/number field for the external number — that is
  // CALLERID(num) and is the most authoritative source of the real number.
  let externalNumber: string | null = looksLikePstn(fromNumber) ? fromNumber : null;

  // The "rest" of the display name can itself be a phone number (the
  // "New Tires:8453050021" shape when there is no CNAM). Use it as the
  // external number when the SIP user field didn't give us a PSTN number.
  const restIsNumber = looksLikePstn(rest);
  if (!externalNumber && restIsNumber) externalNumber = rest;

  // displayName = the CNAM part, only when it is a real name (not a number,
  // not a duplicate of the prefix, not our own identity).
  let displayName: string | null = null;
  if (rest && !restIsNumber && rest !== prefix) {
    displayName = rest;
  }
  // If there was no colon prefix at all, the whole display name is a CNAM.
  if (!prefix && rawPbxCallerId && !looksLikePstn(rawPbxCallerId)) {
    displayName = rawPbxCallerId;
  }

  // Guard: never present the logged-in user's own extension/name as the
  // inbound external caller. Drop it and fall back to the external number.
  if (
    displayName &&
    (matchesAny(displayName, input.selfNames) ||
      matchesAny(displayName, input.selfExtensionNumbers))
  ) {
    displayName = null;
  }

  return {
    ...base,
    externalNumber,
    displayName,
    ringGroupPrefix: prefix,
  };
}

export interface CallerDisplayLines {
  /** Primary line: contact/caller name, else the external number. */
  primary: string;
  /** Secondary line: the external number (when primary is a name), else null. */
  secondary: string | null;
  /** Ring-group prefix badge text, else null. */
  prefixBadge: string | null;
}

/**
 * Deterministic two-line display for a normalized identity.
 *
 *  - inbound external: primary = name || number; secondary = number (when
 *    primary is a name); prefixBadge = ring-group prefix.
 *  - internal: primary = extension name || "Ext N"; secondary = "Ext N".
 *  - outbound: primary = name || number; secondary = number when primary name.
 *
 * The external phone number is always surfaced (primary or secondary) and is
 * never hidden behind a name.
 */
export function callerDisplayLines(identity: NormalizedCallerIdentity): CallerDisplayLines {
  const prefixBadge = identity.ringGroupPrefix || null;

  if (identity.extensionNumber && !identity.externalNumber) {
    const extLabel = `Ext ${identity.extensionNumber}`;
    return {
      primary: identity.extensionName || extLabel,
      secondary: identity.extensionName ? extLabel : null,
      prefixBadge,
    };
  }

  const number = identity.externalNumber || identity.rawSipCallerId || "";
  if (identity.displayName) {
    return {
      primary: identity.displayName,
      secondary: number && number !== identity.displayName ? number : null,
      prefixBadge,
    };
  }

  return {
    primary: number || "Unknown",
    secondary: null,
    prefixBadge,
  };
}

/**
 * The best phone number to save / call back for this party. Prefers the real
 * external PSTN number, falls back to an internal extension, then the raw SIP
 * caller id. Returns null when there is no usable number.
 */
export function callbackNumber(identity: NormalizedCallerIdentity): string | null {
  if (identity.externalNumber && looksLikePstn(identity.externalNumber)) {
    return identity.externalNumber;
  }
  if (identity.extensionNumber) return identity.extensionNumber;
  const rawDigits = digitsOnly(identity.rawSipCallerId);
  if (rawDigits.length >= PSTN_MIN_DIGITS) return identity.rawSipCallerId;
  if (identity.externalNumber) return identity.externalNumber;
  return null;
}

/** A clean contact name suggestion (prefix/own-name stripped), or null. */
export function suggestedContactName(identity: NormalizedCallerIdentity): string | null {
  if (identity.displayName && !looksLikePstn(identity.displayName)) return identity.displayName;
  if (identity.extensionName) return identity.extensionName;
  return null;
}
