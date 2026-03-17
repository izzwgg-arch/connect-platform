"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { PageHeader } from "../../../../components/PageHeader";
import { DetailCard } from "../../../../components/DetailCard";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import { StatusChip } from "../../../../components/StatusChip";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiGet, apiPost } from "../../../../services/apiClient";

// ── Types ─────────────────────────────────────────────────────────────────────

type CampaignStatus = "draft" | "pending_approval" | "approved" | "rejected" | "sending" | "sent" | "paused";

interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  message: string;
  recipientCount: number;
  sentCount: number;
  optOutCount: number;
  businessName: string;
  tenDlcStatus: "not_registered" | "pending" | "approved";
  scheduledAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface TenDlcStatus {
  status: "not_registered" | "pending" | "approved" | "rejected";
  campaignType?: string;
  brand?: string;
  rejectionReason?: string;
}

const STATUS_COLOR: Record<CampaignStatus, "default" | "success" | "warning" | "danger" | "info"> = {
  draft:            "default",
  pending_approval: "warning",
  approved:         "info",
  rejected:         "danger",
  sending:          "info",
  sent:             "success",
  paused:           "warning",
};

// ── Compliance Gate ───────────────────────────────────────────────────────────

function ComplianceGate({ tenDlc, children }: { tenDlc: TenDlcStatus; children: React.ReactNode }) {
  if (tenDlc.status === "approved") return <>{children}</>;

  return (
    <div className="panel stack" style={{ gap: 14, border: "1px solid var(--warning)", padding: "20px 24px" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ fontSize: 28, lineHeight: 1 }}>⚠</div>
        <div>
          <h3 style={{ fontSize: 16, fontWeight: 650, color: "var(--warning)", marginBottom: 6 }}>
            10DLC Registration Required
          </h3>
          <p style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
            The FCC and US carriers require all commercial SMS senders to register with the 10-Digit Long Code (10DLC)
            program before sending campaign messages. Sending without registration risks message blocking and carrier
            filtering.
          </p>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%",
                background: tenDlc.status === "pending" ? "var(--warning)" : "var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, color: tenDlc.status === "pending" ? "#fff" : "var(--text-dim)",
                flexShrink: 0,
              }}>
                {tenDlc.status === "pending" ? "…" : "1"}
              </span>
              <span style={{ color: tenDlc.status === "pending" ? "var(--text)" : "var(--text-dim)" }}>
                Register your brand and campaign via 10DLC
              </span>
              {tenDlc.status === "pending" ? (
                <StatusChip label="Under Review" color="warning" />
              ) : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%",
                background: "var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, color: "var(--text-dim)",
                flexShrink: 0,
              }}>2</span>
              <span style={{ color: "var(--text-dim)" }}>Approval takes 2–5 business days</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <span style={{
                width: 20, height: 20, borderRadius: "50%",
                background: "var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, color: "var(--text-dim)",
                flexShrink: 0,
              }}>3</span>
              <span style={{ color: "var(--text-dim)" }}>Once approved, SMS campaigns are unlocked</span>
            </div>
          </div>
          {tenDlc.status === "not_registered" ? (
            <div className="row-actions" style={{ marginTop: 14 }}>
              <Link className="btn" href="/settings/messaging">Complete 10DLC Registration →</Link>
            </div>
          ) : tenDlc.status === "pending" ? (
            <div style={{ marginTop: 14, fontSize: 13, color: "var(--warning)" }}>
              Your 10DLC application is under review. Check back in 2–5 business days.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Message Preview ───────────────────────────────────────────────────────────

function MessagePreview({ message, businessName }: { message: string; businessName: string }) {
  const optOutLine = "\n\nReply STOP to opt out.";
  const fromLine = businessName ? `[${businessName}] ` : "";
  const full = `${fromLine}${message}${optOutLine}`;
  const charCount = full.length;
  const smsSegments = Math.ceil(charCount / 160);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "var(--text-dim)" }}>
        <span>Message preview (with required opt-out)</span>
        <span style={{ color: charCount > 320 ? "var(--warning)" : undefined }}>
          {charCount} chars · {smsSegments} SMS segment{smsSegments !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={{
        background: "var(--panel-2)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
        fontSize: 13,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "monospace",
      }}>
        {full}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-dim)", display: "flex", gap: 10 }}>
        <span style={{ color: "var(--success)" }}>✓ Business identification included</span>
        <span style={{ color: "var(--success)" }}>✓ Opt-out instructions included</span>
      </div>
    </div>
  );
}

// ── Create Campaign Form ──────────────────────────────────────────────────────

