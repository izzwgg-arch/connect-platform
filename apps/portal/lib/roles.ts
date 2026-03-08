"use client";

export type StaffRole = "SUPER_ADMIN" | "ADMIN" | "BILLING" | "MESSAGING" | "SUPPORT" | "READ_ONLY" | "USER";

export function readRoleFromToken(): StaffRole | "" {
  const token = typeof window === "undefined" ? "" : localStorage.getItem("token") || "";
  if (!token) return "";
  try {
    return (JSON.parse(atob(token.split(".")[1])).role || "") as StaffRole;
  } catch {
    return "";
  }
}

export function isRole(role: string, allowed: StaffRole[]): boolean {
  return allowed.includes((role || "USER") as StaffRole);
}

export function canManageBilling(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN", "ADMIN", "BILLING"]);
}

export function canManageMessaging(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN", "ADMIN", "MESSAGING"]);
}

export function canViewCustomers(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN", "ADMIN", "BILLING", "MESSAGING", "SUPPORT", "READ_ONLY", "USER"]);
}

export function canManageProviders(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN", "ADMIN"]);
}

export function canAccessAdminSbc(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN"]);
}

export function canAccessAdminBilling(role: string): boolean {
  return isRole(role, ["SUPER_ADMIN"]);
}
