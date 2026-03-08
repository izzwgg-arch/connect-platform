"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function AutomationRulesPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({
    name: "",
    triggerType: "INVOICE_OVERDUE",
    actionType: "CREATE_TASK",
    actionPayload: "{\n  \"title\": \"Follow up\"\n}",
    isEnabled: true
  });
  const [message, setMessage] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/automation/rules`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({ rows: [] }));
    setRows(Array.isArray(json?.rows) ? json.rows : []);
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  async function createRule() {
    let payload: any = {};
    try { payload = JSON.parse(form.actionPayload || "{}"); } catch { setMessage("Invalid action payload JSON."); return; }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/automation/rules`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: form.name,
        triggerType: form.triggerType,
        actionType: form.actionType,
        actionPayload: payload,
        isEnabled: form.isEnabled
      })
    });
    setMessage(res.ok ? "Rule created." : "Failed to create rule.");
    await load();
  }

  return (
    <div className="card">
      <h1>Automation Rules</h1>
      <p>Create trigger/action rules for customer workflow automation.</p>
      <input placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label>Trigger</label>
      <select value={form.triggerType} onChange={(e) => setForm({ ...form, triggerType: e.target.value })}>
        <option value="INVOICE_OVERDUE">INVOICE_OVERDUE</option>
        <option value="PAYMENT_FAILED">PAYMENT_FAILED</option>
        <option value="NEW_CUSTOMER">NEW_CUSTOMER</option>
        <option value="WHATSAPP_INBOUND">WHATSAPP_INBOUND</option>
      </select>
      <label>Action</label>
      <select value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value })}>
        <option value="SEND_SMS">SEND_SMS</option>
        <option value="SEND_EMAIL">SEND_EMAIL</option>
        <option value="TAG_CUSTOMER">TAG_CUSTOMER</option>
        <option value="CREATE_TASK">CREATE_TASK</option>
      </select>
      <textarea rows={8} value={form.actionPayload} onChange={(e) => setForm({ ...form, actionPayload: e.target.value })} />
      <label><input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> Enabled</label>
      <button onClick={createRule}>Create Rule</button>
      {message ? <p>{message}</p> : null}
      {rows.length === 0 ? <p>No automation rules configured.</p> : rows.map((r) => <pre key={r.id}>{JSON.stringify(r, null, 2)}</pre>)}
    </div>
  );
}
