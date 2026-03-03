"use client";

import { useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignNewPage() {
  const [name, setName] = useState("New campaign");
  const [message, setMessage] = useState("Hello from Connect Communications");
  const [recipientsRaw, setRecipientsRaw] = useState("+15555550101\n+15555550102");
  const [result, setResult] = useState("");

  async function createDraft() {
    const token = localStorage.getItem("token") || "";
    const recipients = recipientsRaw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const res = await fetch(`${apiBase}/sms/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, message, recipients, audienceType: "manual", autoSend: false })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
  }

  return (
    <div className="card">
      <h1>New SMS Campaign</h1>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message" />
      <textarea value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)} placeholder="One recipient per line" />
      <button onClick={createDraft}>Create Draft</button>
      <pre>{result}</pre>
    </div>
  );
}
