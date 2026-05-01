import type { Permission, Role } from "../types/app";
import { DEFAULT_ROLE_PERMISSIONS } from "@connect/shared";

export const ROLE_PERMISSION_MAP: Record<Role, Permission[]> = {
  END_USER: DEFAULT_ROLE_PERMISSIONS.END_USER,
  TENANT_ADMIN: DEFAULT_ROLE_PERMISSIONS.TENANT_ADMIN,
  SUPER_ADMIN: DEFAULT_ROLE_PERMISSIONS.SUPER_ADMIN,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSION_MAP[role].includes(permission);
}
