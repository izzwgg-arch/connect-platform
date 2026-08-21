"use client";

/**
 * Escalations, as chats — built from the approved mockup.
 * https://claude.ai/code/artifact/cf13e7b7-ebbf-414e-a1a6-f22dee7a2eaa (§3)
 *
 * Izzy, repeatedly: *"escalations should be escalations chats."* So an
 * escalation IS the conversation — the list on the left is people, the middle
 * is the thread they were having with the assistant, and the agent's report
 * sits INSIDE the thread as a card rather than on a separate screen. The
 * customer panel stays on the right.
 *
 * ⛔ Replying and taking over reuse the Phase-4 routes exactly; nothing here
 * writes a message by itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { parseEscalationReport, fixStatusLabel } from "../../../../lib/escalationReport";

type Row = {
  id: string;
  reference: string;
  createdAt: string;
  tenantId: string;
  tenantName: string;
  userName: string;
  userEmail: string | null;
  requestSummary: string;
  status: string;
  researchDegraded: boolean;
  fixStatus: string | null;
  hasFixAction: boolean;
  hasConversation: boolean;
  conversationId?: string | null;
};

type Detail = Row & {
  conversationId: string | null;
  report: string;
  proposedFix: string;
  fixActionId: string | null;
  fixResult: string | null;
};
type FixAction = { id: string; status: string; summary: string | null; approvalConsumedAt: string | null } | null;
type Msg = { role: string; content: string; contentEn: string | null; createdAt: string; model: string | null };
type Customer = {
  tenant: { name: string };
  counts: { extensions: number | null; users: number | null; numbers: number | null };
  billing: { autopay: boolean; invoicesNeedingAttention: number | null } | null;
  pastEscalations: Array<{ id: string; requestSummary: string; createdAt: string }>;
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
function errorText(e: unknown): string {
  const b = (e as { body?: { message?: string } })?.body;
  return b?.message || (e as Error)?.message || "Something went wrong.";
}

export default function SupportEscalationChats() {
  const [rows, setRows] = useState<Row[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ escalation: Detail; fixAction: FixAction; messages: Msg[] } | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [password, setPassword] = useState("");
  const selRef = useRef<string | null>(null);
  selRef.current = selectedId;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loadList = useCallback(async () => {
    try {
      const out = await apiGet<{ escalations: Row[] }>("/admin/support/escalations?take=100");
      setRows(out.escalations);
      setListState("ready");
      if (!selRef.current && out.escalations[0]) setSelectedId(out.escalations[0].id);
    } catch {
      setListState("error");
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const out = await apiGet<{ escalation: Detail; fixAction: FixAction; messages: Msg[] }>(
        `/admin/support/escalations/${encodeURIComponent(id)}`,
      );
      if (selRef.current !== id) return;
      setDetail(out);
      window.setTimeout(() => scrollRef.current?.scrollTo({ top: 9_999_999 }), 30);
      if (out.escalation.tenantId) {
        apiGet<Customer>(`/admin/support/customers/${encodeURIComponent(out.escalation.tenantId)}`)
          .then((c) => selRef.current === id && setCustomer(c))
          .catch(() => setCustomer(null));
      }
      if (out.escalation.conversationId) {
        apiGet<{ conversation: { takenOver: boolean } }>(
          `/admin/support/conversations/${encodeURIComponent(out.escalation.conversationId)}`,
        )
          .then((c) => selRef.current === id && setTakenOver(!!c.conversation.takenOver))
          .catch(() => setTakenOver(false));
      } else {
        setTakenOver(false);
      }
    } catch {
      if (selRef.current === id) setDetail(null);
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = window.setInterval(() => void loadList(), 30_000);
    return () => window.clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) return;
    setNotice("");
    setErr("");
    void loadDetail(selectedId);
    const t = window.setInterval(() => void loadDetail(selectedId), 8_000);
    return () => window.clearInterval(t);
  }, [selectedId, loadDetail]);

  const esc = detail?.escalation ?? null;
  const report = esc ? parseEscalationReport(esc.report) : null;
  const convId = esc?.conversationId ?? null;
  const fixReady = !!detail?.fixAction && detail.fixAction.status === "DRAFT" && !detail.fixAction.approvalConsumedAt;

  async function toggleTakeover(on: boolean) {
    if (!convId || busy) return;
    setBusy(true); setErr("");
    try {
      await apiPost(`/admin/support/conversations/${encodeURIComponent(convId)}/takeover`, { on });
      setTakenOver(on);
      void loadDetail(selectedId!);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function send() {
    if (!convId || !draft.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      await apiPost(`/admin/support/conversations/${encodeURIComponent(convId)}/message`, { body: draft.trim() });
      setDraft("");
      void loadDetail(selectedId!);
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  async function approve() {
    const actionId = detail?.fixAction?.id;
    if (!actionId || !password || busy) return;
    setBusy(true); setErr("");
    try {
      const out = await apiPost<{ message?: string }>(`/admin/agent-confirmations/${encodeURIComponent(actionId)}/apply`, { password });
      setNotice(out.message || "Done — the fix was carried out.");
      setApproveOpen(false); setPassword("");
      void loadDetail(selectedId!); void loadList();
    } catch (e) { setErr(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="sd-body sd-body-3">
      {/* people, not tickets */}
      <aside className="sd-queue">
        {listState === "loading" ? <div className="sd-state">Loading…</div> : null}
        {listState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load escalations.</div> : null}
        {listState === "ready" && rows.length === 0 ? (
          <div className="sd-state">Nothing escalated — when the assistant passes something to the team it appears here as a chat.</div>
        ) : null}
        {rows.map((r) => {
          const fix = fixStatusLabel(r.fixStatus, r.hasFixAction);
          return (
            <button key={r.id} className={"sd-item" + (r.id === selectedId ? " on" : "")} onClick={() => setSelectedId(r.id)}>
              <span className="sd-item-top">
                <b>{r.userName} · {r.tenantName}</b>
                <time>{timeAgo(r.createdAt)}</time>
              </span>
              <span className="sd-item-sum">&ldquo;{r.requestSummary}&rdquo;</span>
              <span className="sd-item-chips">
                <span className="sd-chip sd-chip-bad">Escalated</span>
                {fix ? <span className="sd-chip sd-chip-ok">{fix}</span> : null}
                {r.researchDegraded ? <span className="sd-chip sd-chip-warn">No research</span> : null}
              </span>
            </button>
          );
        })}
      </aside>

      {/* the conversation */}
      <main className="sd-detail sd-inbox-main">
        {!esc ? <div className="sd-state">Pick a conversation.</div> : null}
        {esc ? (
          <>
            <div className="sd-detail-head" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h2>{esc.userName} · {esc.tenantName}</h2>
                <div className="sd-meta">
                  Ref {esc.reference}{esc.userEmail ? ` · ${esc.userEmail}` : ""} · {new Date(esc.createdAt).toLocaleString()}
                  {takenOver ? " · you have this conversation" : ""}
                </div>
              </div>
              {convId ? (
                takenOver ? (
                  <button className="sd-btn" disabled={busy} onClick={() => void toggleTakeover(false)}>Hand back to assistant</button>
                ) : (
                  <button className="sd-btn sd-btn-primary" disabled={busy} onClick={() => void toggleTakeover(true)}>Take over</button>
                )
              ) : null}
            </div>

            {notice ? <div className="sd-banner sd-banner-ok">{notice}</div> : null}
            {err ? <div className="sd-banner sd-banner-bad">{err}</div> : null}

            <div className="sd-transcript" ref={scrollRef}>
              {(detail?.messages ?? []).map((m, i) => (
                <div key={i} className={"sd-msg " + (m.role === "user" ? "sd-msg-user" : "sd-msg-agent")}
                  style={m.role === "staff" ? { borderColor: "var(--success)", alignSelf: "flex-end" } : undefined}>
                  <span className="sd-msg-who">
                    {m.role === "user" ? esc.userName : m.role === "staff" ? "Loopcom support" : `Assistant${m.model && m.model !== "human" ? ` · ${m.model}` : ""}`}
                    {" · "}{timeAgo(m.createdAt)}
                  </span>
                  {m.content}
                </div>
              ))}

              {/* the report, INSIDE the thread */}
              <div className="sd-fixcard" style={{ alignSelf: "stretch", flexDirection: "column", alignItems: "stretch", gap: 10 }}>
                <div className="sd-fixcard-text">
                  <h5>Escalated to the team · the agent&apos;s report</h5>
                  {report?.hasSections ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {report.issue ? <p><b style={{ color: "var(--accent)", fontSize: 10, letterSpacing: ".1em" }}>ISSUE</b> — {report.issue}</p> : null}
                      {report.findings ? <p><b style={{ color: "var(--accent)", fontSize: 10, letterSpacing: ".1em" }}>FINDINGS</b> — {report.findings}</p> : null}
                      {report.proposedFix ? <p><b style={{ color: "var(--success)", fontSize: 10, letterSpacing: ".1em" }}>PROPOSED FIX</b> — {report.proposedFix}</p> : null}
                      {report.notChecked ? <p><b style={{ color: "var(--warning)", fontSize: 10, letterSpacing: ".1em" }}>NOT CHECKED</b> — {report.notChecked}</p> : null}
                    </div>
                  ) : (
                    <p>{esc.report || esc.requestSummary}</p>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {fixReady ? (
                    <button className="sd-btn sd-btn-primary" onClick={() => { setApproveOpen(true); setErr(""); }}>Approve the fix…</button>
                  ) : detail?.fixAction ? (
                    <span className="sd-chip sd-chip-dim">Approval already used</span>
                  ) : null}
                </div>
                {esc.fixResult ? <div className="sd-dim">{esc.fixResult}</div> : null}
              </div>
            </div>

            {convId ? (
              takenOver ? (
                <div className="sd-composer">
                  <input
                    value={draft}
                    placeholder={`Reply to ${esc.userName}…`}
                    disabled={busy}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => (e.key === "Enter" ? void send() : null)}
                  />
                  <button className="sd-btn sd-btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
                </div>
              ) : (
                <div className="sd-state" style={{ padding: 10 }}>Take over to reply as a person — the assistant is handling it right now.</div>
              )
            ) : (
              <div className="sd-state" style={{ padding: 10 }}>This one came from the &ldquo;something isn&apos;t working&rdquo; form, so there is no chat to reply into.</div>
            )}
          </>
        ) : null}
      </main>

      {/* the customer */}
      {esc ? (
        <aside className="sd-cust">
          {customer ? (
            <>
              <div className="sd-card">
                <h6>{customer.tenant.name}</h6>
                <div className="sd-kv"><span>Extensions</span><b>{customer.counts.extensions ?? "—"}</b></div>
                <div className="sd-kv"><span>People</span><b>{customer.counts.users ?? "—"}</b></div>
                <div className="sd-kv"><span>Numbers</span><b>{customer.counts.numbers ?? "—"}</b></div>
                {customer.billing ? (
                  <>
                    <div className="sd-kv"><span>Autopay</span><b className={customer.billing.autopay ? "sd-ok" : "sd-warn"}>{customer.billing.autopay ? "On" : "Off"}</b></div>
                    <div className="sd-kv"><span>Needs attention</span><b className={customer.billing.invoicesNeedingAttention ? "sd-bad" : ""}>{customer.billing.invoicesNeedingAttention ?? "—"}</b></div>
                  </>
                ) : null}
              </div>
              {customer.pastEscalations.filter((p) => p.id !== esc.id).length ? (
                <div className="sd-card">
                  <h6>Past escalations</h6>
                  {customer.pastEscalations.filter((p) => p.id !== esc.id).map((p) => (
                    <button key={p.id} className="sd-kv sd-kv-link" onClick={() => rows.some((r) => r.id === p.id) && setSelectedId(p.id)}>
                      <span>{p.requestSummary.slice(0, 30)}{p.requestSummary.length > 30 ? "…" : ""}</span>
                      <b>{timeAgo(p.createdAt)}</b>
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : <div className="sd-state">Loading the customer…</div>}
        </aside>
      ) : null}

      {approveOpen && detail?.fixAction ? (
        <div className="sd-modal-back" onClick={() => (busy ? null : setApproveOpen(false))}>
          <div className="sd-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Approve the fix</h3>
            <p>{detail.fixAction.summary || esc?.proposedFix}</p>
            <p className="sd-dim">Enter your account password to carry it out.</p>
            <input type="password" autoFocus value={password} placeholder="Your password"
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void approve() : null)} />
            {err ? <div className="sd-banner sd-banner-bad">{err}</div> : null}
            <div className="sd-modal-actions">
              <button className="sd-btn" disabled={busy} onClick={() => setApproveOpen(false)}>Cancel</button>
              <button className="sd-btn sd-btn-primary" disabled={!password || busy} onClick={() => void approve()}>Approve and run</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
