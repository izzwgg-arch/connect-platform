"use client";

/**
 * The Support Desk — Phase 1 of the support console (2026-08-20).
 *
 * The first screen ever to show `AgentEscalation`: the queue on the left, the
 * agent's full research report (ISSUE / FINDINGS / PROPOSED FIX / APPROVAL /
 * NOT CHECKED) in the middle, and "Approve the fix" wired into the EXISTING
 * password gate — the button posts to /admin/agent-confirmations/:id/apply,
 * the same route the assistant's on-screen confirmations use. ⛔ Never add a
 * second apply path here.
 *
 * ⛔ SUPER_ADMIN only for now (Izzy, 2026-08-20). The nav item is forced to
 * SUPER_ADMIN in navConfig.isNavItemVisibleForUser and every API handler
 * checks again server-side; the PermissionGate below is presentation, not the
 * fence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { parseEscalationReport, fixStatusLabel } from "../../../../lib/escalationReport";
import "./supportDesk.css";

type EscalationRow = {
  id: string;
  reference: string;
  createdAt: string;
  tenantId: string;
  tenantName: string;
  userName: string;
  userEmail: string | null;
  requestSummary: string;
  status: string;
  attempts: number;
  lastError: string | null;
  smsSentAt: string | null;
  researchDegraded: boolean;
  fixStatus: string | null;
  hasFixAction: boolean;
  hasConversation: boolean;
};

type EscalationDetail = EscalationRow & {
  conversationId: string | null;
  smsBody: string;
  report: string;
  proposedFix: string;
  fixActionId: string | null;
  fixCodeExpiresAt: string | null;
  fixCodeUsedAt: string | null;
  fixApprovedFrom: string | null;
  fixResult: string | null;
  fixAttempts: number;
};

type FixAction = {
  id: string;
  status: string;
  summary: string | null;
  capabilityId: string | null;
  createdAt: string;
  approvalConsumedAt: string | null;
} | null;

type ChatMessage = { role: string; content: string; contentEn: string | null; createdAt: string; model: string | null };

type Tab = "all" | "fixready" | "trouble";

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusChip(row: EscalationRow): { text: string; cls: string } {
  if (row.status === "FAILED") return { text: "Send failed", cls: "sd-chip-bad" };
  if (row.status === "CANCELLED") return { text: "Cancelled", cls: "sd-chip-dim" };
  if (row.status === "QUEUED") return { text: "Sending…", cls: "sd-chip-new" };
  return { text: "Reached the team", cls: "sd-chip-dim" };
}

function errorText(e: unknown): string {
  const body = (e as { body?: { message?: string; error?: string } })?.body;
  return body?.message || (e as Error)?.message || "Something went wrong.";
}

function SupportDesk() {
  const [rows, setRows] = useState<EscalationRow[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [listError, setListError] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ escalation: EscalationDetail; fixAction: FixAction; messages: ChatMessage[] } | null>(null);
  const [detailState, setDetailState] = useState<"idle" | "loading" | "error">("idle");
  const [approveOpen, setApproveOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [applyDone, setApplyDone] = useState("");
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const loadList = useCallback(async () => {
    try {
      const out = await apiGet<{ escalations: EscalationRow[] }>("/admin/support/escalations?take=100");
      setRows(out.escalations);
      setListState("ready");
      setListError("");
    } catch (e) {
      setListState("error");
      setListError(errorText(e));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailState("loading");
    try {
      const out = await apiGet<{ escalation: EscalationDetail; fixAction: FixAction; messages: ChatMessage[] }>(
        `/admin/support/escalations/${encodeURIComponent(id)}`,
      );
      if (selectedIdRef.current !== id) return;
      setDetail(out);
      setDetailState("idle");
    } catch {
      if (selectedIdRef.current !== id) return;
      setDetail(null);
      setDetailState("error");
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = window.setInterval(() => void loadList(), 30_000);
    return () => window.clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    setApplyDone("");
    setApplyError("");
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const visible = rows.filter((r) => {
    if (tab === "fixready") return r.fixStatus === "offered" || (r.hasFixAction && !r.fixStatus);
    if (tab === "trouble") return r.status === "FAILED" || r.researchDegraded;
    return true;
  });

  const fixReadyCount = rows.filter((r) => r.fixStatus === "offered" || (r.hasFixAction && !r.fixStatus)).length;

  async function approve() {
    const actionId = detail?.fixAction?.id;
    if (!actionId || !password || applying) return;
    setApplying(true);
    setApplyError("");
    try {
      const out = await apiPost<{ ok: boolean; message?: string }>(
        `/admin/agent-confirmations/${encodeURIComponent(actionId)}/apply`,
        { password },
      );
      setApplyDone(out.message || "Done — the fix was carried out.");
      setApproveOpen(false);
      setPassword("");
      if (selectedIdRef.current) void loadDetail(selectedIdRef.current);
      void loadList();
    } catch (e) {
      setApplyError(errorText(e));
    } finally {
      setApplying(false);
    }
  }

  const esc = detail?.escalation ?? null;
  const report = esc ? parseEscalationReport(esc.report) : null;
  const fixDraftReady = !!detail?.fixAction && detail.fixAction.status === "DRAFT" && !detail.fixAction.approvalConsumedAt;

  return (
    <div className="sd-page">
      <header className="sd-head">
        <div>
          <h1>Support Desk</h1>
          <p>Everything the assistant passed to the team — with its full report, and the fix one approval away.</p>
        </div>
        <div className="sd-tabs" role="tablist">
          <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>All</button>
          <button className={tab === "fixready" ? "on" : ""} onClick={() => setTab("fixready")}>
            Fix ready{fixReadyCount ? <span className="sd-count">{fixReadyCount}</span> : null}
          </button>
          <button className={tab === "trouble" ? "on" : ""} onClick={() => setTab("trouble")}>Needs a look</button>
        </div>
      </header>

      <div className="sd-body">
        <aside className="sd-queue">
          {listState === "loading" ? <div className="sd-state">Loading escalations…</div> : null}
          {listState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load the queue. {listError}</div> : null}
          {listState === "ready" && visible.length === 0 ? (
            <div className="sd-state">Nothing here — when the assistant passes something to the team, it lands on this desk.</div>
          ) : null}
          {visible.map((r) => {
            const chip = statusChip(r);
            const fix = fixStatusLabel(r.fixStatus, r.hasFixAction);
            return (
              <button key={r.id} className={"sd-item" + (r.id === selectedId ? " on" : "")} onClick={() => setSelectedId(r.id)}>
                <span className="sd-item-top">
                  <b>{r.tenantName}</b>
                  <time>{timeAgo(r.createdAt)}</time>
                </span>
                <span className="sd-item-sum">{r.requestSummary}</span>
                <span className="sd-item-chips">
                  {fix ? <span className={"sd-chip " + (r.fixStatus === "applied" ? "sd-chip-ok" : r.fixStatus === "failed" ? "sd-chip-bad" : "sd-chip-ok")}>{fix}</span> : null}
                  <span className={"sd-chip " + chip.cls}>{chip.text}</span>
                  {r.researchDegraded ? <span className="sd-chip sd-chip-warn">No research</span> : null}
                  <span className="sd-chip sd-chip-dim">Ref {r.reference}</span>
                </span>
              </button>
            );
          })}
        </aside>

        <main className="sd-detail">
          {!selectedId ? <div className="sd-state">Pick an escalation to read the agent&apos;s report.</div> : null}
          {selectedId && detailState === "loading" && !esc ? <div className="sd-state">Loading the report…</div> : null}
          {selectedId && detailState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load that escalation.</div> : null}
          {esc ? (
            <>
              <div className="sd-detail-head">
                <h2>{esc.requestSummary}</h2>
                <div className="sd-meta">
                  {esc.tenantName} · {esc.userName}
                  {esc.userEmail ? ` (${esc.userEmail})` : ""} · Ref {esc.reference} · {new Date(esc.createdAt).toLocaleString()}
                </div>
              </div>

              {applyDone ? <div className="sd-banner sd-banner-ok">{applyDone}</div> : null}
              {esc.fixStatus === "applied" && esc.fixResult ? <div className="sd-banner sd-banner-ok">{esc.fixResult}</div> : null}
              {esc.fixStatus === "failed" && esc.fixResult ? <div className="sd-banner sd-banner-bad">{esc.fixResult}</div> : null}

              {report?.hasSections ? (
                <div className="sd-report">
                  {report.preamble ? <p className="sd-preamble">{report.preamble}</p> : null}
                  {report.issue ? <section className="sd-sec"><h5>Issue</h5><p>{report.issue}</p></section> : null}
                  {report.findings ? <section className="sd-sec"><h5>Findings</h5><p>{report.findings}</p></section> : null}
                  {report.proposedFix ? <section className="sd-sec sd-sec-fix"><h5>Proposed fix</h5><p>{report.proposedFix}</p></section> : null}
                  {report.notChecked ? <section className="sd-sec sd-sec-warn"><h5>Not checked</h5><p>{report.notChecked}</p></section> : null}
                  {report.approval ? <section className="sd-sec"><h5>Approval</h5><p>{report.approval}</p></section> : null}
                </div>
              ) : (
                <div className="sd-report">
                  <section className="sd-sec sd-sec-warn">
                    <h5>{esc.researchDegraded ? "No research ran — the customer's own words" : "Report"}</h5>
                    <p>{esc.report || esc.requestSummary}</p>
                  </section>
                </div>
              )}

              {detail?.fixAction ? (
                <div className="sd-fixcard">
                  <div className="sd-fixcard-text">
                    <h5>The agent&apos;s prepared fix</h5>
                    <p>{detail.fixAction.summary || esc.proposedFix || "A one-click fix was drafted for this escalation."}</p>
                    {esc.fixApprovedFrom ? <p className="sd-dim">Approved by text from {esc.fixApprovedFrom}.</p> : null}
                  </div>
                  {fixDraftReady ? (
                    <button className="sd-btn sd-btn-primary" onClick={() => { setApproveOpen(true); setApplyError(""); }}>
                      Approve the fix…
                    </button>
                  ) : (
                    <span className="sd-chip sd-chip-dim">{detail.fixAction.status === "DRAFT" ? "Approval already used" : detail.fixAction.status}</span>
                  )}
                </div>
              ) : null}

              {detail?.messages?.length ? (
                <details className="sd-convo">
                  <summary>The conversation behind it ({detail.messages.length} messages)</summary>
                  <div className="sd-msgs">
                    {detail.messages.map((m, i) => (
                      <div key={i} className={"sd-msg " + (m.role === "user" ? "sd-msg-user" : "sd-msg-agent")}>
                        <span className="sd-msg-who">{m.role === "user" ? esc.userName : `Assistant${m.model ? ` · ${m.model}` : ""}`}</span>
                        {m.contentEn && m.contentEn !== m.content ? `${m.content}\n(${m.contentEn})` : m.content}
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </>
          ) : null}
        </main>
      </div>

      {approveOpen && detail?.fixAction ? (
        <div className="sd-modal-back" onClick={() => (applying ? null : setApproveOpen(false))}>
          <div className="sd-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Approve the fix</h3>
            <p>{detail.fixAction.summary || esc?.proposedFix}</p>
            <p className="sd-dim">Enter your account password to carry it out. This is the same gate every assistant change goes through.</p>
            <input
              type="password"
              autoFocus
              value={password}
              placeholder="Your password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => (e.key === "Enter" ? void approve() : null)}
            />
            {applyError ? <div className="sd-banner sd-banner-bad">{applyError}</div> : null}
            <div className="sd-modal-actions">
              <button className="sd-btn" disabled={applying} onClick={() => setApproveOpen(false)}>Cancel</button>
              <button className="sd-btn sd-btn-primary" disabled={!password || applying} onClick={() => void approve()}>
                {applying ? "Carrying it out…" : "Approve and run"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function SupportDeskPage() {
  return (
    <PermissionGate
      permission={"can_manage_global_settings" as never}
      fallback={<div className="sd-state">This page is for the platform owner.</div>}
    >
      <SupportDesk />
    </PermissionGate>
  );
}
