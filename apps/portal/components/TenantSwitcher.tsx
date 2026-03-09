"use client";

import { useMemo, useState } from "react";
import { useAppContext } from "../hooks/useAppContext";
import { PermissionGate } from "./PermissionGate";

export function TenantSwitcher() {
  const { tenants, tenantId, setTenantId, adminScope, setAdminScope } = useAppContext();
  const [search, setSearch] = useState("");
  const filtered = useMemo(
    () => tenants.filter((tenant) => tenant.name.toLowerCase().includes(search.trim().toLowerCase())),
    [search, tenants]
  );
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
        <div className="tenant-switcher-box">
          <input
            className="input tenant-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find tenant..."
            disabled={adminScope === "GLOBAL" || tenants.length === 0}
          />
          <select
            className="select"
            value={tenants.length === 0 ? "" : tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            disabled={adminScope === "GLOBAL" || tenants.length === 0}
            title={adminScope === "GLOBAL" ? "Tenant selector disabled in Global Admin mode" : "Select tenant context"}
          >
            {tenants.length === 0 ? <option value="">No VitalPBX tenants found</option> : null}
            {(filtered.length ? filtered : tenants).map((tenant) => (
              <option key={tenant.id} value={tenant.id}>
                {tenant.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </PermissionGate>
  );
}
