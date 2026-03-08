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

export function readAuthToken(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("cc-token") ||
    localStorage.getItem("authToken") ||
    ""
  );
}

export function readTenantContext(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("cc-tenant-id") || "";
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
  if (["ADMIN", "BILLING", "MESSAGING", "SUPPORT"].includes(role)) return "TENANT_ADMIN";
  return "END_USER";
}
