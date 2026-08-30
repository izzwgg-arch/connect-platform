"use client";

/**
 * Admin → Onboarding → Port queue — the manual half of SignalWire porting.
 *
 * SignalWire has NO porting API, so every port-in sign-up lands here as a
 * complete ready-to-file package: the carrier account fields, the customer's
 * typed LOA signature (downloadable as a generated PDF), and the uploaded
 * bill. Filing is a 2-minute task in the SignalWire dashboard; "Mark filed"
 * stamps OUR record (it never touches a carrier). The screen also lists the
 * 10DLC texting registrations — including the sole-proprietor rows a person
 * must file by hand.
 *
 * SUPER_ADMIN only (the api routes refuse everyone else; the screen renders
 * the refusal honestly rather than an empty queue).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPost, getPortalApiBaseUrl } from "../../../../../services/apiClient";
import "./ports.css";

type PortRow = {
  submissionId: string;
  companyName: string;
  status: string;
  requestedAt: string | null;
  filedAt: string | null;
  portReference: string | null;
  portedDid: string;
  temporaryDid: string;
  carrier: string;
  accountNumber: string;
  nameOnAccount: string;
  isMobile: boolean;
  portPin: string;
  serviceAddress: string;
  loaSignature: string;
  files: Array<{ id: string; filename: string; kind: string | null }>;
};

type RegRow = {
  id: string;
  submissionId: string | null;
  companyName: string;
  classification: string;
  senderSystem: string | null;
  status: string;
  brandState: string | null;
  campaignState: string | null;
  phoneE164: string | null;
  error: string | null;
};

function regPillClass(status: string): string {
  if (status === "active") return "ok";
  if (status === "failed") return "bad";
  return "pending";
}

export default function AdminPortQueuePage() {
  const [queue, setQueue] = useState<PortRow[] | null>(null);
  const [regs, setRegs] = useState<RegRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [q, r] = await Promise.all([
        apiGet<{ queue: PortRow[] }>("/admin/onboarding/port-queue"),
        apiGet<{ registrations: RegRow[] }>("/admin/onboarding/sms-registrations"),
      ]);
      setQueue(q.queue || []);
      setRegs(r.registrations || []);
      setError(null);
    } catch (e: any) {
      setError(e instanceof ApiError && e.status === 403
        ? "This screen is for the platform owner."
        : "Couldn't load the port queue. Refresh to try again.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function markFiled(submissionId: string) {
    setBusy(submissionId);
    try {
      await apiPost(`/admin/onboarding/submissions/${encodeURIComponent(submissionId)}/port-filed`, {
        portReference: (refs[submissionId] || "").trim() || undefined,
      });
      await load();
    } catch (e: any) {
      setError(e?.body?.message || "Couldn't mark it filed — try again.");
    } finally {
      setBusy(null);
    }
  }

  const apiBase = getPortalApiBaseUrl();
  // ⛔ A bare <a> sends no Authorization header — the token rides the query
  // string (the api's global preHandler copies ?token= into Authorization; the
  // proven recordings/invoice-PDF pattern).
  function authedUrl(path: string): string {
    const token =
      (typeof window !== "undefined" &&
        (localStorage.getItem("token") || localStorage.getItem("cc-token") || localStorage.getItem("authToken"))) ||
      "";
    return `${apiBase}${path}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }
  const waiting = (queue || []).filter((r) => r.status === "awaiting_manual_filing");
  const done = (queue || []).filter((r) => r.status !== "awaiting_manual_filing");
  const soleProps = (regs || []).filter((r) => r.classification === "sole_prop" && r.status !== "active");

  return (
    <div className="op-root">
      <h1 className="op-title">Port queue</h1>
      <p className="op-sub">
        SignalWire ports are filed by hand in their dashboard (they have no porting API). Each card is a
        complete package: download the signed LOA and the bill, file it, then mark it filed. The customer is
        already live on their temporary number — nothing here is waiting on them.{" "}
        <Link href="/admin/onboarding" style={{ color: "var(--accent)" }}>Back to sign-ups</Link>
      </p>
      {error && <div className="op-err">{error}</div>}

      <div className="op-section">Waiting to be filed ({waiting.length})</div>
      {queue !== null && waiting.length === 0 && <div className="op-empty">Nothing waiting — every port package has been filed.</div>}
      {waiting.map((r) => (
        <div className="op-card" key={r.submissionId}>
          <div className="op-card-head">
            <span className="op-company">{r.companyName || "—"}</span>
            <span className="op-num">{r.portedDid}</span>
            <span className="op-pill wait">AWAITING FILING</span>
          </div>
          <div className="op-grid">
            <div><div className="op-k">Current carrier</div><div className="op-v">{r.carrier || "—"}</div></div>
            <div><div className="op-k">Account number</div><div className="op-v">{r.accountNumber || "—"}</div></div>
            <div><div className="op-k">{r.isMobile ? "Transfer PIN (cell)" : "PIN"}</div><div className="op-v">{r.portPin || "—"}</div></div>
            <div><div className="op-k">Name on account</div><div className="op-v">{r.nameOnAccount || "—"}</div></div>
            <div><div className="op-k">Service address</div><div className="op-v">{r.serviceAddress || "—"}</div></div>
            <div><div className="op-k">Temporary number</div><div className="op-v">{r.temporaryDid || "—"}</div></div>
            <div><div className="op-k">Signed (typed)</div><div className="op-v op-sig">{r.loaSignature || "—"}</div></div>
          </div>
          <div className="op-actions">
            <a className="op-btn" href={authedUrl(`/admin/onboarding/submissions/${encodeURIComponent(r.submissionId)}/loa.pdf`)} target="_blank" rel="noreferrer">
              Download LOA (PDF)
            </a>
            {r.files.map((f) => (
              <a key={f.id} className="op-btn"
                href={authedUrl(`/admin/onboarding/submissions/${encodeURIComponent(r.submissionId)}/files/${encodeURIComponent(f.id)}/download`)}
                target="_blank" rel="noreferrer">
                {f.kind === "bill" ? "Bill" : f.kind === "loa" ? "Uploaded LOA" : "File"}: {f.filename}
              </a>
            ))}
            <input className="op-ref-input" placeholder="SignalWire order ref (optional)"
              value={refs[r.submissionId] || ""}
              onChange={(e) => setRefs((p) => ({ ...p, [r.submissionId]: e.target.value }))} />
            <button className="op-btn primary" disabled={busy === r.submissionId} onClick={() => void markFiled(r.submissionId)}>
              {busy === r.submissionId ? "Saving…" : "Mark filed"}
            </button>
          </div>
        </div>
      ))}

      {done.length > 0 && (
        <>
          <div className="op-section">Filed ({done.length})</div>
          {done.map((r) => (
            <div className="op-card" key={r.submissionId}>
              <div className="op-card-head">
                <span className="op-company">{r.companyName || "—"}</span>
                <span className="op-num">{r.portedDid}</span>
                <span className="op-pill filed">FILED{r.portReference ? ` · ${r.portReference}` : ""}</span>
              </div>
            </div>
          ))}
        </>
      )}

      <div className="op-section">Texting registrations (10DLC)</div>
      {soleProps.length > 0 && (
        <p className="op-sub" style={{ marginBottom: 10 }}>
          <b style={{ color: "var(--warning)" }}>{soleProps.length} sole-proprietor registration{soleProps.length > 1 ? "s" : ""}</b>{" "}
          need a person — no EIN, so the registry filing is manual (limited class, ~1,000 messages/day).
        </p>
      )}
      {regs !== null && regs.length === 0 && <div className="op-empty">No texting registrations yet.</div>}
      {regs !== null && regs.length > 0 && (
        <div className="op-wrap-x">
          <table className="op-table">
            <thead><tr><th>Company</th><th>Class</th><th>Sender</th><th>Brand</th><th>Campaign</th><th>Number</th><th>Status</th></tr></thead>
            <tbody>
              {regs.map((r) => (
                <tr key={r.id}>
                  <td>{r.companyName || "—"}</td>
                  <td>{r.classification}</td>
                  <td>{r.senderSystem || "—"}</td>
                  <td>{r.brandState || "—"}</td>
                  <td>{r.campaignState || "—"}</td>
                  <td>{r.phoneE164 || "—"}</td>
                  <td>
                    <span className={`st ${regPillClass(r.status)}`}>{r.status}</span>
                    {r.error && <span style={{ color: "var(--danger)", marginLeft: 6, fontSize: 11.5 }}>{r.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
