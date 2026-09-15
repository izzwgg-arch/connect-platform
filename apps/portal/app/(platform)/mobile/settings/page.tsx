"use client";
/**
 * LoopCom Mobile — Mobile Settings. Notifications, billing contacts, what
 * members may do, and the E911 address table. Saving is manager-only (the
 * API enforces it too). Gated by can_view_mobile_settings.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPut } from "../../../../services/apiClient";
import { ConnectSelect } from "../../../../components/ConnectSelect";
import { EmptyState, LoadingCard, Modal, Note, PageHead, errText } from "../MobileUi";

type Settings = {
  usageWarnPct: number; billingEmails: string[];
  notifyUsage: boolean; notifyPorts: boolean; notifyInvoices: boolean; notifyNewDevice: boolean;
  memberCanPause: boolean; memberCanChangePlan: boolean; memberCanReportLost: boolean; memberCanPort: boolean;
};
type E911Row = { id: string; phoneNumber: string | null; label: string; e911Status: string; e911Address: { line1?: string; city?: string; state?: string; zip?: string } | null };

export default function MobileSettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [e911, setE911] = useState<E911Row[]>([]);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [emailsOpen, setEmailsOpen] = useState(false);
  const [emailsDraft, setEmailsDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ settings: Settings; e911: E911Row[] }>("/mobile-service/settings");
      setSettings(out.settings);
      setE911(out.e911 ?? []);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load mobile settings.") });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<Settings>) => {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...settings, ...patch });
    setBusy(true);
    try {
      const out = await apiPut<{ settings: Settings }>("/mobile-service/settings", patch as any);
      setSettings(out.settings);
      setNote({ kind: "ok", text: "Saved." });
    } catch (e: any) {
      setSettings(prev);
      setNote({ kind: "bad", text: errText(e, "Couldn't save — managers only.") });
    } finally {
      setBusy(false);
    }
  };

  const saveEmails = async () => {
    const emails = emailsDraft.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    await save({ billingEmails: emails });
    setEmailsOpen(false);
  };

  const Toggle = ({ k, title, sub }: { k: keyof Settings; title: string; sub?: string }) => (
    <div className="trow">
      <div><b>{title}</b>{sub ? <span className="sub">{sub}</span> : null}</div>
      <span className={`sw ${settings?.[k] ? "on" : ""}`} role="switch" aria-checked={Boolean(settings?.[k])} onClick={() => !busy && void save({ [k]: !settings?.[k] } as any)} />
    </div>
  );

  const missing = e911.filter((r) => r.e911Status !== "on_file").length;

  return (
    <PermissionGate permission="can_view_mobile_settings" fallback={<div className="lmx"><EmptyState title="No access to Mobile Settings" text="Ask your account owner to grant the Settings page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Mobile Settings" subtitle="Notifications, billing contacts, emergency addresses and what members are allowed to do." />
        <Note note={note} />
        {!settings ? <LoadingCard rows={6} /> : (
          <div className="g2">
            <div className="stack">
              <div className="lcard">
                <div className="lcard-h"><h3>Notifications</h3></div>
                <Toggle k="notifyUsage" title="Usage warnings" sub="Email when a line passes its threshold" />
                <div className="trow">
                  <div><b>Warning threshold</b><span className="sub">Applies to every line</span></div>
                  <div style={{ width: 110 }}>
                    <ConnectSelect size="sm" ariaLabel="Warning threshold" value={String(settings.usageWarnPct)} onChange={(v: string) => void save({ usageWarnPct: Number(v) })} options={[{ value: "75", label: "75%" }, { value: "80", label: "80%" }, { value: "90", label: "90%" }, { value: "95", label: "95%" }]} />
                  </div>
                </div>
                <Toggle k="notifyPorts" title="Transfer updates" sub="Every status change on a number transfer" />
                <Toggle k="notifyInvoices" title="Invoice ready" sub="Email when a Mobile invoice is issued" />
                <Toggle k="notifyNewDevice" title="New device installed" sub="Alert when any eSIM installs" />
              </div>

              <div className="lcard">
                <div className="lcard-h"><h3>Billing contacts</h3></div>
                <p style={{ fontSize: 13 }}>{settings.billingEmails.length > 0 ? <>Mobile invoices email to <b>{settings.billingEmails.join(", ")}</b></> : "Using your account's billing contacts. Add mobile-specific recipients if the mobile bill goes to someone else."}</p>
                <button className="lbtn sm" style={{ marginTop: 10 }} onClick={() => { setEmailsDraft(settings.billingEmails.join(", ")); setEmailsOpen(true); }}>Edit recipients</button>
              </div>

              <div className="lcard">
                <div className="lcard-h"><h3>What members can do</h3><span className="dimtx small">Managers always can; these govern Members</span></div>
                <Toggle k="memberCanPause" title="Pause their own line" />
                <Toggle k="memberCanChangePlan" title="Change their own plan" sub="Off = they ask a manager" />
                <Toggle k="memberCanReportLost" title="Report lost / stolen" />
                <Toggle k="memberCanPort" title="Start a number transfer" sub="Managers-only is the safe default" />
              </div>
            </div>

            <div className="stack">
              <div className="lcard">
                <div className="lcard-h"><h3>Emergency addresses (E911)</h3>{missing > 0 ? <span className="pill warn nub">{missing} missing</span> : <span className="pill ok nub">All on file</span>}</div>
                {e911.length === 0 ? <p className="dimtx small">Lines appear here as they're created.</p> : (
                  <div className="twrap">
                    <table className="t">
                      <thead><tr><th>Line</th><th>Address</th><th>Status</th><th></th></tr></thead>
                      <tbody>
                        {e911.map((r) => (
                          <tr key={r.id}>
                            <td className="mono">{r.phoneNumber ?? r.label}</td>
                            <td>{r.e911Address?.line1 ? `${r.e911Address.line1}, ${r.e911Address.city ?? ""} ${r.e911Address.state ?? ""}` : <span className="dimtx">—</span>}</td>
                            <td>{r.e911Status === "on_file" ? <span className="pill ok">On file</span> : <span className="pill warn">Missing</span>}</td>
                            <td><span className="rowlink" onClick={() => router.push(`/mobile/lines/${r.id}`)}>{r.e911Status === "on_file" ? "Edit" : "Add"}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {missing > 0 ? <div className="banner" style={{ marginTop: 12 }}><div><b>911 needs to know where you are.</b> Lines without an address can't be located by emergency services. Adding one takes a minute.</div></div> : null}
              </div>

              <div className="lcard">
                <div className="lcard-h"><h3>Service gates</h3></div>
                <div className="trow"><div><b>Cellular calling</b><span className="sub">Carrier beta — your LoopCom app keeps handling calls meanwhile</span></div><span className="sw lock" /></div>
                <div className="trow"><div><b>Business texting on mobile numbers</b><span className="sub">Carrier registration (10DLC) is required first</span></div><span className="sw lock" /></div>
                <p className="help" style={{ marginTop: 8 }}>Locked switches unlock automatically when the carrier capability goes live — nothing here needs your action.</p>
              </div>
            </div>
          </div>
        )}

        {emailsOpen ? (
          <Modal title="Mobile billing recipients" onClose={() => setEmailsOpen(false)}
            footer={<><button className="lbtn ghost" onClick={() => setEmailsOpen(false)}>Cancel</button><button className="lbtn primary" disabled={busy} onClick={() => void saveEmails()}>Save recipients</button></>}>
            <div className="field"><label>Email addresses (comma-separated, up to 6)</label>
              <input className="linput" value={emailsDraft} onChange={(e) => setEmailsDraft(e.target.value)} placeholder="books@company.com, owner@company.com" />
            </div>
            <p className="help" style={{ marginTop: 8 }}>Leave empty to use your account's regular billing contacts.</p>
          </Modal>
        ) : null}
      </div>
    </PermissionGate>
  );
}
