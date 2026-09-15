"use client";
/**
 * LoopCom Mobile — Users (subscribers). People with mobile service; a
 * subscriber is NOT a portal login and can hold several lines. Gated by
 * can_view_mobile_users; every call is tenant-scoped server-side.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Modal, Note, PageHead, StatusPill, errText } from "../MobileUi";

type SubLine = { id: string; phoneNumber: string | null; label: string; status: string; plan: { id: string; name: string } | null; simType: string | null; e911Status: string };
type Subscriber = { id: string; firstName: string; lastName: string; name: string; email: string | null; role: string; notifyEmail: boolean; createdAt: string; lines: SubLine[] };

export default function MobileUsersPage() {
  const router = useRouter();
  const [subs, setSubs] = useState<Subscriber[] | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "with_lines" | "no_lines" | "no_e911">("all");
  const [editing, setEditing] = useState<Subscriber | "new" | null>(null);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", role: "member", notifyEmail: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ subscribers: Subscriber[] }>("/mobile-service/subscribers");
      setSubs(out.subscribers ?? []);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load subscribers.") });
      setSubs([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    if (!subs) return [];
    if (filter === "with_lines") return subs.filter((s) => s.lines.length > 0);
    if (filter === "no_lines") return subs.filter((s) => s.lines.length === 0);
    if (filter === "no_e911") return subs.filter((s) => s.lines.some((l) => l.e911Status !== "on_file"));
    return subs;
  }, [subs, filter]);

  const openEdit = (s: Subscriber | "new") => {
    setEditing(s);
    setForm(s === "new"
      ? { firstName: "", lastName: "", email: "", role: "member", notifyEmail: true }
      : { firstName: s.firstName, lastName: s.lastName, email: s.email ?? "", role: s.role, notifyEmail: s.notifyEmail });
  };

  const save = async () => {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      setNote({ kind: "bad", text: "First and last name are required." });
      return;
    }
    setBusy(true);
    try {
      const body = { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim() || null, role: form.role, notifyEmail: form.notifyEmail };
      if (editing === "new") await apiPost("/mobile-service/subscribers", body);
      else if (editing) await apiPatch(`/mobile-service/subscribers/${editing.id}`, body);
      setNote({ kind: "ok", text: editing === "new" ? "Subscriber added." : "Subscriber updated." });
      setEditing(null);
      await load();
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't save the subscriber.") });
    } finally {
      setBusy(false);
    }
  };

  const missingE911 = subs?.reduce((n, s) => n + (s.lines.some((l) => l.e911Status !== "on_file") ? 1 : 0), 0) ?? 0;

  return (
    <PermissionGate permission="can_view_mobile_users" fallback={<div className="lmx"><EmptyState title="No access to Mobile Users" text="Ask your account owner to grant the Users page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead
          title="Mobile Users"
          subtitle="People with mobile service — separate from portal logins. A subscriber can hold one or more lines."
          actions={<button className="lbtn primary" onClick={() => openEdit("new")}><Plus size={15} /> Add subscriber</button>}
        />
        <Note note={note} />
        <div className="chips">
          <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All <small>{subs?.length ?? 0}</small></button>
          <button className={`chip ${filter === "with_lines" ? "on" : ""}`} onClick={() => setFilter("with_lines")}>With lines</button>
          <button className={`chip ${filter === "no_lines" ? "on" : ""}`} onClick={() => setFilter("no_lines")}>No line yet</button>
          <button className={`chip ${filter === "no_e911" ? "on" : ""}`} onClick={() => setFilter("no_e911")}>Missing 911 address <small>{missingE911}</small></button>
        </div>

        {!subs ? <LoadingCard rows={5} /> : rows.length === 0 ? (
          <EmptyState title={subs.length === 0 ? "No subscribers yet" : "Nothing matches this filter"} text={subs.length === 0 ? "Add the people who'll carry LoopCom Mobile lines. Each can be assigned one or more lines." : "Try a different filter."}>
            {subs.length === 0 ? <button className="lbtn sm primary" onClick={() => openEdit("new")}>Add the first subscriber</button> : null}
          </EmptyState>
        ) : (
          <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
            <div className="twrap" style={{ border: 0 }}>
              <table className="t">
                <thead><tr><th>Subscriber</th><th>Lines</th><th>Plan</th><th>Status</th><th>Role</th><th>E911</th><th></th></tr></thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td><span className="rowlink" onClick={() => openEdit(s)}>{s.name}</span><span className="sub">{s.email ?? "no email on file"}</span></td>
                      <td>
                        {s.lines.length === 0 ? <span className="dimtx">—</span> : s.lines.map((l) => (
                          <div key={l.id} className="mono" style={{ cursor: "pointer", color: "var(--accent)" }} onClick={() => router.push(`/mobile/lines/${l.id}`)}>{l.phoneNumber ?? l.label}</div>
                        ))}
                      </td>
                      <td>{s.lines[0]?.plan?.name ?? <span className="dimtx">—</span>}{s.lines.length > 1 ? <span className="sub">+ {s.lines.length - 1} more</span> : null}</td>
                      <td>{s.lines[0] ? <StatusPill status={s.lines[0].status} /> : <span className="pill dim">No line</span>}</td>
                      <td style={{ textTransform: "capitalize" }}>{s.role}</td>
                      <td>{s.lines.length === 0 ? <span className="dimtx">—</span> : s.lines.every((l) => l.e911Status === "on_file") ? <span className="pill ok">On file</span> : <span className="pill warn">Missing</span>}</td>
                      <td><button className="lbtn sm" onClick={() => openEdit(s)}>Edit</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {editing ? (
          <Modal
            title={editing === "new" ? "Add a mobile subscriber" : `Edit ${editing.name}`}
            onClose={() => setEditing(null)}
            footer={<><button className="lbtn ghost" onClick={() => setEditing(null)}>Cancel</button><button className="lbtn primary" disabled={busy} onClick={() => void save()}>{editing === "new" ? "Add subscriber" : "Save changes"}</button></>}
          >
            <div className="form">
              <div className="field"><label>First name</label><input className="linput" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
              <div className="field"><label>Last name</label><input className="linput" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
              <div className="field full"><label>Email (for install links and usage warnings)</label><input className="linput" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" /></div>
              <div className="field full">
                <label>Role</label>
                <div className="row">
                  <button className={`chip ${form.role === "member" ? "on" : ""}`} onClick={() => setForm({ ...form, role: "member" })}>Member</button>
                  <button className={`chip ${form.role === "manager" ? "on" : ""}`} onClick={() => setForm({ ...form, role: "manager" })}>Manager</button>
                </div>
                <p className="help">What members may do themselves (pause, change plan, transfers) is set under Mobile Settings.</p>
              </div>
              <div className="field full">
                <div className="trow"><div><b>Email notifications</b><span className="sub">Usage warnings and service updates to this person</span></div><span className={`sw ${form.notifyEmail ? "on" : ""}`} role="switch" aria-checked={form.notifyEmail} onClick={() => setForm({ ...form, notifyEmail: !form.notifyEmail })} /></div>
              </div>
              {editing !== "new" && editing.lines.length > 0 ? (
                <div className="field full">
                  <label>Assigned lines</label>
                  {editing.lines.map((l) => <div key={l.id} className="mono" style={{ padding: "2px 0" }}>{l.phoneNumber ?? l.label} · {l.plan?.name ?? "no plan"}</div>)}
                  <p className="help">Assign or move lines from the Lines page.</p>
                </div>
              ) : null}
            </div>
          </Modal>
        ) : null}
      </div>
    </PermissionGate>
  );
}
