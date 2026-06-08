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
  const rawName = cleanDisplayValue(name);
  const rawEmail = cleanDisplayValue(email);
  const base = rawName && !rawName.includes("@")
    ? rawName
    : rawEmail.split("@")[0] || rawName.split("@")[0] || "User";
  return base.replace(/\d{6,}$/, "") || base;
}

export function getExtensionDisplayName(source?: ExtensionNameSource | string | null): string | null {
  if (typeof source === "string") {
    const direct = cleanDisplayValue(source);
    return direct || null;
  }
  const candidates = [
    source?.displayName,
    source?.name,
    source?.label,
  ];
  for (const candidate of candidates) {
    const value = cleanDisplayValue(candidate);
    if (value) return value;
  }
  return null;
}

export function getPreferredUserDisplayName(user: UserNameSource): string {
  const extensionName =
    getExtensionDisplayName(user?.extensionDisplayName) ||
    (typeof user?.extension === "object" ? getExtensionDisplayName(user.extension) : null);
  return extensionName || formatUserNameFallback(user?.name, user?.email);
}

