"use client";

import { useEffect, useMemo, useState } from "react";
import { canManageBilling, readRoleFromToken } from "../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function EmailSettingsPage() {
  const [role, setRole] = useState("");
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);
  const [provider, setProvider] = useState<"SENDGRID" | "SMTP" | "GOOGLE_WORKSPACE">("GOOGLE_WORKSPACE");
  const [fromName, setFromName] = useState("Connect Communications");
  const [fromEmail, setFromEmail] = useState("billing@connectcomunications.com");
  const [replyTo, setReplyTo] = useState("support@connectcomunications.com");
  const [logoUrl, setLogoUrl] = useState("");
  const [footerText, setFooterText] = useState("Thank you for using Connect Communications.");

  const [sendgridApiKey, setSendgridApiKey] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpSecure, setSmtpSecure] = useState(false);

  const [result, setResult] = useState("");

  async function load() {
    if (!token) return;
    const res = await fetch(`${apiBase}/settings/email`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => ({}));
    if (!json?.configured || !json?.config) return;

    const c = json.config;
    setProvider((c.provider as "SENDGRID" | "SMTP" | "GOOGLE_WORKSPACE") || "GOOGLE_WORKSPACE");
    setFromName(c.fromName || "Connect Communications");
    setFromEmail(c.fromEmail || "billing@connectcomunications.com");
    setReplyTo(c.replyTo || "support@connectcomunications.com");
    setLogoUrl(c.logoUrl || "");
    setFooterText(c.footerText || "");

    if (c.masked?.smtpPort) setSmtpPort(Number(c.masked.smtpPort));
  }

  useEffect(() => {
    setRole(readRoleFromToken());
    load().catch(() => setResult("Failed to load email settings"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (role && !canManageBilling(role)) {
    return <div className="card"><h1>Email Settings</h1><p>Access denied.</p></div>;
  }


  useEffect(() => {
    if (provider !== "GOOGLE_WORKSPACE") return;
    if (!smtpHost) setSmtpHost("smtp-relay.gmail.com");
    if (!smtpPort) setSmtpPort(587);
  }, [provider, smtpHost, smtpPort]);

  async function save() {
    const body: any = { provider, fromName, fromEmail, replyTo, logoUrl: logoUrl || null, footerText: footerText || null };
    if (provider === "SENDGRID") {
      if (sendgridApiKey.trim()) body.sendgridApiKey = sendgridApiKey.trim();
    } else {
      if (smtpHost.trim()) body.smtpHost = smtpHost.trim();
      body.smtpPort = Number(smtpPort || 587);
      if (smtpUser.trim()) body.smtpUser = smtpUser.trim();
      if (smtpPass.trim()) body.smtpPass = smtpPass;
      body.smtpSecure = smtpSecure;
    }

    const res = await fetch(`${apiBase}/settings/email`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setSendgridApiKey("");
    setSmtpPass("");
  }

  async function testProvider() {
    const res = await fetch(`${apiBase}/settings/email/test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  return (
    <div className="card">
      <h1>Email Settings</h1>
      <p>Configure email provider and sender profile for receipts, invoices, and decline notices.</p>

      <label>Provider </label>
      <select value={provider} onChange={(e) => setProvider(e.target.value === "SMTP" ? "SMTP" : e.target.value === "GOOGLE_WORKSPACE" ? "GOOGLE_WORKSPACE" : "SENDGRID") }>
        <option value="SENDGRID">SENDGRID</option>
        <option value="SMTP">SMTP</option>
        <option value="GOOGLE_WORKSPACE">GOOGLE_WORKSPACE</option>
      </select>

      <h3>Sender Profile</h3>
      <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="From name" />
      <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="From email" />
      <input value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="Reply-to" />
      <input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="Logo URL (optional)" />
      <input value={footerText} onChange={(e) => setFooterText(e.target.value)} placeholder="Footer text" />

      {provider === "SENDGRID" ? (
        <>
          <h3>SendGrid</h3>
          <input type="password" value={sendgridApiKey} onChange={(e) => setSendgridApiKey(e.target.value)} placeholder="SendGrid API key" />
        </>
      ) : (
        <>
          <h3>{provider === "GOOGLE_WORKSPACE" ? "Google Workspace SMTP" : "SMTP"}</h3>
          {provider === "GOOGLE_WORKSPACE" ? <p>Use your Google Workspace SMTP relay/app credentials.</p> : null}
          <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={provider === "GOOGLE_WORKSPACE" ? "smtp-relay.gmail.com" : "SMTP host"} />
          <input type="number" value={smtpPort} onChange={(e) => setSmtpPort(Number(e.target.value || 587))} placeholder="SMTP port" />
          <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="SMTP username" />
          <input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="SMTP password" />
          <label><input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} /> Use TLS/secure SMTP</label>
        </>
      )}

      <div style={{ marginTop: 10 }}>
        <button onClick={save}>Save Email Settings</button>
        <button onClick={testProvider}>Send Test Email</button>
      </div>

      <pre>{result}</pre>
    </div>
  );
}
