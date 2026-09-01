"use client";

/**
 * The Desk — screen 1 of the approved redesign.
 * https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030
 *
 * Cases left, the conversation in the middle, the customer on the right, and
 * the Watchman across the top. The escalation IS the conversation: the agent's
 * report is a card INSIDE the thread, and taking over is a button in the
 * composer rather than a screen of its own.
 *
 * ⛔ Evolved from SupportEscalationChats rather than rewritten. The list →
 * detail → take over → approve chain was already proven against real
 * escalations; rewriting working call paths to add chrome is how a redesign
 * breaks the one thing that worked. What is new here is the Watchman strip, the
 * customer's own conversations behind a deliberate click, and the case pills.
 *
 * ⛔ Reply, take-over and approve all reuse the EXISTING routes exactly.
 * Approving posts the DRAFT action id to the password-gated
 * `/admin/agent-confirmations/:id/apply` — one apply path on the platform,
 * never a second.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../../../services/apiClient";
import { parseEscalationReport, fixStatusLabel } from "../../../../lib/escalationReport";
import SupportThreads from "./SupportThreads";
import SupportConversations from "./SupportConversations";

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
/** A direct support↔customer message — the channel that actually NOTIFIES them. */
type CaseMsg = { id: string; direction: string; body: string; createdAt: string; readAt: string | null };
type Customer = {
  tenant: { name: string };
  counts: { extensions: number | null; users: number | null; numbers: number | null };
  billing: { autopay: boolean; invoicesNeedingAttention: number | null } | null;
  pastEscalations: Array<{ id: string; requestSummary: string; createdAt: string }>;
};
type Watchman = {
  safeToWork: boolean;
  blockers: string[];
  checks: Array<{ id: string; label: string; status: "ok" | "warn" | "bad" | "unknown"; detail: string }>;
  checkedAt?: string;
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

/**
 * The Watchman, as a strip.
 *
 * ⛔ It was a tab. A standing safety check that you have to navigate to is a
 * check nobody reads — it belongs in view while you work, which is the whole
 * point of a watchman. ⛔ A failed probe reports "unknown", and unknown is
 * shown as a warning rather than quietly dropped: a check that cannot answer
 * must never look like a check that passed.
 */
function WatchmanStrip() {
  const [w, setW] = useState<Watchman | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<Watchman>("/admin/support/watchman")
        .then((out) => alive && (setW(out), setFailed(false)))
        .catch(() => alive && setFailed(true));
    void load();
    const t = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  if (failed) {
    return (
      <div className="sd-wstrip">
        <span className="sd-wstrip-item"><i className="sd-dot sd-dot-warn" />The Watchman didn&apos;t answer — treat the server as unchecked.</span>
      </div>
    );
  }
  if (!w) return <div className="sd-wstrip"><span className="sd-wstrip-item sd-dim">Checking the server…</span></div>;

  return (
    <div className={"sd-wstrip" + (w.safeToWork ? "" : " sd-wstrip-bad")}>
      {w.checks.map((c) => (
        <span key={c.id} className="sd-wstrip-item">
          <i className={"sd-dot " + (c.status === "ok" ? "sd-dot-ok" : c.status === "bad" ? "sd-dot-bad" : "sd-dot-warn")} />
          {c.label} <b>{c.detail}</b>
        </span>
      ))}
      <span className="sd-wstrip-tail">
        Watchman{w.checkedAt ? ` · checked ${timeAgo(w.checkedAt)} ago` : ""} · {w.safeToWork ? "safe to work" : "STOP — something is off"}
      </span>
    </div>
  );
}

export default function SupportDesk() {
  const [rows, setRows] = useState<Row[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ escalation: Detail; fixAction: FixAction; messages: Msg[] } | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [caseMsgs, setCaseMsgs] = useState<CaseMsg[]>([]);
  const [takenOver, setTakenOver] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const [approveOpen, setApproveOpen] = useState(false);
  const [password, setPassword] = useState("");
  /** The customer's own conversations, opened deliberately FROM this case. */
  const [threadsFor, setThreadsFor] = useState<{ tenantId: string; tenantName: string; caseRef: string } | null>(null);
  /** Watching the assistant across every company — a secondary screen now, not a tab. */
  const [watchingAssistant, setWatchingAssistant] = useState(false);
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
      // The direct-message thread for this ticket. Reading it here also marks
      // the customer's replies as read (that is the route's contract).
      apiGet<{ messages: CaseMsg[] }>(
        `/admin/support/escalations/${encodeURIComponent(out.escalation.reference)}/messages`,
      )
        .then((m) => selRef.current === id && setCaseMsgs(Array.isArray(m.messages) ? m.messages : []))
        .catch(() => setCaseMsgs([]));
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

  /**
   * ⛔⛔ Sends a SUPPORT MESSAGE, not a conversation message. The old composer
   * posted into the assistant conversation, which nothing ever notified the
   * customer about — Izzy replied to a real ticket and the customer never got
   * it (2026-09-01). This route lands in the widget with a pop-up beside the
   * bubble, and mirrors into the chat server-side when one exists.
   */
  async function send() {
    if (!esc || !draft.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      await apiPost(`/admin/support/escalations/${encodeURIComponent(esc.reference)}/message`, {
        message: draft.trim(),
      });
      setDraft("");
      setNotice(`Sent — ${esc.userName} gets a notification beside their assistant bubble.`);
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

  // ── the customer's own conversations, scoped to this case ──
  if (threadsFor) {
    return (
      <SupportThreads
        tenantId={threadsFor.tenantId}
        tenantName={threadsFor.tenantName}
        caseRef={threadsFor.caseRef}
        onClose={() => setThreadsFor(null)}
      />
    );
  }

  // ── watching the assistant across every company ──
  if (watchingAssistant) {
    return (
      <>
        <div className="sd-subhead">
          <button className="sd-btn" onClick={() => setWatchingAssistant(false)}>← Back to the desk</button>
          <span className="sd-dim">
            Every company&apos;s conversation with the assistant. Taking over is normally done from the case itself.
          </span>
        </div>
        <SupportConversations />
      </>
    );
  }

  return (
    <>
      <WatchmanStrip />
      <div className="sd-subhead">
        <span className="sd-dim">
          {listState === "ready"
            ? `${rows.length} case${rows.length === 1 ? "" : "s"}${rows.filter((r) => r.hasFixAction).length ? ` · ${rows.filter((r) => r.hasFixAction).length} with a fix ready` : ""}`
            : " "}
        </span>
        <button className="sd-btn" onClick={() => setWatchingAssistant(true)}>Watch the assistant…</button>
      </div>

      <div className="sd-body sd-body-3">
        {/* people, not tickets */}
        <aside className="sd-queue">
          {listState === "loading" ? <div className="sd-state">Loading…</div> : null}
          {listState === "error" ? <div className="sd-state sd-state-bad">Couldn&apos;t load the cases.</div> : null}
          {listState === "ready" && rows.length === 0 ? (
            <div className="sd-state">Nothing escalated — when the assistant passes something to the team it appears here as a chat.</div>
          ) : null}
          {rows.map((r) => {
            const fix = fixStatusLabel(r.fixStatus, r.hasFixAction);
            const fresh = Date.now() - new Date(r.createdAt).getTime() < 24 * 3600_000;
            return (
              <button key={r.id} className={"sd-item" + (r.id === selectedId ? " on" : "")} onClick={() => setSelectedId(r.id)}>
                <span className="sd-item-top">
                  <b>{r.userName} · {r.tenantName}</b>
                  <time>{timeAgo(r.createdAt)}</time>
                </span>
                <span className="sd-item-sum">&ldquo;{r.requestSummary}&rdquo;</span>
                <span className="sd-item-chips">
                  {fix ? <span className="sd-chip sd-chip-ok">{fix}</span> : fresh ? <span className="sd-chip sd-chip-bad">New</span> : <span className="sd-chip sd-chip-dim">Open</span>}
                  <span className="sd-chip sd-chip-dim">Ref {r.reference}</span>
                  {r.researchDegraded ? <span className="sd-chip sd-chip-warn">No research</span> : null}
                </span>
              </button>
            );
          })}
        </aside>

        {/* the conversation */}
        <main className="sd-detail sd-inbox-main">
          {!esc ? <div className="sd-state">Pick a case.</div> : null}
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
                    <h5>What the assistant found</h5>
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
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {fixReady ? (
                      <>
                        <button className="sd-btn sd-btn-primary" onClick={() => { setApproveOpen(true); setErr(""); }}>Approve the fix</button>
                        <span className="sd-dim" style={{ fontSize: 11 }}>Approving asks for your password</span>
                      </>
                    ) : detail?.fixAction ? (
                      <span className="sd-chip sd-chip-dim">Approval already used</span>
                    ) : null}
                  </div>
                  {esc.fixResult ? <div className="sd-dim">{esc.fixResult}</div> : null}
                </div>

                {/* Direct support↔customer messages on this ticket — the
                    channel that actually notifies them. Their replies land
                    here too, and reading this thread marks them read. */}
                {caseMsgs.map((m) => (
                  <div
                    key={m.id}
                    className={"sd-msg " + (m.direction === "from_customer" ? "sd-msg-user" : "sd-msg-agent")}
                    style={m.direction !== "from_customer" ? { borderColor: "var(--success)", alignSelf: "flex-end" } : undefined}
                  >
                    <span className="sd-msg-who">
                      {m.direction === "from_customer" ? `${esc.userName} · reply` : "Loopcom support"}
                      {" · "}{timeAgo(m.createdAt)}
                      {m.direction !== "from_customer" ? (m.readAt ? " · read" : " · not read yet") : ""}
                    </span>
                    {m.body}
                  </div>
                ))}
              </div>

              {/* ⛔ ALWAYS a way to write to the person — with or without a
                  chat, taken over or not. The old dead ends ("no chat to reply
                  into" / "take over first") were exactly where a real reply
                  went missing. */}
              <div className="sd-composer">
                <input
                  value={draft}
                  placeholder={`Message ${esc.userName} — lands by their assistant bubble with a notification…`}
                  disabled={busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => (e.key === "Enter" ? void send() : null)}
                />
                <button className="sd-btn sd-btn-primary" disabled={busy || !draft.trim()} onClick={() => void send()}>Send</button>
              </div>
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
                    <h6>Past cases</h6>
                    {customer.pastEscalations.filter((p) => p.id !== esc.id).map((p) => (
                      <button key={p.id} className="sd-kv sd-kv-link" onClick={() => rows.some((r) => r.id === p.id) && setSelectedId(p.id)}>
                        <span>{p.requestSummary.slice(0, 30)}{p.requestSummary.length > 30 ? "…" : ""}</span>
                        <b>{timeAgo(p.createdAt)}</b>
                      </button>
                    ))}
                  </div>
                ) : null}

                {/*
                  ⛔ Their conversations sit behind ONE deliberate click and the
                  screen says the open is recorded. That sentence is the
                  difference between this and the browse surface it replaced:
                  the same data, the same reply path, but with a reason attached
                  to the reading.
                */}
                <div className="sd-card">
                  <h6>Their texts</h6>
                  <div className="sd-locked">
                    <b>Not opened</b>
                    Open this customer&apos;s conversations for this case. Every open is recorded against Ref {esc.reference}.
                  </div>
                  <button
                    className="sd-btn"
                    style={{ width: "100%", marginTop: 8 }}
                    onClick={() => setThreadsFor({ tenantId: esc.tenantId, tenantName: esc.tenantName, caseRef: esc.reference })}
                  >
                    Open their conversations
                  </button>
                </div>
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
    </>
  );
}
