"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readJwtRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.role || "";
  } catch {
    return "";
  }
}

type OwnedNumber = {
  id: string;
  provider: "TWILIO" | "VOIPMS";
  phoneNumber: string;
  status: string;
  capabilities?: { sms?: boolean; mms?: boolean; voice?: boolean };
  isDefaultSms: boolean;
};

export default function NumbersPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [provider, setProvider] = useState<"TWILIO" | "VOIPMS">("TWILIO");
  const [type, setType] = useState<"local" | "tollfree">("local");
  const [areaCode, setAreaCode] = useState("305");
  const [results, setResults] = useState<any[]>([]);
  const [message, setMessage] = useState("");

  async function loadNumbers() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/numbers`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setNumbers(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    if (role === "ADMIN" || role === "SUPER_ADMIN") loadNumbers();
  }, [role]);

  async function searchNumbers() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/numbers/search`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider, type, areaCode, limit: 20 })
    });
    const json = await res.json();
    if (json?.unavailable) {
      setResults([]);
      setMessage("VoIP.ms number search not available yet");
      return;
    }
    setResults(json.results || []);
    setMessage("");
  }

  async function buyNumber(phoneNumber: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/numbers/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider, phoneNumber })
    });
    const json = await res.json();
    setMessage(JSON.stringify(json, null, 2));
    await loadNumbers();
  }

  async function setDefault(id: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/numbers/${id}/set-default-sms`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await loadNumbers();
  }

  async function releaseNumber(id: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/numbers/${id}/release`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await loadNumbers();
  }

  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Numbers</h1><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Numbers</h1>
      <h3>Owned Numbers</h3>
      <table>
        <thead>
          <tr><th>Number</th><th>Provider</th><th>Status</th><th>Capabilities</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {numbers.map((n) => (
            <tr key={n.id}>
              <td>{n.phoneNumber} {n.isDefaultSms ? <strong>(Default SMS)</strong> : null}</td>
              <td>{n.provider}</td>
              <td>{n.status}</td>
              <td>{n.capabilities?.sms ? "SMS" : "-"}/{n.capabilities?.voice ? "Voice" : "-"}</td>
              <td>
                <button onClick={() => setDefault(n.id)} disabled={n.status !== "ACTIVE"}>Set Default</button>
                <button onClick={() => releaseNumber(n.id)} disabled={n.status !== "ACTIVE"}>Release</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Search & Buy</h3>
      <p>Buying numbers may incur monthly costs. Confirm provider and compliance before purchase.</p>
      <select value={provider} onChange={(e) => setProvider(e.target.value as "TWILIO" | "VOIPMS")}>
        <option value="TWILIO">TWILIO</option>
        <option value="VOIPMS">VOIPMS</option>
      </select>
      <select value={type} onChange={(e) => setType(e.target.value as "local" | "tollfree")}>
        <option value="local">local</option>
        <option value="tollfree">tollfree</option>
      </select>
      <input value={areaCode} onChange={(e) => setAreaCode(e.target.value)} placeholder="Area code" />
      <button onClick={searchNumbers}>Search</button>
      {message ? <pre>{message}</pre> : null}
      <table>
        <thead>
          <tr><th>Number</th><th>Region</th><th>Capabilities</th><th>Action</th></tr>
        </thead>
        <tbody>
          {results.map((r, idx) => (
            <tr key={`${r.phoneNumber}-${idx}`}>
              <td>{r.phoneNumber}</td>
              <td>{r.region || "US"}</td>
              <td>{r.capabilities?.sms ? "SMS" : "-"}/{r.capabilities?.voice ? "Voice" : "-"}</td>
              <td>
                <button onClick={() => buyNumber(r.phoneNumber)} disabled={provider === "VOIPMS" && message.includes("not available")}>Buy</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
