import { capitalizeNameWords, resolvePersonDisplayName, stripExtensionNumberPrefix } from "@connect/shared";

/**
 * Portal-side wrapper over the ONE naming rule in
 * `packages/shared/src/personDisplayName.ts`: **the PBX extension name is always
 * the source of truth.** Keep the decision there, not here — apps/api resolves
 * the same question for emails, and the two drifting apart is exactly how 55 of
 * 65 customers ended up being greeted by their email address.
 */

type ExtensionNameSource = {
  displayName?: string | null;
  name?: string | null;
  label?: string | null;
} | null | undefined;

type UserNameSource = {
  name?: string | null;
  email?: string | null;
  extensionDisplayName?: string | null;
  extension?: string | null | ExtensionNameSource;
} | null | undefined;

function cleanDisplayValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function formatUserNameFallback(name?: string | null, email?: string | null): string {
  const base = resolvePersonDisplayName({ displayName: name, email }, "User");
  // Long trailing digit runs are account-number noise, not a name.
  return base.replace(/\d{6,}$/, "") || base;
}

export function getExtensionDisplayName(source?: ExtensionNameSource | string | null): string | null {
  // ⛔ Capitalised here, not at the call sites — this is the path the sidebar,
  // profile menu and dashboard all take, and "baila" must read "Baila" on every
  // one of them.
  if (typeof source === "string") {
    return capitalizeNameWords(stripExtensionNumberPrefix(source)) || null;
  }
  const candidates = [source?.displayName, source?.name, source?.label];
  for (const candidate of candidates) {
    const value = capitalizeNameWords(stripExtensionNumberPrefix(cleanDisplayValue(candidate)));
    if (value) return value;
  }
  return null;
}

/**
 * What every portal surface should call a person. Prefers the PBX name; falls
 * back to a stored name and only then to the email address.
 *
 * ⛔ Returns the WHOLE name. Do not take `.split(" ")[0]` off it at a call site
 * — that turns "Front Desk" into "Front" and "Mrs. Halpert" into "Mrs.".
 */
export function getPreferredUserDisplayName(user: UserNameSource): string {
  const extensionName =
    getExtensionDisplayName(user?.extensionDisplayName) ||
    (typeof user?.extension === "object" ? getExtensionDisplayName(user.extension) : null);
  return extensionName || formatUserNameFallback(user?.name, user?.email);
}
