"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function IvrSchedulesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ ivrId: "", recordingId: "", startTime: "", endTime: "", timezone: "UTC", enabled: true });
  const [message, setMessage] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/ivr/schedules`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ rows: [] }));
    setRows(Array.isArray(json?.rows) ? json.rows : []);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function createSchedule() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/voice/ivr/schedules`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(form)
    });
    setMessage(res.ok ? "Schedule created." : "Failed to create schedule.");
    await load();
  }

  return (
    <div className="card">
      <h1>IVR Recording Schedules</h1>
      <p>Automatically switch IVR recording behavior by schedule windows.</p>
      <input placeholder="IVR ID" value={form.ivrId} onChange={(e) => setForm({ ...form, ivrId: e.target.value })} />
      <input placeholder="Recording ID" value={form.recordingId} onChange={(e) => setForm({ ...form, recordingId: e.target.value })} />
      <input placeholder="Start Time (ISO)" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
      <input placeholder="End Time (ISO)" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
      <input placeholder="Timezone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
      <button onClick={createSchedule}>Create Schedule</button>
      {message ? <p>{message}</p> : null}
      {rows.map((r) => <pre key={r.id}>{JSON.stringify(r, null, 2)}</pre>)}
    </div>
  );
}
