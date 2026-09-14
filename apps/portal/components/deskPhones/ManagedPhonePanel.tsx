"use client";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "../../services/apiClient";
import { ConnectSelect } from "../ConnectSelect";
import { managedPhoneErrorText, managedPhoneStatus } from "./managedPhoneStatus";

type Device = { id: string; mac: string; model: string; extensionId: string; nickname: string | null;
  displayName: string | null; rpsState: string; registrationState: string; lastError: string | null;
  configVersion: number; servedVersion: number | null; lastSeenAt: string | null;
  retiredAt: string | null; replacesId: string | null; options: { refreshMinutes?: number } };
type Extension = { id: string; extNumber: string; displayName: string };
const errorText = managedPhoneErrorText;
const RPS_LABEL: Record<string, string> = { pending_credentials: "pending Yealink access", assigned: "assigned to Loopcom",
  failed: "not assigned", conflict: "held by another provider", released: "released" };

/** An additional mode INSIDE the existing wizard, using its account context and controls. */
export function ManagedPhonePanel({ models, onBack }: { models: { model: string }[]; onBack: () => void }) {
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [model, setModel] = useState(models[0]?.model || "");
  const [mac, setMac] = useState("");
  const [extensionId, setExtensionId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [nickname, setNickname] = useState("");
  const [refreshMinutes, setRefresh] = useState(1440);
  const [selected, setSelected] = useState<Device | null>(null);
  const [replacesId, setReplacesId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    const result = await apiGet<{ devices: Device[] }>("/desk-phones/managed");
    setDevices(result.devices);
  }, []);
  useEffect(() => {
    let active = true;
    apiGet<{ extensions: Extension[] }>("/desk-phones/extensions").then(r => { if (active) setExtensions(r.extensions); }).catch(e => setError(errorText(e)));
    void reload().catch(e => setError(errorText(e)));
    const timer = setInterval(() => { void reload().catch(e => { if (active) setError(errorText(e)); }); }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [reload]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await fn(); await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  function edit(d: Device, replace = false) {
    setSelected(replace ? null : d); setReplacesId(replace ? d.id : undefined);
    setMac(replace ? "" : d.mac); setModel(d.model); setExtensionId(d.extensionId);
    setDisplayName(d.displayName || ""); setNickname(d.nickname || ""); setRefresh(d.options?.refreshMinutes || 1440);
  }
  return <>
    <div className="dps-wz-body">
      <h3>{replacesId ? "Prepare a replacement phone" : "Prepare a phone for delivery"}</h3>
      <p className="dps-sub">The phone will use the account currently selected in Loopcom. Choose an existing extension, then connect the phone to Ethernet or PoE when it arrives.</p>
      <form onSubmit={e => { e.preventDefault(); void action(async () => {
        const input = { extensionId, displayName, nickname, options: { refreshMinutes } };
        if (selected) await apiPost(`/desk-phones/managed/${selected.id}/update`, input);
        else await apiPost("/desk-phones/managed", { ...input, mac, model, replacesId });
        setSelected(null); setReplacesId(undefined); setMac("");
      }); }} style={{ display: "grid", gap: 12, marginTop: 18 }}>
        <label>Manufacturer<ConnectSelect value="yealink" onChange={() => {}} options={[{ value: "yealink", label: "Yealink" }]} /></label>
        <label>Model<ConnectSelect value={model} onChange={setModel} options={models.map(m => ({ value: m.model, label: m.model }))} disabled={!!selected} /></label>
        <label>MAC address<input className="dps-managed-input" required value={mac} maxLength={17} disabled={!!selected} onChange={e => setMac(e.target.value)} placeholder="80:5E:C0:11:22:33" /></label>
        <label>Extension<ConnectSelect value={extensionId} onChange={id => { setExtensionId(id); setDisplayName(extensions.find(e => e.id === id)?.displayName || ""); }} options={extensions.map(e => ({ value: e.id, label: `${e.extNumber} · ${e.displayName}` }))} /></label>
        <label>Display name<input className="dps-managed-input" maxLength={80} value={displayName} onChange={e => setDisplayName(e.target.value)} /></label>
        <label>Phone name (optional)<input className="dps-managed-input" maxLength={80} value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Front desk" /></label>
        <details><summary>Advanced settings</summary>
          <p className="dps-hint">New York time, automatic daylight saving, 12-hour clock. Firmware remains unchanged.</p>
          <label>Refresh interval (minutes)<input className="dps-managed-input" type="number" min={60} max={10080} value={refreshMinutes} onChange={e => setRefresh(Number(e.target.value))} /></label>
        </details>
        {replacesId && <p className="dps-hint">The old phone stays active until this replacement is verified. You can cancel by removing the replacement.</p>}
        <button className="dps-btn dps-btn-p" disabled={busy || !extensionId}>{selected ? "Save phone configuration" : "Provision phone"}</button>
        {(selected || replacesId) && <button type="button" className="dps-btn" onClick={() => { setSelected(null); setReplacesId(undefined); setMac(""); }}>Cancel edit</button>}
      </form>
      {error && <p role="alert" className="dps-hint" style={{ color: "var(--dps-warn)" }}>{error}</p>}
      <div aria-live="polite" style={{ display: "grid", gap: 12, marginTop: 24 }}>
        {devices.map(d => <article key={d.id} style={{ border: "1px solid var(--dps-border)", borderRadius: 12, padding: 14 }}>
          <b>{d.nickname || d.model} · {d.mac}</b><p>{managedPhoneStatus(d)}</p>
          <details><summary>View details</summary>
            <p>Model {d.model} · Configuration version {d.configVersion} (phone has {d.servedVersion ?? "none"}) · Zero-touch: {RPS_LABEL[d.rpsState] || d.rpsState}</p>
            <p>Last contact: {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Not yet observed"}</p>
            {d.lastError && <p>{errorText({ body: { error: d.lastError } })}</p>}
            <p>Cloud reboot, factory reset and firmware management are unavailable until a supported management channel is connected.</p>
          </details>
          {!d.retiredAt && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
            <button className="dps-btn" disabled={busy} onClick={() => edit(d)}>Edit / move extension</button>
            <button className="dps-btn" disabled={busy} onClick={() => void action(() => apiPost(`/desk-phones/managed/${d.id}/update`, {}))}>Reprovision on next check-in</button>
            <button className="dps-btn" disabled={busy} onClick={() => void action(() => apiPost(`/desk-phones/managed/${d.id}/reconcile`, {}))}>Retry RPS assignment</button>
            <button className="dps-btn" disabled={busy} onClick={() => edit(d, true)}>Replace phone</button>
            {d.replacesId && d.registrationState === "online" && <button className="dps-btn dps-btn-p" disabled={busy} onClick={() => void action(() => apiPost(`/desk-phones/managed/${d.id}/complete-replacement`, {}))}>Finish replacement</button>}
            {d.replacesId && d.registrationState === "endpoint_registered_device_unverified" && <button className="dps-btn" disabled={busy} onClick={() => {
              if (!window.confirm("Only continue if you have placed and received a call on the NEW phone. The old phone will be retired.")) return;
              void action(() => apiPost(`/desk-phones/managed/${d.id}/complete-replacement`, { attestedWorking: true }));
            }}>New phone works — finish replacement</button>}
            <details><summary>Remove or release</summary><p>Release stops RPS redirection. Removal stops future configuration downloads; it does not erase settings already on the phone.</p>
              <button className="dps-btn" disabled={busy} onClick={() => void action(() => apiPost(`/desk-phones/managed/${d.id}/release`, {}))}>Release RPS assignment</button>
              <button className="dps-btn" disabled={busy} onClick={() => void action(() => apiPost(`/desk-phones/managed/${d.id}/remove`, {}))}>Remove phone</button>
            </details>
          </div>}
        </article>)}
      </div>
    </div>
    <div className="dps-wz-foot"><button className="dps-btn" onClick={onBack} disabled={busy}>Back to office setup</button></div>
  </>;
}
