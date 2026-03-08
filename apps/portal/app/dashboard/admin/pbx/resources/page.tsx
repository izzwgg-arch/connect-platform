"use client";

import { useEffect, useState } from "react";
import { readRoleFromToken } from "../../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";
const resources = ["extensions", "trunks", "ring-groups", "queues", "ivr", "routes"];

export default function AdminPbxResourcesPage() {
  const [role, setRole] = useState("");
  const [instanceId, setInstanceId] = useState("");
  const [resource, setResource] = useState(resources[0]);
  const [rows, setRows] = useState<any[]>([]);
  const [payload, setPayload] = useState("{\n  \"name\": \"\"\n}");
  const [message, setMessage] = useState("");
  const [instances, setInstances] = useState<any[]>([]);

  const allowed = role === "SUPER_ADMIN";

  async function loadInstances() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/instances`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    const list = Array.isArray(json) ? json : [];
    setInstances(list);
    if (!instanceId && list[0]?.id) setInstanceId(list[0].id);
  }

  async function loadRows() {
    if (!instanceId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/resources/${resource}?instanceId=${encodeURIComponent(instanceId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ rows: [] }));
    setRows(Array.isArray(json?.rows) ? json.rows : []);
  }

  useEffect(() => {
    const nextRole = readRoleFromToken();
    setRole(nextRole);
    if (nextRole === "SUPER_ADMIN") loadInstances().catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (allowed && instanceId) loadRows().catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, instanceId, resource]);

  async function createRow() {
    let parsed: any = {};
    try { parsed = JSON.parse(payload); } catch { setMessage("Invalid JSON."); return; }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/resources/${resource}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ instanceId, payload: parsed })
    });
    setMessage(res.ok ? "Created." : "Create failed.");
    await loadRows();
  }

  if (!allowed) return <div className="card"><h1>PBX Resources</h1><p>Access denied.</p></div>;

  return (
    <div className="card">
      <h1>Admin PBX Resources</h1>
      <div className="row">
        <label>Instance</label>
        <select value={instanceId} onChange={(e) => setInstanceId(e.target.value)}>
          {instances.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <label>Resource</label>
        <select value={resource} onChange={(e) => setResource(e.target.value)}>
          {resources.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>
      <textarea rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} />
      <button onClick={createRow}>Create</button>
      {message ? <p>{message}</p> : null}
      {rows.map((r, i) => <pre key={String(r?.id || i)}>{JSON.stringify(r, null, 2)}</pre>)}
    </div>
  );
}
