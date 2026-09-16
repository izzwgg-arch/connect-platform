"use client";

/**
 * Admin → 10DLC Registration → one customer (2026-09-16).
 *
 * Send the link, review what the customer sent, edit the generated wording,
 * press "File with Telnyx", then follow it through the registry and carriers.
 *
 * ⛔ Every action here maps to one api route that re-checks platform staff AND
 * its own key; buttons a person lacks the key for simply fail with a plain
 * message. ⛔ The EIN is only ever shown after "Show", which the api records.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, apiGet, apiPatch, apiPost } from "../../../../../services/apiClient";
import "../texting-registration-admin.css";

type Check = { id: string; level: "pass" | "warn" | "fail"; message: string };
type Content = Record<"description" | "messageFlow" | "sample1" | "sample2" | "helpMessage" | "optoutMessage" | "optinMessage" | "helpKeywords" | "optoutKeywords" | "optinKeywords", string>;
type Event = { id: string; kind: string; message: string; createdAt: string };
type LinkRow = { id: string; createdAt: string; expiresAt: string; revokedAt: string | null; openedAt: string | null; usedAt: string | null; emailedTo: string | null; emailedAt: string | null };

type Detail = {
  id: string;
  displayName: string;
  businessEmail: string;
  businessPhone: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  status: string;
  statusLabel: string;
  lastError: string | null;
  numbers: string[];
  telnyxNumbers: string[];
  answers: Record<string, string | null>;
  ein: { onFile: boolean; masked: string; storedAt: string | null };
  signatureName: string | null;
  consentAt: string | null;
  submittedAt: string | null;
  content: Content;
  fixFields: string[] | null;
  fixNote: string | null;
  privacyUrl: string;
  termsUrl: string;
  telnyx: {
    brandId: string | null;
    brandIdentityStatus: string | null;
    brandStatus: string | null;
    brandFeedback: { categories?: Array<{ id: string; displayName: string; description: string; fields: string[] }>; reasons?: string[] } | null;
    campaignId: string | null;
    campaignStatus: string | null;
    failureReasons: string[] | null;
    numberAssignments: Record<string, { state: string; note: string | null }> | null;
  };
  carrierReviews: Array<{ networkId: string; carrier: string; state: string }> | null;
  chargeReference: string | null;
  renewsAt: string | null;
  lastCheckedAt: string | null;
  links: LinkRow[];
  events: Event[];
};

const ENTITY_LABEL: Record<string, string> = {
  PRIVATE_PROFIT: "LLC or corporation",
  PUBLIC_PROFIT: "Publicly traded company",
  NON_PROFIT: "Non-profit",
  GOVERNMENT: "Government",
  SOLE_PROPRIETOR: "Sole proprietor",
};

const CUSTOMER_FIELDS: Array<[string, string]> = [
  ["legalName", "Legal name"],
  ["entityType", "Business type"],
  ["ein", "EIN"],
  ["street", "Street"],
  ["city", "City"],
  ["state", "State"],
  ["postalCode", "ZIP"],
  ["website", "Website / online page"],
  ["mobilePhone", "Owner's mobile (sole proprietor)"],
];

const WORDING: Array<[keyof Content, string, boolean]> = [
  ["description", "How the business uses texting", false],
  ["messageFlow", "How customers agree to texts (opt-in)", true],
  ["sample1", "Sample message 1", true],
  ["sample2", "Sample message 2", true],
  ["helpMessage", "Reply to HELP", true],
  ["optoutMessage", "Reply to STOP", false],
  ["optinMessage", "Reply to START", false],
];

function msg(err: unknown): string {
  if (err instanceof ApiError) {
    const b: any = err.body;
    if (err.status === 403) return "You don't have permission for this action.";
    return b?.message || err.message;
  }
  return (err as Error)?.message || "Something went wrong.";
}

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtPhone(raw: string): string {
  const d = String(raw || "").replace(/\D/g, "");
  const t = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return t.length === 10 ? `(${t.slice(0, 3)}) ${t.slice(3, 6)}-${t.slice(6)}` : raw;
}

function pillClass(status: string): string {
  if (status === "live") return "ok";
  if (["brand_failed", "campaign_rejected", "suspended", "error"].includes(status)) return "bad";
  if (["submitted", "needs_fix", "awaiting_pin"].includes(status)) return "wait";
  if (["deactivated", "draft"].includes(status)) return "off";
  return "pending";
}

export default function TextingRegistrationDetail({ params }: { params: { id: string } }) {
  const id = String(params?.id ?? "");
  const [d, setD] = useState<Detail | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [emailTo, setEmailTo] = useState("");
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [editBiz, setEditBiz] = useState(false);
  const [biz, setBiz] = useState<Record<string, string>>({});
  const [bizEin, setBizEin] = useState("");
  const [markReady, setMarkReady] = useState(true);
  const [revealed, setRevealed] = useState<string | null>(null);

  const [wording, setWording] = useState<Partial<Content>>({});
  const [confirmFile, setConfirmFile] = useState(false);
  const [sendBackFields, setSendBackFields] = useState<string[]>([]);
  const [sendBackNote, setSendBackNote] = useState("");
  const [appealText, setAppealText] = useState("");
  const [deactivateName, setDeactivateName] = useState("");
  const [showDeactivate, setShowDeactivate] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiGet<{ registration: Detail; checks: Check[] }>(`/admin/texting-registration/${encodeURIComponent(id)}`);
      setD(r.registration);
      setChecks(r.checks);
      setError(null);
      setEmailTo((cur) => cur || r.registration.businessEmail || "");
    } catch (err) {
      setError(msg(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 45_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (d && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("send") === "1") {
      document.getElementById("trd-send")?.scrollIntoView({ behavior: "smooth" });
    }
  }, [d === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setToast(null);
    try {
      await fn();
      if (ok) setToast({ kind: "ok", text: ok });
      await load();
    } catch (err) {
      setToast({ kind: "bad", text: msg(err) });
    } finally {
      setBusy(null);
    }
  };

  const failing = checks.filter((c) => c.level === "fail");
  const filedCampaign = !!d?.telnyx.campaignId;
  const canLink = !!d && ["draft", "awaiting_customer", "needs_fix", "submitted"].includes(d.status);
  const canEditBiz = !!d && ["draft", "awaiting_customer", "needs_fix", "submitted", "brand_failed"].includes(d.status);
  const wordingDirty = useMemo(() => Object.entries(wording).some(([k, v]) => d && v !== (d.content as any)[k]), [wording, d]);
  const latestLink = d?.links?.[0] || null;

  if (error && !d) {
    return (
      <div className="trd-root">
        <Link href="/admin/texting-registration" className="trd-back">← 10DLC Registration</Link>
        <div className="trd-note bad">{error}</div>
      </div>
    );
  }
  if (!d) return <div className="trd-root"><p className="trd-sub">Loading…</p></div>;

  const answer = (k: string) => {
    const v = d.answers[k];
    if (k === "entityType") return v ? ENTITY_LABEL[v] || v : "—";
    return v || "—";
  };

  return (
    <div className="trd-root">
      <Link href="/admin/texting-registration" className="trd-back">← 10DLC Registration</Link>
      <div className="trd-head">
        <div>
          <h1 className="trd-title">{d.displayName}</h1>
          <p className="trd-sub">
            <span className={`trd-st ${pillClass(d.status)}`}>{d.statusLabel}</span>
            {d.submittedAt ? <> · sent by {d.signatureName} {when(d.submittedAt)}</> : null}
            {d.lastCheckedAt ? <> · checked with Telnyx {when(d.lastCheckedAt)}</> : null}
          </p>
        </div>
        <button type="button" className="trd-btn" disabled={busy === "refresh"} onClick={() => void run("refresh", () => apiPost(`/admin/texting-registration/${id}/refresh`, {}), "Checked with Telnyx.")}>
          {busy === "refresh" ? "Checking…" : "Check now"}
        </button>
      </div>

      {d.lastError ? <div className="trd-note bad">{d.lastError}</div> : null}
      {toast ? <div className={`trd-note ${toast.kind}`} role="status">{toast.text}</div> : null}

      <div className="trd-two">
        <div className="trd-col">
          {/* ── Send the link ── */}
          {canLink ? (
            <section className="trd-card" id="trd-send">
              <h2>Customer link</h2>
              <p className="trd-sub">
                {latestLink
                  ? `Last link ${latestLink.usedAt ? `sent back ${when(latestLink.usedAt)}` : latestLink.openedAt ? `opened ${when(latestLink.openedAt)}` : latestLink.emailedAt ? `emailed to ${latestLink.emailedTo} ${when(latestLink.emailedAt)}` : `created ${when(latestLink.createdAt)}`}${latestLink.revokedAt ? " (turned off)" : ""}.`
                  : "No link yet."}{" "}
                A new link turns off the old one and works for 30 days.
              </p>
              {d.fixFields ? <div className="trd-note warn">Sent back to fix: {d.fixFields.join(", ")}. The customer sees your note and can change only those fields.</div> : null}
              <label className="trd-label" htmlFor="trd-email">Email the 10DLC form to</label>
              <input id="trd-email" className="trd-input" type="email" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} />
              <div className="trd-actions">
                <button
                  type="button"
                  className="trd-btn primary"
                  disabled={!!busy || !emailTo}
                  onClick={() =>
                    void run("email", async () => {
                      const r = await apiPost<{ url: string }>(`/admin/texting-registration/${id}/link`, { sendEmail: true, email: emailTo });
                      setLinkUrl(r.url);
                    }, `10DLC form emailed to ${emailTo}.`)
                  }
                >
                  {busy === "email" ? "Sending…" : "Send email"}
                </button>
                <button
                  type="button"
                  className="trd-btn"
                  disabled={!!busy}
                  onClick={() =>
                    void run("copy", async () => {
                      const r = await apiPost<{ url: string }>(`/admin/texting-registration/${id}/link`, { sendEmail: false });
                      setLinkUrl(r.url);
                      try {
                        await navigator.clipboard.writeText(r.url);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      } catch {
                        /* shown below for manual copy */
                      }
                    }, "New link created.")
                  }
                >
                  {copied ? "Copied" : "Create & copy link"}
                </button>
                {latestLink && !latestLink.revokedAt && !latestLink.usedAt ? (
                  <button type="button" className="trd-btn danger" disabled={!!busy} onClick={() => void run("revoke", () => apiPost(`/admin/texting-registration/${id}/link/revoke`, {}), "Link turned off.")}>
                    Turn off link
                  </button>
                ) : null}
              </div>
              {linkUrl ? (
                <div className="trd-linkbox">
                  <input className="trd-input mono" readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Customer link" />
                  <button type="button" className="trd-btn sm" onClick={() => { void navigator.clipboard?.writeText(linkUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Copied" : "Copy"}</button>
                </div>
              ) : null}
            </section>
          ) : null}

          {/* ── Business ── */}
          <section className="trd-card">
            <div className="trd-card-head">
              <h2>Business</h2>
              {canEditBiz && !editBiz ? (
                <button type="button" className="trd-btn sm" onClick={() => { setBiz(Object.fromEntries(Object.entries(d.answers).map(([k, v]) => [k, v || ""]))); setEditBiz(true); }}>
                  {d.status === "draft" || d.status === "awaiting_customer" ? "Fill it in myself" : "Correct"}
                </button>
              ) : null}
            </div>
            {!editBiz ? (
              <dl className="trd-grid">
                {CUSTOMER_FIELDS.filter(([k]) => k !== "mobilePhone" || d.answers.entityType === "SOLE_PROPRIETOR").map(([k, label]) => (
                  <div key={k}>
                    <dt>{label} <span className="trd-src cust">customer</span></dt>
                    <dd>
                      {k === "ein" ? (
                        d.answers.entityType === "SOLE_PROPRIETOR" ? "Not needed" : (
                          <>
                            <span className="mono">{revealed || d.ein.masked}</span>{" "}
                            {d.ein.onFile && !revealed ? (
                              <button type="button" className="trd-btn xs" onClick={() => void run("reveal", async () => { const r = await apiPost<{ ein: string }>(`/admin/texting-registration/${id}/reveal-ein`, {}); setRevealed(r.ein); setTimeout(() => setRevealed(null), 30_000); })}>Show</button>
                            ) : null}
                          </>
                        )
                      ) : answer(k)}
                    </dd>
                  </div>
                ))}
                <div><dt>Name customers see <span className="trd-src sys">account</span></dt><dd>{d.displayName}</dd></div>
                <div><dt>Phone · email <span className="trd-src sys">account</span></dt><dd>{fmtPhone(d.businessPhone)} · {d.businessEmail || "—"}</dd></div>
                <div><dt>Signed</dt><dd>{d.signatureName ? `${d.signatureName} · consent ${when(d.consentAt)}` : "Not yet"}</dd></div>
                <div><dt>Policy page</dt><dd><a href={d.privacyUrl} target="_blank" rel="noreferrer">Privacy</a> · <a href={d.termsUrl} target="_blank" rel="noreferrer">Terms</a></dd></div>
              </dl>
            ) : (
              <div>
                <div className="trd-form">
                  {[["displayName", "Name customers see"], ["businessPhone", "Business phone"], ["businessEmail", "Business email"], ["legalName", "Legal name (IRS)"], ["street", "Street (IRS)"], ["city", "City"], ["state", "State (2 letters)"], ["postalCode", "ZIP"], ["website", "Website / online page"], ["mobilePhone", "Owner's mobile (sole proprietor only)"]].map(([k, label]) => (
                    <div key={k}>
                      <label className="trd-label" htmlFor={`biz-${k}`}>{label}</label>
                      <input id={`biz-${k}`} className="trd-input" value={k === "displayName" ? biz[k] ?? d.displayName : k === "businessPhone" ? biz[k] ?? d.businessPhone : k === "businessEmail" ? biz[k] ?? d.businessEmail : biz[k] ?? ""} onChange={(e) => setBiz((b) => ({ ...b, [k]: e.target.value }))} />
                    </div>
                  ))}
                  <div>
                    <label className="trd-label" htmlFor="biz-entityType">Business type</label>
                    <div className="trd-seg" id="biz-entityType" role="radiogroup">
                      {Object.entries(ENTITY_LABEL).map(([v, label]) => (
                        <button key={v} type="button" role="radio" aria-checked={biz.entityType === v} className={biz.entityType === v ? "on" : ""} onClick={() => setBiz((b) => ({ ...b, entityType: v }))}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="trd-label" htmlFor="biz-ein">EIN {d.ein.onFile ? "(leave blank to keep the one on file)" : ""}</label>
                    <input id="biz-ein" className="trd-input" inputMode="numeric" autoComplete="off" value={bizEin} onChange={(e) => setBizEin(e.target.value)} />
                  </div>
                </div>
                <label className="trd-check"><input type="checkbox" checked={markReady} onChange={(e) => setMarkReady(e.target.checked)} /> Mark ready to file (I confirmed these details with the customer)</label>
                <div className="trd-actions">
                  <button
                    type="button"
                    className="trd-btn primary"
                    disabled={!!busy}
                    onClick={() =>
                      void run("biz", async () => {
                        await apiPatch(`/admin/texting-registration/${id}/business`, { ...biz, ...(bizEin ? { ein: bizEin } : {}), markSubmitted: markReady });
                        setEditBiz(false);
                        setBizEin("");
                      }, "Business details saved.")
                    }
                  >
                    Save
                  </button>
                  <button type="button" className="trd-btn" onClick={() => { setEditBiz(false); setBizEin(""); }}>Cancel</button>
                </div>
              </div>
            )}
          </section>

          {/* ── Wording ── */}
          <section className="trd-card">
            <div className="trd-card-head">
              <h2>Carrier wording <span className="trd-src sys">written by the system</span></h2>
            </div>
            <p className="trd-sub">
              {filedCampaign
                ? "The campaign is filed: only the samples, the HELP reply and the opt-in description can still be changed, and saving sends them to Telnyx."
                : "The customer saw this but couldn't edit it. You can edit it before filing."}
            </p>
            {WORDING.map(([k, label, editableAfter]) => {
              const locked = filedCampaign && !editableAfter;
              const value = wording[k] ?? d.content[k];
              return (
                <div key={k} className="trd-wording">
                  <label className="trd-label" htmlFor={`w-${k}`}>{label} <span className="trd-count">{value.length}</span></label>
                  <textarea id={`w-${k}`} className="trd-input" rows={k === "messageFlow" ? 5 : 2} value={value} disabled={locked || ["live", "deactivated"].includes(d.status) && !editableAfter} onChange={(e) => setWording((w) => ({ ...w, [k]: e.target.value }))} />
                </div>
              );
            })}
            <p className="trd-sub small">Keywords — STOP: {d.content.optoutKeywords} · HELP: {d.content.helpKeywords} · START: {d.content.optinKeywords}</p>
            {wordingDirty ? (
              <div className="trd-actions">
                <button type="button" className="trd-btn primary" disabled={!!busy} onClick={() => void run("wording", async () => { await apiPatch(`/admin/texting-registration/${id}/content`, wording as Record<string, unknown>); setWording({}); }, filedCampaign ? "Wording sent to Telnyx." : "Wording saved.")}>
                  {filedCampaign ? "Save and send to Telnyx" : "Save wording"}
                </button>
                <button type="button" className="trd-btn" onClick={() => setWording({})}>Discard</button>
              </div>
            ) : null}
          </section>
        </div>

        <div className="trd-col">
          {/* ── File ── */}
          {d.status === "submitted" ? (
            <section className="trd-card">
              <h2>Checks before filing</h2>
              <ul className="trd-checks">
                {checks.filter((c) => c.level !== "pass").concat(checks.filter((c) => c.level === "pass").slice(0, 6)).map((c) => (
                  <li key={c.id} className={c.level}>{c.message}</li>
                ))}
              </ul>
              <p className="trd-sub small">{checks.filter((c) => c.level === "pass").length} of {checks.length} checks pass.</p>
              <h2 className="mt">Charged when filed</h2>
              <table className="trd-bill">
                <tbody>
                  <tr><td>Business check (brand)</td><td>$4.50</td></tr>
                  <tr><td>Carrier review</td><td>$15.00</td></tr>
                  <tr><td>Campaign registration</td><td>$4.50</td></tr>
                  <tr className="tot"><td>Charged now</td><td>$24.00</td></tr>
                </tbody>
              </table>
              <div className="trd-note ok">A one-time $24.00 &quot;Business texting (10DLC) registration&quot; invoice is created for {d.displayName}. It is not charged or emailed automatically.</div>
              <button type="button" className="trd-btn primary big" disabled={!!busy || failing.length > 0} onClick={() => setConfirmFile(true)}>
                {failing.length ? `Fix ${failing.length} check${failing.length === 1 ? "" : "s"} before filing` : "File with Telnyx · $24.00"}
              </button>
            </section>
          ) : null}

          {/* ── Send back ── */}
          {["submitted", "brand_failed", "needs_fix"].includes(d.status) ? (
            <section className="trd-card">
              <h2>Send back to the customer</h2>
              {d.telnyx.brandFeedback?.categories?.length ? (
                <div className="trd-note bad">
                  <b>Registry feedback:</b>{" "}
                  {d.telnyx.brandFeedback.categories.map((c) => `${c.displayName}${c.description ? ` — ${c.description}` : ""}`).join("; ")}
                </div>
              ) : null}
              <p className="trd-sub">Unlocks only the fields you tick. The customer sees your note, and a new link is emailed to {emailTo || "them"}.</p>
              <div className="trd-ticks">
                {CUSTOMER_FIELDS.map(([k, label]) => (
                  <label key={k} className="trd-check"><input type="checkbox" checked={sendBackFields.includes(k)} onChange={(e) => setSendBackFields((f) => (e.target.checked ? [...f, k] : f.filter((x) => x !== k)))} /> {label}</label>
                ))}
              </div>
              <label className="trd-label" htmlFor="trd-note">Note to the customer</label>
              <textarea id="trd-note" className="trd-input" rows={3} value={sendBackNote} placeholder="The IRS has your business under a slightly different name. Please enter the legal name exactly as it appears on your IRS letter (CP-575)." onChange={(e) => setSendBackNote(e.target.value)} />
              <div className="trd-actions">
                <button
                  type="button"
                  className="trd-btn"
                  disabled={!!busy || !sendBackFields.length || sendBackNote.trim().length < 5 || !emailTo}
                  onClick={() =>
                    void run("sendback", async () => {
                      await apiPost(`/admin/texting-registration/${id}/send-back`, { fields: sendBackFields, note: sendBackNote });
                      const r = await apiPost<{ url: string }>(`/admin/texting-registration/${id}/link`, { sendEmail: true, email: emailTo });
                      setLinkUrl(r.url);
                      setSendBackFields([]);
                      setSendBackNote("");
                    }, `Sent back and emailed to ${emailTo}.`)
                  }
                >
                  Send back and email the customer
                </button>
              </div>
            </section>
          ) : null}

          {/* ── Progress ── */}
          {d.telnyx.brandId ? (
            <section className="trd-card">
              <h2>With Telnyx</h2>
              <dl className="trd-grid one">
                <div><dt>Business (brand)</dt><dd>{d.telnyx.brandIdentityStatus || "—"} · {d.telnyx.brandStatus || "—"} <span className="mono dim">{d.telnyx.brandId}</span></dd></div>
                <div><dt>Campaign</dt><dd>{d.telnyx.campaignStatus || (d.telnyx.campaignId ? "—" : "Not filed yet")} {d.telnyx.campaignId ? <span className="mono dim">{d.telnyx.campaignId}</span> : null}</dd></div>
                {d.renewsAt ? <div><dt>Renews</dt><dd>{new Date(d.renewsAt).toLocaleDateString()}</dd></div> : null}
                {d.chargeReference ? <div><dt>Customer invoice</dt><dd>{d.chargeReference}</dd></div> : null}
              </dl>
              {d.carrierReviews?.length ? (
                <div className="trd-carriers">
                  {d.carrierReviews.map((c) => (
                    <div key={c.networkId} className="trd-carrier"><strong>{c.carrier}</strong><span className={`trd-st ${c.state === "approved" ? "ok" : c.state === "rejected" ? "bad" : "pending"}`}>{c.state === "approved" ? "Approved" : c.state === "rejected" ? "Rejected" : "Reviewing"}</span></div>
                  ))}
                </div>
              ) : null}
              {d.telnyx.failureReasons?.length ? <div className="trd-note bad">{d.telnyx.failureReasons.join("; ")}</div> : null}
              <h3>Numbers</h3>
              {d.telnyxNumbers.length ? (
                <table className="trd-table compact">
                  <tbody>
                    {d.telnyxNumbers.map((n) => {
                      const a = d.telnyx.numberAssignments?.[n];
                      return (
                        <tr key={n}>
                          <td className="num">{fmtPhone(n)}</td>
                          <td><span className={`trd-st ${a?.state === "assigned" ? "ok" : a?.state === "failed" ? "bad" : "off"}`}>{a?.state === "assigned" ? "Attached" : a?.state === "failed" ? "Failed" : a ? "Attaching" : "Waiting for approval"}</span>{a?.note ? <span className="sub">{a.note}</span> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="trd-sub small">No Telnyx-hosted texting numbers for this customer yet{d.numbers.length ? ` (${d.numbers.map(fmtPhone).join(", ")} are on another carrier)` : ""}. They attach automatically once moved to Telnyx.</p>
              )}
            </section>
          ) : null}

          {/* ── Appeal ── */}
          {d.status === "campaign_rejected" ? (
            <section className="trd-card">
              <h2>Appeal</h2>
              <p className="trd-sub">Fix the sample messages on the left first (they are sent to Telnyx when saved), then explain what changed.</p>
              <textarea className="trd-input" rows={3} value={appealText} aria-label="Appeal note" placeholder="Both samples now open with the business name. No other content changed." onChange={(e) => setAppealText(e.target.value)} />
              <div className="trd-actions">
                <button type="button" className="trd-btn primary" disabled={!!busy || appealText.trim().length < 10} onClick={() => void run("appeal", () => apiPost(`/admin/texting-registration/${id}/appeal`, { reason: appealText }), "Appeal sent.")}>Send appeal</button>
              </div>
            </section>
          ) : null}

          {/* ── History ── */}
          <section className="trd-card">
            <h2>History</h2>
            <table className="trd-log">
              <tbody>
                {d.events.map((e) => (
                  <tr key={e.id}><td>{when(e.createdAt)}</td><td>{e.message}</td></tr>
                ))}
              </tbody>
            </table>
          </section>

          {d.status !== "deactivated" ? (
            <section className="trd-card">
              {!showDeactivate ? (
                <button type="button" className="trd-btn danger" onClick={() => setShowDeactivate(true)}>{d.telnyx.campaignId ? "Deactivate campaign…" : "Close registration…"}</button>
              ) : (
                <>
                  <div className="trd-note bad"><b>{d.telnyx.campaignId ? "Deactivating is permanent." : "Closing turns off the customer's link and deletes the EIN."}</b> {d.telnyx.campaignId ? "Telnyx cannot restore a deactivated campaign, and texting stops on its numbers." : ""}</div>
                  <label className="trd-label" htmlFor="trd-deact">Type &quot;{d.displayName}&quot; to confirm</label>
                  <input id="trd-deact" className="trd-input" value={deactivateName} onChange={(e) => setDeactivateName(e.target.value)} />
                  <div className="trd-actions">
                    <button type="button" className="trd-btn danger" disabled={!!busy || deactivateName.trim().toLowerCase() !== d.displayName.trim().toLowerCase()} onClick={() => void run("deactivate", () => apiPost(`/admin/texting-registration/${id}/deactivate`, { confirmName: deactivateName }), "Deactivated.")}>
                      {d.telnyx.campaignId ? "Deactivate permanently" : "Close registration"}
                    </button>
                    <button type="button" className="trd-btn" onClick={() => { setShowDeactivate(false); setDeactivateName(""); }}>Cancel</button>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </div>
      </div>

      {confirmFile ? (
        <div className="trd-modal-bg" role="presentation" onClick={() => setConfirmFile(false)}>
          <div className="trd-modal" role="dialog" aria-modal="true" aria-labelledby="trd-file-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="trd-file-title">File {d.displayName} with Telnyx?</h2>
            <p className="trd-sub">Telnyx charges the Loopcom account as each step is accepted. None of it is refundable. After this, the registration continues by itself: business check, carrier review, numbers, texting on.</p>
            <table className="trd-bill">
              <tbody>
                <tr><td>Business check (brand)</td><td>$4.50</td></tr>
                <tr><td>Carrier review</td><td>$15.00</td></tr>
                <tr><td>Campaign registration</td><td>$4.50</td></tr>
                <tr className="tot"><td>Charged now</td><td>$24.00</td></tr>
              </tbody>
            </table>
            <div className="trd-actions">
              <button type="button" className="trd-btn" onClick={() => setConfirmFile(false)}>Cancel</button>
              <button
                type="button"
                className="trd-btn primary"
                disabled={!!busy}
                onClick={() =>
                  void run("file", async () => {
                    const r = await apiPost<{ statusLabel: string; lastError: string | null }>(`/admin/texting-registration/${id}/file`, {});
                    setConfirmFile(false);
                    if (r.lastError) throw new Error(r.lastError);
                  }, "Filed with Telnyx.")
                }
              >
                {busy === "file" ? "Filing…" : "File and pay $24.00"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
