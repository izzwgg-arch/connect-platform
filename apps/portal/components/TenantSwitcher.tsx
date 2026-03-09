"use client";

import { useMemo, useState } from "react";
import { useAppContext } from "../hooks/useAppContext";
import { PermissionGate } from "./PermissionGate";

export function TenantSwitcher() {
  const { tenants, tenantId, setTenantId, adminScope, setAdminScope } = useAppContext();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? tenants.filter((tenant) => tenant.name.toLowerCase().includes(q)) : tenants;
  }, [search, tenants]);
  const activeLabel = adminScope === "GLOBAL" ? "Main Tenant" : tenants.find((tenant) => tenant.id === tenantId)?.name || "Select Tenant";

  function selectGlobal() {
    setAdminScope("GLOBAL");
    setOpen(false);
  }

  function selectTenant(id: string) {
    setAdminScope("TENANT");
    setTenantId(id);
    setOpen(false);
  }

  return (
    <PermissionGate permission="can_switch_tenants">
      <div className="tenant-picker menu-wrap">
        <button className="tenant-picker-trigger" type="button" onClick={() => setOpen((v) => !v)}>
          <span className="tenant-picker-label">{activeLabel}</span>
          <span className="tenant-picker-chevron">▼</span>
        </button>
        {open ? (
          <div className="tenant-picker-panel dropdown-panel">
            <input
              className="input tenant-picker-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search tenants..."
            />
            <div className="tenant-picker-list">
              <button
                className={`tenant-picker-item ${adminScope === "GLOBAL" ? "active" : ""}`}
                type="button"
                onClick={selectGlobal}
              >
                Main Tenant
              </button>
              {filtered.map((tenant) => (
                <button
                  key={tenant.id}
                  className={`tenant-picker-item ${adminScope === "TENANT" && tenantId === tenant.id ? "active" : ""}`}
                  type="button"
                  onClick={() => selectTenant(tenant.id)}
                >
                  {tenant.name}
                </button>
              ))}
              {filtered.length === 0 ? <div className="tenant-picker-empty">No tenants found</div> : null}
            </div>
          </div>
        ) : null}
        {tenants.length === 0 ? <div className="tenant-picker-empty-inline">No VitalPBX tenants found</div> : null}
        </div>
    </PermissionGate>
  );
}
