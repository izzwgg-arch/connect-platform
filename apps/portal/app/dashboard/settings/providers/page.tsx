"use client";

import Link from "next/link";
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
  provider: "TWILIO" | "VOIPMS";
  label?: string;
  isEnabled: boolean;
  updatedAt: string;
  preview?: Record<string, string | null>;
};

type SmsLimitsPayload = {
  limits: {
    dailySmsLimit: number;
    hourlySmsLimit: number;
    perSecondRateLimit: number;
    maxCampaignSize: number;
  };
  usage: {
    todaySent: number;
    hourSent: number;
    failureRate15m: number;
  };
  suspension: {
    smsSuspended: boolean;
    smsSuspendedReason?: string | null;
    smsSuspendedAt?: string | null;
  };
};

type RoutingPayload = {
  smsRoutingMode: "SINGLE_PRIMARY" | "FAILOVER";
  smsPrimaryProvider: "TWILIO" | "VOIPMS";
  smsSecondaryProvider: "TWILIO" | "VOIPMS" | null;
  smsProviderLock: "TWILIO" | "VOIPMS" | null;
  smsProviderLockReason?: string | null;
  providerEnabled: { TWILIO: boolean; VOIPMS: boolean };
  health: Record<string, { sent: number; failed: number; circuitOpenUntil: string | null; lastErrorCode: string | null; lastErrorAt: string | null }>;
  activeProviderDecision: "PRIMARY" | "SECONDARY" | "LOCKED";
};

