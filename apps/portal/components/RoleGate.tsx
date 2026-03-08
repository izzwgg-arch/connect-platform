"use client";

import type { ReactNode } from "react";
import type { Role } from "../types/app";
import { useAppContext } from "../hooks/useAppContext";

export function RoleGate({ allow, fallback = null, children }: { allow: Role[]; fallback?: ReactNode; children: ReactNode }) {
  const { role } = useAppContext();
  if (!allow.includes(role)) return <>{fallback}</>;
  return <>{children}</>;
}
