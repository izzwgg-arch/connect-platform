"use client";

import type { ReactNode } from "react";
import { useAppContext } from "../hooks/useAppContext";

type ScopeActionGuardProps = {
  children: (state: { disabled: boolean; title?: string }) => ReactNode;
  disabledTitle?: string;
  allowInGlobal?: boolean;
};

export function ScopeActionGuard({
  children,
  disabledTitle = "Action disabled in Global mode. Switch to Tenant mode to make changes.",
  allowInGlobal = false
}: ScopeActionGuardProps) {
  const { adminScope } = useAppContext();
  const disabled = adminScope === "GLOBAL" && !allowInGlobal;
  return <>{children({ disabled, title: disabled ? disabledTitle : undefined })}</>;
}
