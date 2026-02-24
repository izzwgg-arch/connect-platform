"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

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

type ProviderRow = {
  provider: string;
  label?: string;
  isEnabled: boolean;
  updatedAt: string;
  preview?: {
    accountSid?: string | null;
    authToken?: string | null;
    messagingServiceSid?: string | null;
    fromNumber?: string | null;
  };
};

export default function ProviderSettingsPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [label, setLabel] = useState("Primary Twilio");
  const [status, setStatus] = useState("Not Configured");
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [result, setResult] = useState("");

  async function loadProviders() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/settings/providers`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    const rows = Array.isArray(json) ? json : [];
    setProviders(rows);
    const twilio = rows.find((r: ProviderRow) => r.provider === "TWILIO");
    if (!twilio) {
      setStatus("Not Configured");
      return;
    }
    setStatus(twilio.isEnabled ? "Enabled" : "Disabled");
    setLabel(twilio.label || "Primary Twilio");
    if (twilio.preview?.accountSid) setAccountSid(twilio.preview.accountSid);
    setAuthToken("????????????????????????");
    if (twilio.preview?.messagingServiceSid) setMessagingServiceSid(twilio.preview.messagingServiceSid);
    if (twilio.preview?.fromNumber) setFromNumber(twilio.preview.fromNumber);
  }

  useEffect(() => {
    if (role === "ADMIN") loadProviders();
  }, [role]);

  async function saveTwilio(e: FormEvent) {
    e.preventDefault();
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/settings/providers/twilio`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        accountSid,
        authToken,
        messagingServiceSid,
        fromNumber,
        label
      })
    });
    const json = await res.json();
    setResult(JSON.stringify(json, null, 2));
    setAuthToken("????????????????????????");
    await loadProviders();
  }

  async function setEnabled(enabled: boolean) {
    const token = localStorage.getItem("token") || "";
    await fetch(`${apiBase}/settings/providers/twilio/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    await loadProviders();
  }

  if (role !== "ADMIN") {
    return (
      <div className="card">
        <h1>Provider Settings</h1>
        <p>Insufficient permissions.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Provider Settings</h1>
      <h2>SMS Providers</h2>
      <p>Status: <strong>{status}</strong></p>
      <p>Credentials are encrypted and cannot be viewed after saving. You can replace them at any time.</p>
      <p>Enable provider to start real SMS sending. Otherwise system runs in test mode.</p>

      <form onSubmit={saveTwilio}>
        <h3>Twilio</h3>
        <input placeholder="Account SID" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} />
        <input placeholder="Auth Token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
        <input placeholder="Messaging Service SID" value={messagingServiceSid} onChange={(e) => setMessagingServiceSid(e.target.value)} />
        <input placeholder="From Number" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
        <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Save Twilio Credentials</button>
      </form>

      <div style={{ marginTop: 12 }}>
        <button onClick={() => setEnabled(true)}>Enable Twilio</button>
        <button onClick={() => setEnabled(false)}>Disable Twilio</button>
      </div>

      <h3>Configured Providers</h3>
      <ul>
        {providers.map((p) => (
          <li key={p.provider}>{p.provider} - {p.isEnabled ? "Enabled" : "Disabled"}</li>
        ))}
      </ul>

      <pre>{result}</pre>
    </div>
  );
}
