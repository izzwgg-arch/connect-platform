"use client";
/**
 * LoopCom Mobile — Porting. The tracker is the hero: every request renders
 * the five-step stepper with failures inline and the fix one click away.
 * The customer's submit creates/updates the DRAFT; filing with the carrier
 * is LoopCom's act (console-gated). Gated by can_view_mobile_porting.
 */
import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Modal, Note, PageHead, PortStatusPill, errText, fmtDate } from "../MobileUi";

type PortRow = { id: string; phoneNumber: string; status: string; carrier: string | null; focDate: string | null; createdAt: string };
type PortDetail = { id: string; phoneNumber: string; status: string; carrier: string | null; focDate: string | null; holderName: string | null; serviceAddress: string | null; accountNumberLast4: string | null; pinOnFile: boolean };

const STEPS = ["Request created", "Details submitted", "Carrier check", "Transfer date set", "Number moves"];

function stepStates(status: string): Array<"done" | "now" | "fail" | "todo"> {
  switch (status) {
    case "draft": return ["done", "now", "todo", "todo", "todo"];
    case "submitted": return ["done", "done", "now", "todo", "todo"];
    case "pending": return ["done", "done", "now", "todo", "todo"];
    case "action_required": return ["done", "done", "fail", "todo", "todo"];
    case "rejected": return ["done", "done", "fail", "todo", "todo"];
    case "foc": return ["done", "done", "done", "done", "now"];
    case "completed": return ["done", "done", "done", "done", "done"];
    case "cancelled": return ["done", "fail", "todo", "todo", "todo"];
    default: return ["done", "todo", "todo", "todo", "todo"];
  }
}

