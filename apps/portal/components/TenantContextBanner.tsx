"use client";

import { useAppContext } from "../hooks/useAppContext";
import { RoleGate } from "./RoleGate";

export function TenantContextBanner() {
  const { tenant, adminScope } = useAppContext();
  return (
    <RoleGate allow={["SUPER_ADMIN"]}>
      <div className="tenant-banner">
        {adminScope === "GLOBAL" ? (
          <>
            Super Admin Global Mode: <strong>Platform-wide control enabled</strong>
          </>
        ) : (
          <>
            Super Admin Tenant Mode: <strong>{tenant.name}</strong>
          </>
        )}
      </div>
    </RoleGate>
  );
}
