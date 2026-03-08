"use client";

import { useEffect, useState } from "react";
import { isRole, readRoleFromToken } from "../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";
const roleOptions = ["SUPER_ADMIN", "ADMIN", "BILLING", "MESSAGING", "SUPPORT", "READ_ONLY", "USER"];

export default function Extensions() {
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [message, setMessage] = useState("");

  async function loadUsers() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    setRows(Array.isArray(json) ? json : []);
  }

  async function updateRole(userId: string, nextRole: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/users/${userId}/role`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: nextRole })
    });
    const json = await res.json().catch(() => ({}));
    setMessage(res.ok ? "Role updated." : String(json?.error || "Failed to update role"));
    await loadUsers();
  }

  useEffect(() => {
    const r = readRoleFromToken();
    setRole(r);
    if (!isRole(r, ["SUPER_ADMIN", "ADMIN"])) return;
    loadUsers().catch(() => setMessage("Failed to load users."));
  }, []);

  if (!isRole(role, ["SUPER_ADMIN", "ADMIN"])) {
    return <div className="card"><h1>User Roles</h1><p>Access denied.</p></div>;
  }

  return (
    <div className="card">
      <h1>User Roles</h1>
      <p>Manage staff role assignments for this tenant.</p>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Save</th></tr></thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>
                <select
                  value={u.role}
                  onChange={(e) => {
                    const val = e.target.value;
                    setRows((prev) => prev.map((p) => p.id === u.id ? { ...p, role: val } : p));
                  }}
                >
                  {roleOptions.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </td>
              <td>
                <button onClick={() => updateRole(u.id, u.role)} disabled={role !== "SUPER_ADMIN" && u.role === "SUPER_ADMIN"}>
                  Save
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message ? <p>{message}</p> : null}
    </div>
  );
}