export default function ProviderSettingsPage() {
  const role = useMemo(() => (typeof window !== "undefined" ? readJwtRole() : ""), []);

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [smsLimits, setSmsLimits] = useState<SmsLimitsPayload | null>(null);
  const [routing, setRouting] = useState<RoutingPayload | null>(null);
  const [result, setResult] = useState("");

  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [label, setLabel] = useState("Primary Twilio");

  const [voipUsername, setVoipUsername] = useState("");
  const [voipPassword, setVoipPassword] = useState("");
  const [voipFrom, setVoipFrom] = useState("");
  const [voipApiBaseUrl, setVoipApiBaseUrl] = useState("");
  const [voipLabel, setVoipLabel] = useState("Primary VoIP.ms");

  const [smsMode, setSmsMode] = useState<"TEST" | "LIVE">("TEST");
  const [smsLiveEnabledAt, setSmsLiveEnabledAt] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [tenDlcApproved, setTenDlcApproved] = useState(false);
  const [tenDlcStatus, setTenDlcStatus] = useState<string | null>(null);

  const [testTo, setTestTo] = useState("+15555551234");
  const [testMessage, setTestMessage] = useState("Test message from Connect Communications");

  const [routingMode, setRoutingMode] = useState<"SINGLE_PRIMARY" | "FAILOVER">("FAILOVER");
  const [primaryProvider, setPrimaryProvider] = useState<"TWILIO" | "VOIPMS">("TWILIO");
  const [secondaryProvider, setSecondaryProvider] = useState<"TWILIO" | "VOIPMS" | "">("VOIPMS");
  const [lockProvider, setLockProvider] = useState<"TWILIO" | "VOIPMS">("TWILIO");
  const [lockReason, setLockReason] = useState("Manual provider lock");

  const token = () => localStorage.getItem("token") || "";

  async function loadProviders() {
    const res = await fetch(`${apiBase}/settings/providers`, { headers: { Authorization: `Bearer ${token()}` } });
    const rows = (await res.json()) as ProviderRow[];
    setProviders(Array.isArray(rows) ? rows : []);

    const tw = rows.find((r) => r.provider === "TWILIO");
    if (tw) {
      setLabel(tw.label || "Primary Twilio");
      setAccountSid((tw.preview?.accountSid as string) || "");
      setAuthToken("********");
      setMessagingServiceSid((tw.preview?.messagingServiceSid as string) || "");
      setFromNumber((tw.preview?.fromNumber as string) || "");
    }

    const vp = rows.find((r) => r.provider === "VOIPMS");
    if (vp) {
      setVoipLabel(vp.label || "Primary VoIP.ms");
      setVoipUsername((vp.preview?.username as string) || "");
      setVoipPassword("********");
      setVoipFrom((vp.preview?.fromNumber as string) || "");
      setVoipApiBaseUrl((vp.preview?.apiBaseUrl as string) || "");
    }
  }

  async function loadSmsMode() {
    const res = await fetch(`${apiBase}/settings/sms-mode`, { headers: { Authorization: `Bearer ${token()}` } });
    const json = await res.json();
    if (json?.smsSendMode) {
      setSmsMode(json.smsSendMode);
      setSmsLiveEnabledAt(json.smsLiveEnabledAt || null);
      setTenDlcApproved(!!json.tenDlcApproved);
      setTenDlcStatus(json.tenDlcStatus || null);
    }
  }

  async function loadSmsLimits() {
    const res = await fetch(`${apiBase}/settings/sms-limits`, { headers: { Authorization: `Bearer ${token()}` } });
    const json = await res.json();
    if (json?.limits) setSmsLimits(json);
  }

  async function loadRouting() {
    const res = await fetch(`${apiBase}/settings/sms-routing`, { headers: { Authorization: `Bearer ${token()}` } });
    const json = (await res.json()) as RoutingPayload;
    if (json?.smsRoutingMode) {
      setRouting(json);
      setRoutingMode(json.smsRoutingMode);
      setPrimaryProvider(json.smsPrimaryProvider);
      setSecondaryProvider(json.smsSecondaryProvider || "");
      setLockProvider(json.smsProviderLock || "TWILIO");
      setLockReason(json.smsProviderLockReason || "Manual provider lock");
    }
  }

  useEffect(() => {
    if (role === "ADMIN" || role === "SUPER_ADMIN") {
      loadProviders();
      loadSmsMode();
      loadSmsLimits();
      loadRouting();
    }
  }, [role]);

  async function saveTwilio(e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`${apiBase}/settings/providers/twilio`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ accountSid, authToken, messagingServiceSid, fromNumber, label })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setAuthToken("********");
    await loadProviders();
  }

  async function toggleTwilio(enabled: boolean) {
    const res = await fetch(`${apiBase}/settings/providers/twilio/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadProviders();
  }

  async function saveVoipms(e: FormEvent) {
    e.preventDefault();
    const res = await fetch(`${apiBase}/settings/providers/voipms`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ username: voipUsername, password: voipPassword, fromNumber: voipFrom, apiBaseUrl: voipApiBaseUrl || undefined, label: voipLabel })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setVoipPassword("********");
    await loadProviders();
  }

  async function toggleVoipms(enabled: boolean) {
    const res = await fetch(`${apiBase}/settings/providers/voipms/${enabled ? "enable" : "disable"}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadProviders();
  }

  async function saveRouting() {
    const res = await fetch(`${apiBase}/settings/sms-routing`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({
        routingMode,
        primaryProvider,
        secondaryProvider: routingMode === "FAILOVER" && secondaryProvider ? secondaryProvider : null
      })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadRouting();
  }

  async function lockRouting() {
    const res = await fetch(`${apiBase}/settings/sms-routing/lock`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ provider: lockProvider, reason: lockReason })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadRouting();
  }

  async function unlockRouting() {
    const res = await fetch(`${apiBase}/settings/sms-routing/unlock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token()}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadRouting();
  }

  async function saveSmsMode() {
    if (smsMode === "LIVE" && !confirmLive) {
      setResult(JSON.stringify({ error: "Please confirm LIVE mode before saving." }));
      return;
    }
    const res = await fetch(`${apiBase}/settings/sms-mode`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ mode: smsMode })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await loadSmsMode();
  }

  async function sendTestSms() {
    const res = await fetch(`${apiBase}/settings/providers/twilio/test-send`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ to: testTo, message: testMessage })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  async function requestReview() {
    const res = await fetch(`${apiBase}/settings/sms-limits`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ requestReview: true })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
    return <div className="card"><h1>Provider Settings</h1>
      <p><Link href="/dashboard/settings/providers/whatsapp">Open WhatsApp provider settings</Link> | <Link href="/dashboard/settings/email">Open Email settings</Link></p><p>Insufficient permissions.</p></div>;
  }

  return (
    <div className="card">
      <h1>Provider Settings</h1>
      <p><Link href="/dashboard/settings/providers/whatsapp">Open WhatsApp provider settings</Link> | <Link href="/dashboard/settings/email">Open Email settings</Link></p>

      <h2>Twilio</h2>
      <form onSubmit={saveTwilio}>
        <input placeholder="Account SID" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} />
        <input placeholder="Auth Token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
        <input placeholder="Messaging Service SID" value={messagingServiceSid} onChange={(e) => setMessagingServiceSid(e.target.value)} />
        <input placeholder="From Number" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
        <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Save Twilio Credentials</button>
      </form>
      <button onClick={() => toggleTwilio(true)}>Enable Twilio</button>
      <button onClick={() => toggleTwilio(false)}>Disable Twilio</button>

      <h2>VoIP.ms</h2>
      <form onSubmit={saveVoipms}>
        <input placeholder="VoIP.ms Username" value={voipUsername} onChange={(e) => setVoipUsername(e.target.value)} />
        <input placeholder="VoIP.ms Password" value={voipPassword} onChange={(e) => setVoipPassword(e.target.value)} />
        <input placeholder="From Number" value={voipFrom} onChange={(e) => setVoipFrom(e.target.value)} />
        <input placeholder="API Base URL (optional)" value={voipApiBaseUrl} onChange={(e) => setVoipApiBaseUrl(e.target.value)} />
        <input placeholder="Label" value={voipLabel} onChange={(e) => setVoipLabel(e.target.value)} />
        <button type="submit">Save VoIP.ms Credentials</button>
      </form>
      <button onClick={() => toggleVoipms(true)}>Enable VoIP.ms</button>
      <button onClick={() => toggleVoipms(false)}>Disable VoIP.ms</button>

      <h2>Routing</h2>
      <p>Current active decision: <strong>{routing?.activeProviderDecision || "PRIMARY"}</strong></p>
      <label>
        <input type="radio" checked={routingMode === "FAILOVER"} onChange={() => setRoutingMode("FAILOVER")} />
        FAILOVER
      </label>
      <label style={{ marginLeft: 12 }}>
        <input type="radio" checked={routingMode === "SINGLE_PRIMARY"} onChange={() => setRoutingMode("SINGLE_PRIMARY")} />
        SINGLE_PRIMARY
      </label>
      <div>
        <select value={primaryProvider} onChange={(e) => setPrimaryProvider(e.target.value as "TWILIO" | "VOIPMS")}>
          <option value="TWILIO">TWILIO</option>
          <option value="VOIPMS">VOIPMS</option>
        </select>
        {routingMode === "FAILOVER" ? (
          <select value={secondaryProvider} onChange={(e) => setSecondaryProvider(e.target.value as "TWILIO" | "VOIPMS" | "") }>
            <option value="">None</option>
            <option value="TWILIO">TWILIO</option>
            <option value="VOIPMS">VOIPMS</option>
          </select>
        ) : null}
        <button onClick={saveRouting}>Save Routing</button>
      </div>

      <h3>Lock Provider</h3>
      <select value={lockProvider} onChange={(e) => setLockProvider(e.target.value as "TWILIO" | "VOIPMS")}>
        <option value="TWILIO">TWILIO</option>
        <option value="VOIPMS">VOIPMS</option>
      </select>
      <input value={lockReason} onChange={(e) => setLockReason(e.target.value)} placeholder="Lock reason" />
      <button onClick={lockRouting}>Lock</button>
      <button onClick={unlockRouting}>Unlock</button>

      <h3>Health</h3>
      <p>TWILIO: sent {routing?.health?.TWILIO?.sent || 0}, failed {routing?.health?.TWILIO?.failed || 0}, circuit {routing?.health?.TWILIO?.circuitOpenUntil || "closed"}</p>
      <p>VOIPMS: sent {routing?.health?.VOIPMS?.sent || 0}, failed {routing?.health?.VOIPMS?.failed || 0}, circuit {routing?.health?.VOIPMS?.circuitOpenUntil || "closed"}</p>

      <h2>Sending Mode</h2>
      <p>Current mode: <strong>{smsMode}</strong></p>
      {smsLiveEnabledAt ? <p>LIVE enabled at: {new Date(smsLiveEnabledAt).toLocaleString()}</p> : null}
      <p>10DLC status: <strong>{tenDlcStatus || "none"}</strong></p>
      {!tenDlcApproved && role !== "SUPER_ADMIN" ? <p><strong>10DLC approval required before LIVE mode.</strong></p> : null}
      <label>
        <input type="radio" name="smsMode" value="TEST" checked={smsMode === "TEST"} onChange={() => { setSmsMode("TEST"); setConfirmLive(false); }} /> TEST
      </label>
      <label style={{ marginLeft: 12 }}>
        <input type="radio" name="smsMode" value="LIVE" checked={smsMode === "LIVE"} disabled={!tenDlcApproved && role !== "SUPER_ADMIN"} onChange={() => setSmsMode("LIVE")} /> LIVE
      </label>
      {smsMode === "LIVE" ? (
        <div>
          <p><strong>LIVE mode sends real SMS and may incur charges. Ensure 10DLC compliance.</strong></p>
          <label><input type="checkbox" checked={confirmLive} onChange={(e) => setConfirmLive(e.target.checked)} /> I understand this will send real SMS.</label>
        </div>
      ) : null}
      <button onClick={saveSmsMode}>Save Sending Mode</button>

      <h3>Send Test SMS</h3>
      <p><strong>This will send a real SMS and may incur charges.</strong></p>
      <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+15555551234" />
      <input value={testMessage} onChange={(e) => setTestMessage(e.target.value)} placeholder="Test message" />
      <button onClick={sendTestSms}>Send Test SMS</button>

      <h3>Usage & Limits</h3>
      {smsLimits ? (
        <div>
          {smsLimits.suspension.smsSuspended ? (
            <div style={{ border: "1px solid #d22", background: "#ffecec", padding: 10, marginBottom: 8 }}>
              <strong>SMS sending is suspended.</strong>
              <div>Reason: {smsLimits.suspension.smsSuspendedReason || "N/A"}</div>
              <button onClick={requestReview}>Request Review</button>
            </div>
          ) : null}
          <p>Today sent: <strong>{smsLimits.usage.todaySent}</strong></p>
          <p>This hour sent: <strong>{smsLimits.usage.hourSent}</strong></p>
          <p>Failure rate (15m): <strong>{(smsLimits.usage.failureRate15m * 100).toFixed(1)}%</strong></p>
          <p>Daily limit: <strong>{smsLimits.limits.dailySmsLimit}</strong></p>
          <p>Hourly limit: <strong>{smsLimits.limits.hourlySmsLimit}</strong></p>
          <p>Per-second limit: <strong>{smsLimits.limits.perSecondRateLimit}</strong></p>
          <p>Max campaign size: <strong>{smsLimits.limits.maxCampaignSize}</strong></p>
        </div>
      ) : <p>Loading usage and limits...</p>}

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
