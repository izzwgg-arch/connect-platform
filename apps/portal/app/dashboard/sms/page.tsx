"use client";

import { FormEvent, useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsPage() {
  const [name, setName] = useState("Spring Promo");
  const [fromNumber, setFromNumber] = useState("+17025550100");
  const [message, setMessage] = useState("Hello from Connect Communications.");
  const [recipientsRaw, setRecipientsRaw] = useState("+17025550111\n+17025550112\n+17025550113");
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>("");
  const [messages, setMessages] = useState<any[]>([]);
  const [result, setResult] = useState("");

  async function loadCampaigns() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json();
    setCampaigns(Array.isArray(json) ? json : []);
  }

  async function loadMessages(campaignId: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/messages?campaignId=${encodeURIComponent(campaignId)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json();
    setMessages(Array.isArray(json) ? json : []);
  }

  useEffect(() => {
    loadCampaigns();
  }, []);

  useEffect(() => {
    if (selectedCampaignId) loadMessages(selectedCampaignId);
  }, [selectedCampaignId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const recipients = recipientsRaw.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, fromNumber, message, audienceType: "manual", recipients })
    });
    const json = await res.json();
    setResult(JSON.stringify(json, null, 2));
    await loadCampaigns();
  }

  return (
    <div className="card">
      <h1>SMS Campaigns</h1>
      <form onSubmit={onSubmit}>
        <input placeholder="Campaign Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="From Number" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} />
        <textarea placeholder="Message" value={message} onChange={(e) => setMessage(e.target.value)} />
        <textarea placeholder="Recipients (one number per line)" value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)} />
        <button type="submit">Queue Campaign</button>
      </form>

      <h2>Campaigns</h2>
      <ul>
        {campaigns.map((c) => (
          <li key={c.id}>
            <button onClick={() => setSelectedCampaignId(c.id)}>{c.name} - {c.status}</button>
          </li>
        ))}
      </ul>

      <h2>Messages</h2>
      <ul>
        {messages.map((m) => (
          <li key={m.id}>{m.toNumber} - {m.status}{m.error ? ` (${m.error})` : ""}</li>
        ))}
      </ul>

      <pre>{result}</pre>
    </div>
  );
}
