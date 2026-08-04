import type { Role } from "../types/app";

type JwtPayload = {
  sub?: string;
  tenantId?: string;
  role?: string;
  email?: string;
  name?: string;
};

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  if (typeof window !== "undefined") return atob(padded);
  return Buffer.from(padded, "base64").toString("utf-8");
}

// Every localStorage touch is wrapped: Safari's "Block All Cookies", some
// private modes, and storage-disabled webviews make the calls THROW, and this
// module is imported by public pages (sign-up wizard, pay page) that must keep
// working with no storage at all — they just behave as signed-out.
export function readAuthToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return (
      localStorage.getItem("token") ||
      localStorage.getItem("cc-token") ||
      localStorage.getItem("authToken") ||
      ""
    );
  } catch {
    return "";
  }
}

export function writeAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("token", token);
    localStorage.setItem("cc-token", token);
    localStorage.setItem("authToken", token);
  } catch { /* storage blocked — session lives only as long as the page */ }
}

export function clearAuthSession(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("token");
    localStorage.removeItem("cc-token");
    localStorage.removeItem("authToken");
  } catch { /* storage blocked — nothing was stored to clear */ }
}

export function readTenantContext(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem("cc-tenant-id") || "";
  } catch {
    return "";
  }
}

export function readJwtPayload(): JwtPayload | null {
  const token = readAuthToken();
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(decodeBase64Url(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

export function mapBackendRole(roleRaw?: string): Role {
  const role = String(roleRaw || "").toUpperCase();
  if (role === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (["TENANT_ADMIN", "ADMIN", "MANAGER", "BILLING_ADMIN", "BILLING", "MESSAGING", "SUPPORT"].includes(role)) return "TENANT_ADMIN";
  return "END_USER";
}
