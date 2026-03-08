"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { normalizeRecipientsFromText, parseRecipientsFromCsvText } from "../utils";
import { canManageMessaging, readRoleFromToken } from "../../../../../lib/roles";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function SmsCampaignNewPage() {
  const [role, setRole] = useState("");
  const [name, setName] = useState("New campaign");
  const [message, setMessage] = useState("Hello from Connect Communications");
  const [recipientsRaw, setRecipientsRaw] = useState("+15555550101\n+15555550102");
  const [senderNumberId, setSenderNumberId] = useState("");
  const [numbers, setNumbers] = useState<any[]>([]);
  const [tenantLimits, setTenantLimits] = useState<any>(null);
  const [tenantMode, setTenantMode] = useState<any>(null);
  const [mode, setMode] = useState<"paste" | "textarea" | "csv">("textarea");
  const [segment, setSegment] = useState<"" | "overdue" | "unpaid" | "whatsapp">("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);

  const summary = useMemo(() => normalizeRecipientsFromText(recipientsRaw), [recipientsRaw]);
  const guardrailWarnings = useMemo(() => {
    const warnings: string[] = [];
    if (tenantLimits?.limits?.maxCampaignSize && summary.validCount > tenantLimits.limits.maxCampaignSize) {
      warnings.push(`Campaign exceeds max size (${tenantLimits.limits.maxCampaignSize}).`);
    }
    if (tenantLimits?.suspension?.smsSuspended) warnings.push("Tenant SMS sending is suspended.");
    if (!senderNumberId && tenantMode?.smsSendMode === "LIVE") warnings.push("LIVE mode requires a sender number.");
    return warnings;
  }, [summary.validCount, tenantLimits, tenantMode, senderNumberId]);

  useEffect(() => {
    setRole(readRoleFromToken());
    const token = localStorage.getItem("token") || "";
    Promise.all([
      fetch(`${apiBase}/numbers`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/settings/sms-limits`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/settings/sms-mode`, { headers: { Authorization: `Bearer ${token}` } })
    ])
      .then(async ([numbersRes, limitsRes, modeRes]) => {
        const numbersJson = await numbersRes.json().catch(() => []);
        const limitsJson = await limitsRes.json().catch(() => null);
        const modeJson = await modeRes.json().catch(() => null);
        setNumbers(Array.isArray(numbersJson) ? numbersJson : []);
        setTenantLimits(limitsJson);
        setTenantMode(modeJson);
        const defaultNumber = Array.isArray(numbersJson) ? numbersJson.find((n) => n.isDefaultSms) : null;
        if (defaultNumber?.id) setSenderNumberId(defaultNumber.id);
      })
      .catch(() => undefined);
  }, []);

  if (role && !canManageMessaging(role)) {
    return <div className="card"><h1>New SMS Campaign</h1><p>Access denied.</p></div>;
  }

  function onCsvUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((csvText) => {
      const parsed = parseRecipientsFromCsvText(csvText);
      setRecipientsRaw((prev) => `${prev}\n${parsed}`.trim());
      setMode("csv");
    }).catch(() => setResult("Failed to parse CSV file."));
  }

  async function createDraft() {
    if (summary.validCount === 0) {
      setResult("Add at least one valid E.164 recipient.");
      return;
    }
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/sms/campaigns`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name,
        message,
        recipients: summary.normalizedRecipients,
        audienceType: "manual",
        fromNumberId: senderNumberId || undefined,
        autoSend: false
      })
    });
    setResult(JSON.stringify(await res.json(), null, 2));
    setLoading(false);
  }

  async function importFromSegment(nextSegment: "overdue" | "unpaid" | "whatsapp") {
    setLoading(true);
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/customers/segments/targeting?segment=${nextSegment}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setResult(String(json?.error || "Failed to import segment recipients."));
      setLoading(false);
      return;
    }
    const merged = `${recipientsRaw}\n${Array.isArray(json.recipients) ? json.recipients.join("\n") : ""}`.trim();
    setRecipientsRaw(merged);
    setSegment(nextSegment);
    setMode("textarea");
    setResult(`Imported ${Array.isArray(json.recipients) ? json.recipients.length : 0} recipients from ${nextSegment} segment.`);
    setLoading(false);
  }

  return (
    <div className="card">
      <h1>New SMS Campaign</h1>
      <p>Create a draft first, then preview and send from the detail page.</p>

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

      <div style={{ marginTop: 12, marginBottom: 8 }}>
        <button onClick={() => setMode("paste")} disabled={mode === "paste"}>Paste numbers</button>
        <button onClick={() => setMode("textarea")} disabled={mode === "textarea"}>Textarea import</button>
        <button onClick={() => setMode("csv")} disabled={mode === "csv"}>CSV upload</button>
      </div>
      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <button onClick={() => importFromSegment("overdue")} disabled={loading}>Import overdue customers</button>
        <button onClick={() => importFromSegment("unpaid")} disabled={loading}>Import unpaid invoice customers</button>
        <button onClick={() => importFromSegment("whatsapp")} disabled={loading}>Import customers with WhatsApp</button>
        {segment ? <span> Segment: {segment}</span> : null}
      </div>

      {mode === "csv" ? <input type="file" accept=".csv,text/csv" onChange={onCsvUpload} /> : null}
      <textarea value={recipientsRaw} onChange={(e) => setRecipientsRaw(e.target.value)} placeholder="Recipients in E.164 format, separated by line/space/comma" />

      <p>
        Total: <strong>{summary.totalInput}</strong> | Valid: <strong>{summary.validCount}</strong> | Invalid: <strong>{summary.invalidCount}</strong> | Duplicates removed: <strong>{summary.duplicateCount}</strong>
      </p>
      {summary.invalidRecipients.length > 0 ? <p className="status-chip failed" style={{ borderRadius: 2 }}>Invalid sample: {summary.invalidRecipients.slice(0, 5).join(", ")}</p> : null}
      {guardrailWarnings.map((w) => <p key={w} className="status-chip pending" style={{ borderRadius: 2 }}>{w}</p>)}

      <button onClick={createDraft} disabled={loading || summary.validCount === 0}>
        {loading ? "Saving..." : "Save Draft"}
      </button>
      <pre>{result}</pre>
    </div>
  );
}
