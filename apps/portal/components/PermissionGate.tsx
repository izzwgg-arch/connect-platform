"use client";

import type { ReactNode } from "react";
import type { Permission } from "../types/app";
import { useAppContext } from "../hooks/useAppContext";

export function PermissionGate({ permission, fallback = null, children }: { permission: Permission; fallback?: ReactNode; children: ReactNode }) {
  const { can } = useAppContext();
  if (!can(permission)) return <>{fallback}</>;
  return <>{children}</>;
}
