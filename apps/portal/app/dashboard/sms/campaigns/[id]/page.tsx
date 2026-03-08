"use client";

import { useParams } from "next/navigation";
import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { mapCampaignBadgeStatus, normalizeRecipientsFromText, parseRecipientsFromCsvText } from "../utils";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignDetailPage() {
  const params = useParams<{ id: string }>();
  const campaignId = params?.id;
  const [campaign, setCampaign] = useState<any>(null);
  const [numbers, setNumbers] = useState<any[]>([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [recipientsRaw, setRecipientsRaw] = useState("");
  const [senderNumberId, setSenderNumberId] = useState("");
  const [previewData, setPreviewData] = useState<any>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const recipientSummary = useMemo(() => normalizeRecipientsFromText(recipientsRaw), [recipientsRaw]);

  async function load() {
    if (!campaignId) return;
    const token = localStorage.getItem("token") || "";
    const [campaignRes, numberRes] = await Promise.all([
      fetch(`${apiBase}/sms/campaigns/${campaignId}`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/numbers`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    const json = await campaignRes.json().catch(() => null);
    const numbersJson = await numberRes.json().catch(() => []);
    setCampaign(json);
    setNumbers(Array.isArray(numbersJson) ? numbersJson : []);
    if (json?.name) setName(json.name);
    if (json?.message) setMessage(json.message);
    if (Array.isArray(json?.messages)) {
      setRecipientsRaw(json.messages.map((m: any) => m.toNumber).join("\n"));
      const existingSenderId = json.messages.find((m: any) => !!m.fromNumberId)?.fromNumberId || "";
      const defaultSenderId = Array.isArray(numbersJson) ? (numbersJson.find((n: any) => n.isDefaultSms)?.id || "") : "";
      setSenderNumberId(existingSenderId || defaultSenderId);
    }
  }

  useEffect(() => {
    load().catch(() => setResult("Failed to load campaign"));
  }, [campaignId]);

  async function persistDraft(): Promise<boolean> {
    if (!campaignId) return false;
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, message, recipients: recipientSummary.normalizedRecipients, fromNumberId: senderNumberId || undefined })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(json?.error?.message || json?.error || "Failed to save draft"));
      return false;
    }
    setResult(JSON.stringify(json, null, 2));
    await load();
    return true;
  }

  async function saveDraft() {
    setLoading(true);
    setError("");
    await persistDraft();
    setLoading(false);
  }

  async function preview() {
    if (!campaignId) return;
    setLoading(true);
    setError("");
    const ok = await persistDraft();
    if (!ok) {
      setLoading(false);
      return;
    }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) setError(String(json?.error?.message || json?.error || "Preview failed"));
    setPreviewData(json);
    setResult(JSON.stringify(json, null, 2));
    setLoading(false);
  }

  async function send() {
    if (!campaignId) return;
    if (!window.confirm("Send this campaign now? This action will enqueue messages immediately.")) return;
    setLoading(true);
    setError("");
    const ok = await persistDraft();
    if (!ok) {
      setLoading(false);
      return;
    }
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns/${campaignId}/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(json?.error?.message || json?.error || "Send failed"));
      setResult(JSON.stringify(json, null, 2));
      setLoading(false);
      return;
    }
    setResult(JSON.stringify(json, null, 2));
    await load();
    setLoading(false);
  }

  function onCsvUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((csvText) => {
      const parsed = parseRecipientsFromCsvText(csvText);
      setRecipientsRaw((prev) => `${prev}\n${parsed}`.trim());
    }).catch(() => setError("Failed to parse CSV file"));
  }

  async function duplicateDraft() {
    if (!campaign) return;
    const token = localStorage.getItem("token") || "";
    const recipients = Array.isArray(campaign.messages) ? campaign.messages.map((m: any) => m.toNumber) : [];
    const res = await fetch(`${apiBase}/sms/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: `${campaign.name} (Copy)`,
        message: campaign.message,
        recipients,
        fromNumberId: senderNumberId || undefined,
        audienceType: "manual",
        autoSend: false
      })
    });
    const json = await res.json().catch(() => ({}));
    setResult(JSON.stringify(json, null, 2));
  }

  return (
    <div className="card">
      <h1>Campaign Detail</h1>
      <p>Status: <span className={`status-chip ${mapCampaignBadgeStatus(String(campaign?.uiStatus || campaign?.status || "")) === "FAILED" || mapCampaignBadgeStatus(String(campaign?.uiStatus || campaign?.status || "")) === "BLOCKED" ? "failed" : mapCampaignBadgeStatus(String(campaign?.uiStatus || campaign?.status || "")) === "SENT" ? "live" : "pending"}`}>{mapCampaignBadgeStatus(String(campaign?.uiStatus || campaign?.status || ""))}</span></p>
      <p>Sender: <strong>{campaign?.sender?.phoneNumber || campaign?.fromNumber || "-"}</strong> | Recipients: <strong>{campaign?.metrics?.total || 0}</strong> | Created: <strong>{campaign?.createdAt ? new Date(campaign.createdAt).toLocaleString() : "-"}</strong></p>
      {campaign?.sentAt ? <p>Sent: <strong>{new Date(campaign.sentAt).toLocaleString()}</strong></p> : null}

      <label>
        Sender number
        <select value={senderNumberId} onChange={(e) => setSenderNumberId(e.target.value)}>
          <option value="">Select sender</option>
          {numbers.map((n) => (
            <option key={n.id} value={n.id}>{n.phoneNumber}{n.isDefaultSms ? " (default)" : ""}</option>
          ))}
        </select>
      </label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Campaign name" />
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Message" />
      <textarea value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)} placeholder="Recipients (line/space/comma separated E.164 numbers)" />
      <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} />
      <p>Total: <strong>{recipientSummary.totalInput}</strong> | Valid: <strong>{recipientSummary.validCount}</strong> | Invalid: <strong>{recipientSummary.invalidCount}</strong> | Duplicates removed: <strong>{recipientSummary.duplicateCount}</strong></p>

      <button onClick={saveDraft} disabled={loading}>{loading ? "Saving..." : "Save Draft"}</button>
      <button onClick={preview} disabled={loading}>Preview</button>
      <button onClick={send} disabled={loading}>Send</button>
      <button onClick={duplicateDraft} disabled={loading || !campaign}>Duplicate Draft</button>

      {previewData?.warnings?.length ? (
        <div>
          <h3>Preview warnings</h3>
          <ul>{previewData.warnings.map((w: any) => <li key={w.code}>{w.code}: {w.message}</li>)}</ul>
        </div>
      ) : null}
      {campaign?.metrics ? <p>Recent stats: total {campaign.metrics.total}, sent {campaign.metrics.sent}, delivered {campaign.metrics.delivered}, failed {campaign.metrics.failed}</p> : null}
      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
      <pre>{result}</pre>
    </div>
  );
}