function CreateCampaignForm({
  onCreated,
  businessName,
}: {
  onCreated: () => void;
  businessName: string;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [csvText, setCsvText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const fileRef = useRef<HTMLInputElement>(null);

  const recipientLines = csvText.trim().split("\n").filter((l) => l.trim().length > 7);

  async function handleSubmit() {
    if (!name.trim()) { setError("Campaign name is required."); return; }
    if (!message.trim()) { setError("Message body is required."); return; }
    if (recipientLines.length === 0) { setError("Add at least one recipient."); return; }
    setSaving(true);
    setError("");
    try {
      await apiPost("/sms/campaigns", {
        name: name.trim(),
        message: message.trim(),
        recipients: recipientLines.map((l) => l.trim()),
        status: "draft",
      });
      onCreated();
    } catch (err: any) {
      setError(err?.message || "Failed to create campaign.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel stack" style={{ gap: 18 }}>
      {/* Step indicator */}
      <div style={{ display: "flex", gap: 0 }}>
        {([1, 2, 3] as const).map((s) => (
          <div
            key={s}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              fontSize: 12,
              fontWeight: step === s ? 650 : 400,
              color: step === s ? "var(--accent)" : step > s ? "var(--success)" : "var(--text-dim)",
              borderBottom: `2px solid ${step === s ? "var(--accent)" : step > s ? "var(--success)" : "var(--border)"}`,
              cursor: "pointer",
            }}
            onClick={() => setStep(s)}
          >
            {step > s ? "✓ " : `${s}. `}
            {s === 1 ? "Campaign Info" : s === 2 ? "Message & Preview" : "Recipients & Send"}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 1 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label className="label">Campaign Name *</label>
            <input className="input" placeholder="e.g. March 2026 Promo" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row-actions">
            <button className="btn" onClick={() => { if (name.trim()) { setStep(2); setError(""); } else setError("Enter a name."); }}>
              Next: Message →
            </button>
          </div>
        </div>
      ) : null}

      {/* Step 2 */}
      {step === 2 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label className="label">Message Body *</label>
            <textarea
              className="input"
              style={{ minHeight: 100, resize: "vertical" }}
              placeholder="Enter your message. Business name and opt-out text will be appended automatically."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
              Do not include business name or opt-out instructions — they are added automatically.
            </p>
          </div>
          {message.trim() ? (
            <MessagePreview message={message} businessName={businessName} />
          ) : null}
          <div className="row-actions">
            <button className="btn ghost" onClick={() => setStep(1)}>← Back</button>
            <button className="btn" onClick={() => { if (message.trim()) { setStep(3); setError(""); } else setError("Enter a message."); }}>
              Next: Recipients →
            </button>
          </div>
        </div>
      ) : null}

      {/* Step 3 */}
      {step === 3 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label className="label" style={{ marginBottom: 0 }}>Recipients (one phone number per line)</label>
              <button className="btn ghost" style={{ fontSize: 12 }} onClick={() => fileRef.current?.click()}>
                Import CSV
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = (ev) => setCsvText(String(ev.target?.result ?? ""));
                  reader.readAsText(file);
                }}
              />
            </div>
            <textarea
              className="input"
              style={{ minHeight: 140, resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
              placeholder="+15551234567&#10;+15559876543&#10;..."
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4, display: "flex", gap: 12 }}>
              <span>{recipientLines.length} valid phone number{recipientLines.length !== 1 ? "s" : ""}</span>
              <span style={{ color: "var(--success)" }}>✓ STOP opt-outs tracked automatically</span>
            </div>
          </div>

          {/* Legal disclaimer */}
          <div style={{
            background: "rgba(240,182,85,0.08)",
            border: "1px solid var(--warning)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--text-dim)",
          }}>
            <strong style={{ color: "var(--warning)" }}>Legal compliance:</strong> By sending this campaign you confirm that all recipients
            have opted in to receive SMS messages from your business, and that you are compliant with TCPA, CAN-SPAM,
            and carrier 10DLC requirements. Campaigns without opt-in consent may result in number suspension.
          </div>

          {error ? <div className="chip danger">{error}</div> : null}
          <div className="row-actions">
            <button className="btn ghost" onClick={() => setStep(2)}>← Back</button>
            <button
              className="btn"
              onClick={handleSubmit}
              disabled={saving || recipientLines.length === 0 || !message.trim()}
            >
              {saving ? "Creating…" : "Create Campaign (Draft)"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Campaign Table ────────────────────────────────────────────────────────────

function CampaignRow({ c }: { c: Campaign }) {
  const pct = c.recipientCount > 0 ? Math.round((c.sentCount / c.recipientCount) * 100) : 0;

  return (
    <tr style={{ borderBottom: "1px solid var(--border)" }}>
      <td style={{ padding: "10px 12px" }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>{c.name}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.businessName}</div>
      </td>
      <td style={{ padding: "10px 12px" }}>
        <StatusChip label={c.status.replace(/_/g, " ")} color={STATUS_COLOR[c.status]} />
      </td>
      <td style={{ padding: "10px 12px", fontSize: 13 }}>{c.recipientCount.toLocaleString()}</td>
      <td style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            flex: 1,
            height: 6,
            background: "var(--panel-2)",
            borderRadius: 3,
            overflow: "hidden",
          }}>
            <div style={{ width: `${pct}%`, height: "100%", background: "var(--success)", borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 12, color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {c.sentCount.toLocaleString()} ({pct}%)
          </span>
        </div>
      </td>
      <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-dim)" }}>{c.optOutCount}</td>
      <td style={{ padding: "10px 12px", fontSize: 12, color: "var(--text-dim)" }}>
        {new Date(c.createdAt).toLocaleDateString()}
      </td>
      <td style={{ padding: "10px 12px" }}>
        <div style={{ display: "flex", gap: 6 }}>
          {c.status === "draft" || c.status === "rejected" ? (
            <button className="btn ghost" style={{ fontSize: 12 }}>Edit</button>
          ) : null}
          {c.status === "approved" ? (
            <button className="btn" style={{ fontSize: 12 }}>Send Now</button>
          ) : null}
          {c.status === "draft" ? (
            <button className="btn ghost" style={{ fontSize: 12 }}>Submit for Approval</button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SmsCampaignsPage() {
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [opMsg, setOpMsg] = useState("");

  const tenDlcState = useAsyncResource<{ submission: TenDlcStatus }>(
    () => apiGet("/ten-dlc/status"),
    []
  );

  const campaignsState = useAsyncResource<{ campaigns: Campaign[] }>(
    () => apiGet("/sms/campaigns"),
    [reloadKey]
  );

  const tenDlc: TenDlcStatus = tenDlcState.status === "success"
    ? (tenDlcState.data.submission ?? { status: "not_registered" })
    : { status: "not_registered" };

  const campaigns: Campaign[] = campaignsState.status === "success"
    ? (campaignsState.data.campaigns ?? [])
    : [];

  const businessName = (tenDlcState.status === "success" ? tenDlcState.data.submission?.brand : undefined) ?? "";

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="SMS Campaigns"
        subtitle="Create and manage compliant mass SMS campaigns. 10DLC registration required for campaign sending."
        actions={
          tenDlc.status === "approved" ? (
            <button className="btn" onClick={() => { setShowCreate((v) => !v); setOpMsg(""); }}>
              {showCreate ? "Cancel" : "+ New Campaign"}
            </button>
          ) : null
        }
      />

      {opMsg ? <div className="chip success" style={{ alignSelf: "flex-start" }}>{opMsg}</div> : null}

      {/* 10DLC Gate */}
      <ComplianceGate tenDlc={tenDlc}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <span style={{ color: "var(--success)" }}>✓ 10DLC Approved</span>
          {tenDlc.campaignType ? <span className="chip success" style={{ fontSize: 11 }}>{tenDlc.campaignType}</span> : null}
          <Link href="/settings/messaging" style={{ fontSize: 12, color: "var(--accent)" }}>Manage Registration</Link>
        </div>
      </ComplianceGate>

      {/* Create form */}
      {showCreate && tenDlc.status === "approved" ? (
        <CreateCampaignForm
          businessName={businessName}
          onCreated={() => {
            setShowCreate(false);
            setReloadKey((k) => k + 1);
            setOpMsg("Campaign created as draft. Submit it for approval before sending.");
          }}
        />
      ) : null}

      {/* Campaigns table */}
      {tenDlc.status === "approved" ? (
        <div className="panel" style={{ overflow: "hidden" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
            <h3 style={{ fontSize: 15, fontWeight: 650 }}>All Campaigns</h3>
          </div>
          {campaignsState.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
          {campaignsState.status === "error" ? <ErrorState message={campaignsState.error} /> : null}
          {campaignsState.status === "success" && campaigns.length === 0 ? (
            <EmptyState title="No campaigns yet" message="Create your first campaign to start sending." />
          ) : null}
          {campaignsState.status === "success" && campaigns.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--panel-2)", fontSize: 12, color: "var(--text-dim)" }}>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Campaign</th>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Status</th>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Recipients</th>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Progress</th>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Opt-outs</th>
                    <th style={{ textAlign: "left", padding: "8px 12px" }}>Created</th>
                    <th style={{ width: 120 }} />
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => <CampaignRow key={c.id} c={c} />)}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Opt-out info */}
      <DetailCard title="Opt-out Compliance">
        <div style={{ fontSize: 13, color: "var(--text-dim)", lineHeight: 1.7 }}>
          <p>Every outgoing campaign message automatically appends: <em>"Reply STOP to opt out."</em></p>
          <p style={{ marginTop: 8 }}>When a recipient replies STOP (or UNSUBSCRIBE, CANCEL, END, QUIT), they are automatically:</p>
          <ul style={{ paddingLeft: 18, marginTop: 6 }}>
            <li>Added to the opt-out list for your number</li>
            <li>Excluded from all future campaign sends</li>
            <li>Sent a one-time confirmation: <em>"You have been unsubscribed."</em></li>
          </ul>
          <p style={{ marginTop: 8, color: "var(--warning)" }}>
            You cannot override opt-outs — this is a legal requirement under TCPA and CTIA guidelines.
          </p>
        </div>
      </DetailCard>
    </div>
  );
}
