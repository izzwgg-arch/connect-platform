"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    return JSON.parse(atob(token.split(".")[1])).role || "";
  } catch {
    return "";
  }
}

type EventStatusRow = {
  pbxInstanceId: string;
  name: string;
  baseUrl: string;
  isEnabled: boolean;
  capabilities: {
    supportsWebhooks: boolean;
    supportsActiveCallPolling: boolean;
    webhookSignatureMode: string;
    activeCallsEndpointPath?: string;
    webhookEventTypes?: string[];
  };
  registration: null | {
    webhookId: string;
    callbackUrl: string;
    status: string;
    lastEventAt: string | null;
    lastError: string | null;
    updatedAt: string;
  };
};

export default function AdminPbxEventsPage() {
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<EventStatusRow[]>([]);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [testJson, setTestJson] = useState('{"eventType":"call.ringing","callId":"demo-call-1","from":"+13055550111","toExtension":"1001","tenantId":"tenant-1"}');
  const [testResult, setTestResult] = useState("{}");

  const token = useMemo(() => (typeof window !== "undefined" ? window.localStorage.getItem("token") || "" : ""), []);

  async function load() {
    const res = await fetch(`${apiBase}/admin/pbx/events/status`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setRows(Array.isArray(json) ? json : []);
    if (!selected && Array.isArray(json) && json.length > 0) setSelected(json[0].pbxInstanceId);
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r === "SUPER_ADMIN") {
      load().catch((e) => setMessage(String(e?.message || "Failed to load PBX event status")));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function registerWebhook() {
    if (!selected) return;
    setMessage("Registering webhook...");
    const res = await fetch(`${apiBase}/admin/pbx/events/register`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pbxInstanceId: selected })
    });
    const json = await res.json();
    setMessage(JSON.stringify(json, null, 2));
    await load();
  }

  async function unregisterWebhook() {
    if (!selected) return;
    setMessage("Unregistering webhook...");
    const res = await fetch(`${apiBase}/admin/pbx/events/unregister`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pbxInstanceId: selected })
    });
    const json = await res.json();
    setMessage(JSON.stringify(json, null, 2));
    await load();
  }

  async function testParse() {
    let payload: any;
    try {
      payload = JSON.parse(testJson);
    } catch {
      setTestResult(JSON.stringify({ error: "Invalid JSON" }, null, 2));
      return;
    }

    const res = await fetch(`${apiBase}/admin/pbx/events/parse-test`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ event: payload })
    });
    setTestResult(JSON.stringify(await res.json(), null, 2));
  }

  if (role !== "SUPER_ADMIN") return <div className="card"><h1>PBX Events</h1><p>Insufficient permissions.</p></div>;

  return (
    <div className="card">
      <h1>PBX Event Setup</h1>
      <p>Configure inbound call event handling from WirePBX/VitalPBX into mobile call invites.</p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {rows.map((r) => (
            <option key={r.pbxInstanceId} value={r.pbxInstanceId}>
              {r.name} ({r.baseUrl})
            </option>
          ))}
        </select>
        <button onClick={registerWebhook}>Register Webhook</button>
        <button onClick={unregisterWebhook}>Unregister Webhook</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>PBX Instance</th>
            <th>Webhook Status</th>
            <th>Last Event</th>
            <th>Last Error</th>
            <th>Capabilities</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.pbxInstanceId}>
              <td>{r.name}</td>
              <td>{r.registration?.status || "NOT_REGISTERED"}</td>
              <td>{r.registration?.lastEventAt || "-"}</td>
              <td>{r.registration?.lastError || "-"}</td>
              <td>
                hooks={r.capabilities?.supportsWebhooks ? "yes" : "no"}, poll={r.capabilities?.supportsActiveCallPolling ? "yes" : "no"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Test Event Parsing</h2>
      <textarea value={testJson} onChange={(e) => setTestJson(e.target.value)} rows={8} style={{ width: "100%" }} />
      <button onClick={testParse}>Parse Test Event</button>

      <h3>Parse Result</h3>
      <pre>{testResult}</pre>

      {message ? (
        <>
          <h3>Action Output</h3>
          <pre>{message}</pre>
        </>
      ) : null}
    </div>
  );
}
