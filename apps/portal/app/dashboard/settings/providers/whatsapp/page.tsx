"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { canManageMessaging, readRoleFromToken } from "../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type WhatsAppRow = {
  provider: "WHATSAPP_TWILIO" | "WHATSAPP_META";
  isEnabled: boolean;
  preview: Record<string, string | null>;
  updatedAt: string;
  lastTestAt?: string | null;
  lastTestResult?: string | null;
  lastTestErrorCode?: string | null;
};

export default function WhatsAppProviderSettingsPage() {
  const [role, setRole] = useState("");
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);
  const [rows, setRows] = useState<WhatsAppRow[]>([]);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [result, setResult] = useState("");

  const [twilioAccountSid, setTwilioAccountSid] = useState("");
  const [twilioAuthToken, setTwilioAuthToken] = useState("");
  const [twilioFrom, setTwilioFrom] = useState("whatsapp:+15551234567");
  const [twilioMessagingServiceSid, setTwilioMessagingServiceSid] = useState("");

  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaWabaId, setMetaWabaId] = useState("");
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [metaVerifyToken, setMetaVerifyToken] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");
  const [metaWebhookSecret, setMetaWebhookSecret] = useState("");

  const [testTo, setTestTo] = useState("+15555551234");
  const [testMessage, setTestMessage] = useState("WhatsApp provider test from Connect Communications");

  async function load() {
    if (!token) return;
    const res = await fetch(`${apiBase}/settings/providers/whatsapp`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    setRows(Array.isArray(json?.providers) ? json.providers : []);
    setActiveProvider(json?.activeProvider || null);
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    load().catch(() => setResult("Failed to load WhatsApp provider settings"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (role && !canManageMessaging(role)) {
    return <div className="card"><h1>WhatsApp Provider Settings</h1><p>Access denied.</p></div>;
  }

  async function saveTwilio() {
    const res = await fetch(`${apiBase}/settings/providers/whatsapp/twilio`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        accountSid: twilioAccountSid,
        authToken: twilioAuthToken,
        fromWhatsAppNumber: twilioFrom,
        messagingServiceSid: twilioMessagingServiceSid || undefined
      })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setTwilioAuthToken("");
    await load();
  }

  async function saveMeta() {
    const res = await fetch(`${apiBase}/settings/providers/whatsapp/meta`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        phoneNumberId: metaPhoneNumberId,
        wabaId: metaWabaId,
        accessToken: metaAccessToken,
        verifyToken: metaVerifyToken,
        appSecret: metaAppSecret || undefined,
        webhookSecret: metaWebhookSecret || undefined
      })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setMetaAccessToken("");
    setMetaVerifyToken("");
    setMetaAppSecret("");
    setMetaWebhookSecret("");
    await load();
  }

  async function setEnabled(provider: "WHATSAPP_TWILIO" | "WHATSAPP_META", enabled: boolean) {
    const path = enabled ? "/settings/providers/whatsapp/enable" : "/settings/providers/whatsapp/disable";
    const res = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  async function testSend() {
    const res = await fetch(`${apiBase}/whatsapp/test-send`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: testTo, message: testMessage })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  return (
    <div className="card">
      <h1>WhatsApp Providers</h1>
      <p>
        Configure and route tenant WhatsApp messaging providers.
        {" "}<Link href="/dashboard/settings/providers">Back to Integrations</Link>
      </p>

      <p>Active provider: <strong>{activeProvider || "None"}</strong></p>

      <h2>Twilio WhatsApp</h2>
      <input placeholder="Account SID" value={twilioAccountSid} onChange={(e) => setTwilioAccountSid(e.target.value)} />
      <input placeholder="Auth Token" value={twilioAuthToken} onChange={(e) => setTwilioAuthToken(e.target.value)} />
      <input placeholder="From WhatsApp Number" value={twilioFrom} onChange={(e) => setTwilioFrom(e.target.value)} />
      <input placeholder="Messaging Service SID (optional)" value={twilioMessagingServiceSid} onChange={(e) => setTwilioMessagingServiceSid(e.target.value)} />
      <button onClick={saveTwilio}>Save Twilio WhatsApp</button>
      <button onClick={() => setEnabled("WHATSAPP_TWILIO", true)}>Enable Twilio</button>
      <button onClick={() => setEnabled("WHATSAPP_TWILIO", false)}>Disable Twilio</button>

      <h2>Meta WhatsApp Cloud API</h2>
      <input placeholder="Phone Number ID" value={metaPhoneNumberId} onChange={(e) => setMetaPhoneNumberId(e.target.value)} />
      <input placeholder="WABA ID" value={metaWabaId} onChange={(e) => setMetaWabaId(e.target.value)} />
      <input placeholder="Access Token" value={metaAccessToken} onChange={(e) => setMetaAccessToken(e.target.value)} />
      <input placeholder="Verify Token" value={metaVerifyToken} onChange={(e) => setMetaVerifyToken(e.target.value)} />
      <input placeholder="App Secret (optional)" value={metaAppSecret} onChange={(e) => setMetaAppSecret(e.target.value)} />
      <input placeholder="Webhook Secret (optional)" value={metaWebhookSecret} onChange={(e) => setMetaWebhookSecret(e.target.value)} />
      <button onClick={saveMeta}>Save Meta WhatsApp</button>
      <button onClick={() => setEnabled("WHATSAPP_META", true)}>Enable Meta</button>
      <button onClick={() => setEnabled("WHATSAPP_META", false)}>Disable Meta</button>

      <h2>Test Send</h2>
      <input placeholder="To" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
      <input placeholder="Message" value={testMessage} onChange={(e) => setTestMessage(e.target.value)} />
      <button onClick={testSend}>Send Test WhatsApp</button>

      <h3>Configured</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.provider}>{r.provider} - {r.isEnabled ? "Enabled" : "Disabled"} - updated {new Date(r.updatedAt).toLocaleString()}</li>
        ))}
      </ul>

      <pre>{result}</pre>
    </div>
  );
}
