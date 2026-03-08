"use client";

import { useEffect, useState } from "react";
import { readRoleFromToken } from "../../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function AdminPbxTenantsPage() {
  const [role, setRole] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [instances, setInstances] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");

  const allowed = role === "SUPER_ADMIN";

  async function loadInstances() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/instances`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    const list = Array.isArray(json) ? json : [];
    setInstances(list);
    if (!instanceId && list[0]?.id) setInstanceId(list[0].id);
  }

  async function loadTenants(nextInstanceId = instanceId) {
    if (!nextInstanceId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/tenants?instanceId=${encodeURIComponent(nextInstanceId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ tenants: [] }));
    setRows(Array.isArray(json?.tenants) ? json.tenants : []);
  }

  useEffect(() => {
    const nextRole = readRoleFromToken();
    setRole(nextRole);
    if (nextRole === "SUPER_ADMIN") {
      loadInstances().catch(() => undefined);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (instanceId && allowed) loadTenants(instanceId).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, allowed]);

  async function createTenant() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/tenants`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instanceId, name })
    });
    const json = await res.json().catch(() => ({}));
    setMessage(res.ok ? "Tenant created." : (json?.error || "Failed to create tenant."));
    await loadTenants();
  }

  async function runAction(id: string, action: "suspend" | "unsuspend" | "sync" | "delete") {
    const token = localStorage.getItem("token") || "";
    const url = action === "delete"
      ? `${apiBase}/admin/pbx/tenants/${encodeURIComponent(id)}?instanceId=${encodeURIComponent(instanceId)}`
      : `${apiBase}/admin/pbx/tenants/${encodeURIComponent(id)}/${action}`;
    const method = action === "delete" ? "DELETE" : "POST";
    const body = action === "delete" ? undefined : JSON.stringify({ instanceId });
    const res = await fetch(url, { method, headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body });
    setMessage(res.ok ? `Action ${action} completed.` : `Action ${action} failed.`);
    await loadTenants();
  }

  if (!allowed) return <div className="card"><h1>PBX Tenants</h1><p>Access denied.</p></div>;

  return (
    <div className="card">
      <h1>Admin PBX Tenants</h1>
      <p>Create, suspend, sync, and remove PBX tenants.</p>
      <div className="row">
        <label>Instance</label>
        <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
          {instances.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="row">
        <label>Tenant Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={createTenant} disabled={!instanceId || !name.trim()}>Create Tenant</button>
      </div>
      {message ? <p>{message}</p> : null}
      <table>
        <thead><tr><th>ID</th><th>Name</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id || r.tenantId)}>
              <td>{String(r.id || r.tenantId || "-")}</td>
              <td>{String(r.name || r.displayName || "-")}</td>
              <td>
                <button onClick={() => runAction(String(r.id || r.tenantId), "sync")}>Sync</button>
                <button onClick={() => runAction(String(r.id || r.tenantId), "suspend")}>Suspend</button>
                <button onClick={() => runAction(String(r.id || r.tenantId), "unsuspend")}>Unsuspend</button>
                <button onClick={() => runAction(String(r.id || r.tenantId), "delete")}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