export default function MobilePortingPage() {
  const [ports, setPorts] = useState<PortRow[] | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [newNumber, setNewNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PortDetail | null>(null);
  const [detailForm, setDetailForm] = useState({ carrier: "", holderName: "", serviceAddress: "", accountNumber: "", transferPin: "" });

  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ portRequests: PortRow[] }>("/mobile-service/port-requests");
      setPorts(out.portRequests ?? []);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load transfers.") });
      setPorts([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const start = async () => {
    setBusy(true);
    setNote(null);
    try {
      const out = await apiPost<{ id: string; message: string }>("/mobile-service/port-requests", { phoneNumber: newNumber });
      setNewNumber("");
      setNote({ kind: "ok", text: out.message ?? "Transfer saved as a draft — add the carrier details next." });
      await load();
      await openDetail(out.id);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't start the transfer.") });
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    try {
      const out = await apiGet<{ portRequest: PortDetail }>(`/mobile-service/port-requests/${id}`);
      setEditing(out.portRequest);
      setDetailForm({ carrier: out.portRequest.carrier ?? "", holderName: out.portRequest.holderName ?? "", serviceAddress: out.portRequest.serviceAddress ?? "", accountNumber: "", transferPin: "" });
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't open the transfer.") });
    }
  };

  const saveDetail = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (detailForm.carrier.trim()) body.carrier = detailForm.carrier.trim();
      if (detailForm.holderName.trim()) body.holderName = detailForm.holderName.trim();
      if (detailForm.serviceAddress.trim()) body.serviceAddress = detailForm.serviceAddress.trim();
      if (detailForm.accountNumber.trim()) body.accountNumber = detailForm.accountNumber.trim();
      if (detailForm.transferPin.trim()) body.transferPin = detailForm.transferPin.trim();
      await apiPatch(`/mobile-service/port-requests/${editing.id}`, body);
      setNote({ kind: "ok", text: "Transfer details saved. LoopCom files it with the carrier and you'll get a text/email at every step." });
      setEditing(null);
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't save the details.") });
    } finally {
      setBusy(false);
    }
  };

  const open = (ports ?? []).filter((p) => !["completed", "cancelled"].includes(p.status));
  const done = (ports ?? []).filter((p) => ["completed", "cancelled"].includes(p.status));

  return (
    <PermissionGate permission="can_view_mobile_porting" fallback={<div className="lmx"><EmptyState title="No access to Porting" text="Ask your account owner to grant the Porting page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Porting" subtitle="Bring your numbers to LoopCom Mobile. Your old service keeps working until the moment the transfer completes." />
        <Note note={note} />
        <div className="gmain">
          <div className="stack">
            <div className="lcard">
              <div className="lcard-h"><h3>Transfers</h3>{open.some((p) => p.status === "action_required" || p.status === "rejected") ? <span className="pill warn nub">needs you</span> : null}</div>
              {!ports ? <LoadingCard rows={3} /> : open.length === 0 && done.length === 0 ? (
                <EmptyState title="No transfers in progress" text="Bringing a number from another carrier takes a few days, and your old service keeps working the whole time." />
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  {open.map((p) => {
                    const states = stepStates(p.status);
                    return (
                      <div key={p.id} className="lcard" style={{ boxShadow: "none", borderRadius: 14, padding: 14 }}>
                        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
                          <div><b className="mono" style={{ fontSize: 15 }}>{p.phoneNumber}</b><span className="sub" style={{ display: "block", fontSize: 12, color: "var(--text-dim)" }}>{p.carrier ? `from ${p.carrier} · ` : ""}started {fmtDate(p.createdAt)}{p.focDate ? ` · transfer date ${fmtDate(p.focDate)}` : ""}</span></div>
                          <PortStatusPill status={p.status} />
                        </div>
                        <div className="stepper">
                          {STEPS.map((label, i) => (
                            <div key={i} className={`step ${states[i]}`}><span className="sdot">{states[i] === "done" ? "✓" : states[i] === "fail" ? "!" : i + 1}</span><b>{label}</b><small>{i === 3 && p.focDate ? fmtDate(p.focDate) : ""}</small></div>
                          ))}
                        </div>
                        {p.status === "draft" ? (
                          <div className="banner info" style={{ marginTop: 10 }}><div><b>Add the carrier details to move this forward.</b><div className="sub">Account number, transfer PIN, and the exact name on the old account.</div><div className="row" style={{ marginTop: 8 }}><button className="lbtn sm primary" onClick={() => void openDetail(p.id)}>Add details</button></div></div></div>
                        ) : p.status === "action_required" || p.status === "rejected" ? (
                          <div className="banner" style={{ marginTop: 10 }}><div><b>{p.status === "rejected" ? "The old carrier rejected the request." : "The carrier needs more information."}</b><div className="sub">Most often the account number or transfer PIN — fix it and LoopCom refiles.</div><div className="row" style={{ marginTop: 8 }}><button className="lbtn sm primary" onClick={() => void openDetail(p.id)}>Fix details</button></div></div></div>
                        ) : null}
                      </div>
                    );
                  })}
                  {done.map((p) => (
                    <div key={p.id} className="lcard" style={{ boxShadow: "none", borderRadius: 14, padding: 14 }}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <div><b className="mono" style={{ fontSize: 15 }}>{p.phoneNumber}</b><span className="sub" style={{ display: "block", fontSize: 12, color: "var(--text-dim)" }}>{p.status === "completed" ? "completed" : "cancelled"} {fmtDate(p.createdAt)}</span></div>
                        <PortStatusPill status={p.status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="lcard">
              <div className="lcard-h"><h3>Start a transfer</h3></div>
              <p className="dimtx" style={{ fontSize: 13 }}>Keep your existing mobile number: enter it and add your old carrier's details. LoopCom handles the rest and keeps you posted at every step.</p>
              <div className="row" style={{ marginTop: 10 }}>
                <input className="linput" style={{ maxWidth: 220 }} placeholder="(555) 555-0123" value={newNumber} onChange={(e) => setNewNumber(e.target.value)} />
                <button className="lbtn primary" disabled={busy || !newNumber.trim()} onClick={() => void start()}>Start transfer</button>
              </div>
            </div>
          </div>

          <div className="stack">
            <div className="lcard">
              <div className="lcard-h"><h3>Before you start</h3></div>
              <div className="tl" style={{ fontSize: 13 }}>
                <Check text={<>Keep your old service <b>active</b> — don't cancel first</>} />
                <Check text={<>Get the <b>account number</b> from a bill or the app</>} />
                <Check text={<>Request a <b>transfer PIN</b> (a.k.a. Number Transfer PIN)</>} />
                <Check text={<>Name &amp; address must <b>match the old account</b> exactly</>} />
              </div>
            </div>
            <div className="lcard">
              <div className="lcard-h"><h3>What happens when</h3></div>
              <div className="tl" style={{ fontSize: 13 }}>
                <NumRow n={1} title="You submit" sub="LoopCom files the request with the carrier" />
                <NumRow n={2} title="Carrier check" sub="1–2 business days; a wrong PIN bounces back here" />
                <NumRow n={3} title="Transfer date" sub="You're texted the date the number moves" />
                <NumRow n={4} title="Number moves" sub="Old SIM goes dark, your LoopCom line takes over — usually minutes" />
              </div>
            </div>
          </div>
        </div>

        {editing ? (
          <Modal title={`Carrier details — ${editing.phoneNumber}`} onClose={() => setEditing(null)}
            footer={<><button className="lbtn ghost" onClick={() => setEditing(null)}>Cancel</button><button className="lbtn primary" disabled={busy} onClick={() => void saveDetail()}>Save details</button></>}>
            <div className="form">
              <div className="field"><label>Current carrier</label><input className="linput" value={detailForm.carrier} onChange={(e) => setDetailForm({ ...detailForm, carrier: e.target.value })} placeholder="e.g. Verizon" /></div>
              <div className="field"><label>Account number {editing.accountNumberLast4 ? <span className="dimtx">(on file …{editing.accountNumberLast4})</span> : <span style={{ color: "var(--danger)" }}>*</span>}</label><input className="linput" value={detailForm.accountNumber} onChange={(e) => setDetailForm({ ...detailForm, accountNumber: e.target.value })} placeholder="From your carrier bill" /></div>
              <div className="field"><label>Transfer PIN {editing.pinOnFile ? <span className="pill ok nub" style={{ fontSize: 10 }}>on file</span> : <span style={{ color: "var(--danger)" }}>*</span>}</label><input className="linput" value={detailForm.transferPin} onChange={(e) => setDetailForm({ ...detailForm, transferPin: e.target.value })} placeholder="Ask your carrier for it" /></div>
              <div className="field"><label>Account holder name (exactly as the carrier has it)</label><input className="linput" value={detailForm.holderName} onChange={(e) => setDetailForm({ ...detailForm, holderName: e.target.value })} /></div>
              <div className="field full"><label>Service address on the old account</label><input className="linput" value={detailForm.serviceAddress} onChange={(e) => setDetailForm({ ...detailForm, serviceAddress: e.target.value })} placeholder="Street, city, state, ZIP" /></div>
            </div>
            <div className="banner info" style={{ marginTop: 12 }}><div>Wireless transfers need the <b>account number and transfer PIN</b> from your old carrier — a wrong PIN is the #1 cause of delays. The PIN is stored encrypted and never shown again.</div></div>
          </Modal>
        ) : null}
      </div>
    </PermissionGate>
  );
}

function Check({ text }: { text: React.ReactNode }) {
  return <div className="tlrow" style={{ padding: "5px 0", gridTemplateColumns: "20px 1fr" }}><span className="ti ok" style={{ width: 18, height: 18 }}>✓</span><div>{text}</div></div>;
}
function NumRow({ n, title, sub }: { n: number; title: string; sub: string }) {
  return <div className="tlrow" style={{ gridTemplateColumns: "24px 1fr" }}><span className="ti">{n}</span><div><b>{title}</b><span className="sub">{sub}</span></div></div>;
}
