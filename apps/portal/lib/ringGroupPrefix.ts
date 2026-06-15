/**
 * Ring-group CID prefix helpers for the portal — mirror of the mobile app's
 * `splitRingGroupPrefix` in apps/mobile/src/calls/callerIdentity.ts.
 *
 * VitalPBX ring groups prepend a prefix to CALLERID(name) on every pass
 * (`Set(CALLERID(name)=Estimates:${CALLERID(name)})`), so a SIP From display
 * name frequently arrives with the label tripled, e.g.
 * "Estimates:Estimates:Estimates:A PLUS CENTER TEST". We collapse the repeated
 * label down to a single prefix tag and return the clean caller remainder.
 */

function looksLikePstn(value: string): boolean {
  return value.replace(/[^\d]/g, "").length >= 7;
}

export function splitRingGroupPrefix(rawDisplayName: string | null | undefined): {
  prefix: string | null;
  rest: string;
} {
  const name = String(rawDisplayName ?? "").trim();
  const firstColon = name.indexOf(":");
  if (firstColon <= 0) return { prefix: null, rest: name };
  const token = name.slice(0, firstColon).trim();
  // A numeric leading segment is a number, not a ring-group label.
  if (!token || looksLikePstn(token)) return { prefix: null, rest: name };
  const tokenLc = token.toLowerCase();
  let rest = name;
  for (;;) {
    const idx = rest.indexOf(":");
    if (idx <= 0) break;
    if (rest.slice(0, idx).trim().toLowerCase() !== tokenLc) break;
    rest = rest.slice(idx + 1);
  }
  rest = rest.replace(/:\s*$/, "").trim();
  return { prefix: token, rest };
}

/** The deduped ring-group prefix label for a display name, or null. */
export function ringGroupPrefixOf(rawDisplayName: string | null | undefined): string | null {
  return splitRingGroupPrefix(rawDisplayName).prefix;
}
