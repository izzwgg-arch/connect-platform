"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params?.id;
  const [campaign, setCampaign] = useState<any>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState("");

  async function load() {
    if (!campaignId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    setCampaign(json);
    if (json?.name) setName(json.name);
    if (json?.message) setMessage(json.message);
  }

  useEffect(() => {
    load().catch(() => setResult("Failed to load campaign"));
  }, [campaignId]);

  async function saveDraft() {
    if (!campaignId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, message })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  async function preview() {
    if (!campaignId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  async function send() {
    if (!campaignId) return;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  return (
    <div className="card">
      <h1>Campaign Detail</h1>
      <p>Status: <strong>{campaign?.status || "-"}</strong></p>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message" />
      <button onClick={saveDraft}>Save Draft</button>
      <button onClick={preview}>Preview</button>
      <button onClick={send}>Send</button>
      {campaign?.metrics ? <p>Metrics: total {campaign.metrics.total}, sent {campaign.metrics.sent}, delivered {campaign.metrics.delivered}, failed {campaign.metrics.failed}</p> : null}
      <pre>{result}</pre>
    </div>
  );
}
