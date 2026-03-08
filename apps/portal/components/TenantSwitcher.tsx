"use client";

import { useAppContext } from "../hooks/useAppContext";
import { PermissionGate } from "./PermissionGate";

export function TenantSwitcher() {
  const { tenants, tenantId, setTenantId, adminScope, setAdminScope } = useAppContext();
  return (
    <PermissionGate permission="can_switch_tenants">
      <div className="scope-switch-wrap">
        <div className="scope-toggle">
          <button
            className={`scope-btn ${adminScope === "GLOBAL" ? "active" : ""}`}
            onClick={() => setAdminScope("GLOBAL")}
            type="button"
          >
            Global
          </button>
          <button
            className={`scope-btn ${adminScope === "TENANT" ? "active" : ""}`}
            onClick={() => setAdminScope("TENANT")}
            type="button"
          >
            Tenant
          </button>
        </div>
        <select
          className="select"
          value={tenantId}
          onChange={(event) => setTenantId(event.target.value)}
          disabled={adminScope === "GLOBAL"}
          title={adminScope === "GLOBAL" ? "Tenant selector disabled in Global Admin mode" : "Select tenant context"}
        >
          {tenants.map((tenant) => (
            <option key={tenant.id} value={tenant.id}>
              {tenant.name}
            </option>
          ))}
        </select>
      </div>
    </PermissionGate>
  );
}
