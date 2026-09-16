"use client";

/**
 * Admin → 10DLC Registration — the board (2026-09-16).
 *
 * One row per customer: send the private link (copy it or email it), see where
 * each registration stands, and jump to "Review & file". "Needs you" is the
 * default filter because it is the only state waiting on staff.
 *
 * Platform staff only: the api requires a SUPER_ADMIN session AND the page's
 * keys, and this screen renders a refusal honestly instead of an empty board.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPost } from "../../../../services/apiClient";
import "./texting-registration-admin.css";

type Row = {
  id: string;
  tenantName: string | null;
  displayName: string;
  businessEmail: string;
  contactName: string | null;
  status: string;
  statusLabel: string;
  needsStaff: boolean;
  numbersCount: number;
  lastError: string | null;
  submittedAt: string | null;
  filedAt: string | null;
  liveAt: string | null;
  updatedAt: string;
  lastLink: { createdAt: string; emailedTo: string | null; emailedAt: string | null; openedAt: string | null; usedAt: string | null; revokedAt: string | null; expiresAt: string } | null;
};

type Board = {
  registrations: Row[];
  counts: Record<string, number>;
  health: {
    telnyx: { connected: boolean; publicKeySet: boolean; balance: string | null } | null;
    sweep: { lastRunAt: string | null; lastResult: { checked: number; einExpired: number } | null; lastError: string | null };
  };
};

type Customer = { id: string; name: string; registrationId: string | null; status: string | null };

const FILTERS: Array<{ id: string; label: string; match: (r: Row) => boolean }> = [
  { id: "needs", label: "Needs you", match: (r) => r.needsStaff },
  { id: "customer", label: "Waiting on customer", match: (r) => ["draft", "awaiting_customer", "needs_fix", "awaiting_pin"].includes(r.status) },
  { id: "review", label: "In review", match: (r) => ["filing", "brand_review", "campaign_review", "assigning"].includes(r.status) },
  { id: "live", label: "Live", match: (r) => r.status === "live" },
  { id: "all", label: "All", match: () => true },
];

function pillClass(status: string): string {
  if (status === "live") return "ok";
  if (["brand_failed", "campaign_rejected", "suspended", "error"].includes(status)) return "bad";
  if (["submitted", "needs_fix", "awaiting_pin"].includes(status)) return "wait";
  if (["deactivated", "draft"].includes(status)) return "off";
  return "pending";
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function nextStep(r: Row): string {
  switch (r.status) {
    case "draft": return "Create the customer's link";
    case "awaiting_customer":
      if (r.lastLink?.openedAt) return `Customer opened the link ${ago(r.lastLink.openedAt)}, not sent back yet`;
      if (r.lastLink?.emailedAt) return `Emailed ${ago(r.lastLink.emailedAt)}, not opened yet`;
      return "Link created, not sent yet";
    case "submitted": return `Customer sent it ${ago(r.submittedAt)} — review and file`;
    case "needs_fix": return "Sent back to the customer to fix";
    case "filing": return r.lastError || "Filing with Telnyx";
    case "awaiting_pin": return "Waiting for the owner to enter the texted code";
    case "brand_review": return "Registry is verifying the business";
    case "brand_failed": return "Business not verified — fix and refile";
    case "campaign_review": return "Carriers reviewing (usually 1–3 business days)";
    case "campaign_rejected": return "Campaign rejected — fix wording and appeal";
    case "assigning": return "Attaching numbers";
    case "live": return `Texting live since ${r.liveAt ? new Date(r.liveAt).toLocaleDateString() : "—"}`;
    case "suspended": return "Campaign suspended — check it";
    case "error": return r.lastError || "Needs attention";
    default: return r.statusLabel;
  }
}

export default function TextingRegistrationBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("needs");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await apiGet<Board>("/admin/texting-registration"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? "This page is for Loopcom platform staff." : (err as Error)?.message || "Couldn't load registrations.");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!adding) return;
    const t = setTimeout(async () => {
      try {
        const r = await apiGet<{ customers: Customer[] }>(`/admin/texting-registration/customers?q=${encodeURIComponent(q)}`);
        setCustomers(r.customers);
      } catch {
        setCustomers([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [adding, q]);

  useEffect(() => {
    if (board && filter === "needs" && !board.registrations.some((r) => r.needsStaff) && board.registrations.length) setFilter("all");
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board === null]);

  const rows = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter) || FILTERS[FILTERS.length - 1];
    return (board?.registrations || []).filter(f.match);
  }, [board, filter]);

  const start = async (c: Customer) => {
    if (c.registrationId) {
      window.location.href = `/admin/texting-registration/${c.registrationId}`;
      return;
    }
    setBusy(c.id);
    try {
      const r = await apiPost<{ registration: { id: string } }>("/admin/texting-registration", { tenantId: c.id });
      window.location.href = `/admin/texting-registration/${r.registration.id}?send=1`;
    } catch (err) {
      const body: any = err instanceof ApiError ? err.body : null;
      alert(body?.message || (err as Error)?.message || "Couldn't start the registration.");
    } finally {
      setBusy(null);
    }
  };

  const needs = (board?.registrations || []).filter((r) => r.needsStaff).length;
  const waiting = (board?.registrations || []).filter(FILTERS[1].match).length;
  const review = (board?.registrations || []).filter(FILTERS[2].match).length;
  const live = (board?.registrations || []).filter(FILTERS[3].match).length;
  const h = board?.health;

  return (
    <div className="trd-root">
      <div className="trd-head">
        <div>
          <h1 className="trd-title">10DLC Registration</h1>
          <p className="trd-sub">Send each customer a private link to register their business for texting, then file what they send with Telnyx. Their numbers can text customers once carriers approve.</p>
        </div>
        <button type="button" className="trd-btn primary" onClick={() => setAdding(true)}>New registration</button>
      </div>

      {error ? <div className="trd-note bad">{error}</div> : null}

      {h ? (
        <div className="trd-health">
          <span className={h.telnyx?.connected ? "" : "bad"}>{h.telnyx?.connected ? "Telnyx connected" : "Telnyx not connected"}</span>
          <span className={h.telnyx?.publicKeySet ? "" : "warn"}>{h.telnyx?.publicKeySet ? "Status updates can be verified" : "Webhook public key missing — status updates will be ignored, re-checks still run"}</span>
          {h.telnyx?.balance ? <span className={Number(h.telnyx.balance) < 50 ? "warn" : ""}>Balance ${Number(h.telnyx.balance).toFixed(2)}</span> : null}
          <span className={h.sweep.lastError ? "bad" : ""}>
            {h.sweep.lastRunAt ? `Background re-check ran ${ago(h.sweep.lastRunAt)}` : "Background re-check starts 2 min after a restart"}
          </span>
        </div>
      ) : null}

      <div className="trd-strip">
        <div className={`trd-tile${needs ? " attn" : ""}`}><div className="v">{needs}</div><div className="l">Need you</div></div>
        <div className="trd-tile"><div className="v">{waiting}</div><div className="l">Waiting on the customer</div></div>
        <div className="trd-tile"><div className="v">{review}</div><div className="l">In review</div></div>
        <div className="trd-tile"><div className="v">{live}</div><div className="l">Texting is live</div></div>
      </div>

      <div className="trd-chips" role="tablist" aria-label="Filter registrations">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`trd-chip${filter === f.id ? " on" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
            <i>{(board?.registrations || []).filter(f.match).length}</i>
          </button>
        ))}
      </div>

      {board && !rows.length ? (
        <div className="trd-empty">
          {board.registrations.length ? "Nothing here." : "No registrations yet. Press New registration to send a customer their link."}
        </div>
      ) : null}

      {rows.length ? (
        <div className="trd-wrap-x">
          <table className="trd-table">
            <thead>
              <tr><th>Customer</th><th>Where it is</th><th>Numbers</th><th>What&apos;s next</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.needsStaff ? "hot" : ""}>
                  <td>
                    <b>{r.displayName}</b>
                    <span className="sub">{[r.contactName, r.businessEmail].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td><span className={`trd-st ${pillClass(r.status)}`}>{r.statusLabel}</span></td>
                  <td className="num">{r.numbersCount}</td>
                  <td>{nextStep(r)}</td>
                  <td><Link className={`trd-btn sm${r.status === "submitted" ? " primary" : ""}`} href={`/admin/texting-registration/${r.id}`}>{r.status === "submitted" ? "Review & file" : "Open"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {adding ? (
        <div className="trd-modal-bg" role="presentation" onClick={() => setAdding(false)}>
          <div className="trd-modal" role="dialog" aria-modal="true" aria-labelledby="trd-add-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="trd-add-title">New registration</h2>
            <p className="trd-sub">Choose the customer. Their business name, phone, email and numbers are filled in from the account.</p>
            <label htmlFor="trd-q" className="trd-label">Customer</label>
            <input id="trd-q" className="trd-input" autoFocus value={q} placeholder="Search customers" onChange={(e) => setQ(e.target.value)} />
            <div className="trd-picklist">
              {customers.map((c) => (
                <button key={c.id} type="button" className="trd-pick" disabled={busy === c.id} onClick={() => void start(c)}>
                  <span>{c.name}</span>
                  <span className="sub">{c.registrationId ? "Already has a registration — open it" : busy === c.id ? "Starting…" : "Start"}</span>
                </button>
              ))}
              {!customers.length ? <div className="trd-empty small">No matching customers.</div> : null}
            </div>
            <div className="trd-actions"><button type="button" className="trd-btn" onClick={() => setAdding(false)}>Close</button></div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
