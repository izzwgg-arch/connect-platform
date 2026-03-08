"use client";

import { useEffect, useMemo, useState } from "react";
import { canManageMessaging, readRoleFromToken } from "../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export function PbxResourcePage({ title, resource, subtitle }: { title: string; resource: string; subtitle?: string }) {
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [payload, setPayload] = useState("{\n  \"name\": \"\"\n}");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const canEdit = canManageMessaging(role);

  async function load() {
    setLoading(true);
    setError("");
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/pbx/resources/${encodeURIComponent(resource)}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ rows: [] }));
    if (!res.ok) setError(json?.error || "Failed to load resource.");
    setRows(Array.isArray(json?.rows) ? json.rows : []);
    setLoading(false);
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    load().catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource]);

  async function createItem() {
    if (!canEdit) return;
    const token = localStorage.getItem("token") || "";
    setMessage("");
    setError("");
    let parsed: any = {};
    try {
      parsed = JSON.parse(payload || "{}");
    } catch {
      setError("Payload must be valid JSON.");
      return;
    }
    const res = await fetch(`${apiBase}/voice/pbx/resources/${encodeURIComponent(resource)}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ payload: parsed })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setError(json?.error || "Create failed.");
    else setMessage("Created.");
    await load();
  }

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
  }, [query, rows]);

  return (
    <div className="card">
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {!canEdit ? <p className="status-chip blocked">Read-only access: create/update actions are disabled.</p> : null}
      {error ? <p className="status-chip failed">{error}</p> : null}
      {message ? <p className="status-chip sent">{message}</p> : null}

      <div className="row">
        <label>Search</label>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search JSON rows" />
        <button onClick={() => load()} disabled={loading}>Refresh</button>
      </div>

      <div className="card">
        <h2>Create</h2>
        <textarea rows={8} value={payload} onChange={(e) => setPayload(e.target.value)} />
        <button onClick={createItem} disabled={!canEdit}>Create</button>
      </div>

      <h2>Rows</h2>
      {loading ? <p>Loading...</p> : null}
      {!loading && filteredRows.length === 0 ? <p>No records yet.</p> : null}
      {filteredRows.map((row, i) => (
        <pre key={String(row?.id || i)} style={{ maxHeight: 220, overflow: "auto" }}>{JSON.stringify(row, null, 2)}</pre>
      ))}
    </div>
  );
}
