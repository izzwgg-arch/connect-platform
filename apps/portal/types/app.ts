import type { PortalPermissionKey, PortalRoleBucket } from "@connect/shared";

export type Role = PortalRoleBucket;
export type AdminScope = "TENANT" | "GLOBAL";

export type Permission = PortalPermissionKey;

export type Presence = "AVAILABLE" | "ON_CALL" | "AWAY" | "DND" | "OFFLINE";

export type Tenant = {
  id: string;
  name: string;
  plan: "Starter" | "Business" | "Enterprise";
  status: "ACTIVE" | "SUSPENDED";
};

export type User = {
  id: string;
  name: string;
  email: string;
  extension: string;
  role: Role;
  tenantId: string;
  presence: Presence;
};
