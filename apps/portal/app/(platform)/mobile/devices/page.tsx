"use client";
/**
 * LoopCom Mobile — Devices & SIMs. Device-centric view of the same lines,
 * plus the eSIM install screen (real QR — the code is a secret; every view
 * is audited server-side). Gated by can_view_mobile_devices; the esim
 * endpoint here rides the devices prefix so this page's key opens it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { EmptyState, LoadingCard, Note, PageHead, StatusPill, errText, fmtDate, fmtDateTime } from "../MobileUi";

type Device = {
  simId: string; type: string; status: string | null; iccidLast4: string | null;
  esimInstallationStatus: string | null; hasActivationCode: boolean; lastSyncAt: string | null; issuedAt: string;
  line: { id: string; phoneNumber: string | null; label: string; status: string; subscriber: { name: string } | null; planName: string | null } | null;
};

export default function MobileDevicesPage() {
  const router = useRouter();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [filter, setFilter] = useState<"all" | "esim" | "physical" | "not_installed" | "suspended">("all");
  const [esim, setEsim] = useState<{ lineId: string; code: string; instructions: string[]; lineStatus: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await apiGet<{ devices: Device[] }>("/mobile-service/devices");
      setDevices(out.devices ?? []);
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't load devices.") });
      setDevices([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    const all = devices ?? [];
    if (filter === "esim") return all.filter((d) => d.type === "esim");
    if (filter === "physical") return all.filter((d) => d.type === "physical");
    if (filter === "not_installed") return all.filter((d) => d.type === "esim" && d.esimInstallationStatus === "released");
    if (filter === "suspended") return all.filter((d) => d.line?.status === "suspended" || d.line?.status === "lost");
    return all;
  }, [devices, filter]);

  const showEsim = async (lineId: string) => {
    setNote(null);
    try {
      const out = await apiGet<{ activationCode: string; instructions: string[]; lineStatus: string }>(`/mobile-service/devices/${lineId}/esim`);
      setEsim({ lineId, code: out.activationCode, instructions: out.instructions ?? [], lineStatus: out.lineStatus });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setNote({ kind: "bad", text: errText(e, "Couldn't fetch the eSIM install code.") });
    }
  };

  // Poll while the install screen is open so the line flips green live.
  useEffect(() => {
    if (!esim) return;
    const t = window.setInterval(async () => {
      try {
        const out = await apiGet<{ devices: Device[] }>("/mobile-service/devices");
        setDevices(out.devices ?? []);
        const mine = (out.devices ?? []).find((d) => d.line?.id === esim.lineId);
        if (mine?.line?.status === "active") {
          setNote({ kind: "ok", text: "The eSIM is installed and the line is ACTIVE — turn Wi-Fi off and load a page to test it." });
          setEsim(null);
        }
      } catch {
        /* keep polling */
      }
    }, 20000);
    return () => window.clearInterval(t);
  }, [esim]);

  const counts = {
    all: devices?.length ?? 0,
    esim: devices?.filter((d) => d.type === "esim").length ?? 0,
    physical: devices?.filter((d) => d.type === "physical").length ?? 0,
    not_installed: devices?.filter((d) => d.type === "esim" && d.esimInstallationStatus === "released").length ?? 0,
    suspended: devices?.filter((d) => d.line?.status === "suspended" || d.line?.status === "lost").length ?? 0,
  };

  return (
    <PermissionGate permission="can_view_mobile_devices" fallback={<div className="lmx"><EmptyState title="No access to Devices & SIMs" text="Ask your account owner to grant the Devices page in LoopCom Mobile." /></div>}>
      <div className="lmx">
        <PageHead title="Devices & SIMs" subtitle="Every SIM and eSIM on your account, what it's in, and what it's doing." />
        <Note note={note} />

        {esim ? (
          <div className="lcard" style={{ borderColor: "color-mix(in srgb, var(--accent) 45%, var(--border))" }}>
            <div className="lcard-h"><h3>Install your eSIM</h3><button className="lbtn sm" onClick={() => setEsim(null)}>Done</button></div>
            <div className="row" style={{ gap: 22, alignItems: "flex-start" }}>
              <div className="qrbox"><QRCodeSVG value={esim.code} size={196} /></div>
              <div style={{ minWidth: 220, flex: 1 }}>
                <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, lineHeight: 1.9 }}>
                  {esim.instructions.map((step, i) => <li key={i}>{step}</li>)}
                </ol>
                <div className="seclbl" style={{ marginTop: 12 }}>Can't scan? Enter it manually</div>
                <code className="codebox">{esim.code}</code>
                <p className="help" style={{ marginTop: 8 }}>This code is the line's identity — it's shown only here, and every view of this screen is logged. When the phone registers, the line flips to Active on this page by itself.</p>
              </div>
            </div>
          </div>
        ) : null}

        <div className="chips" style={{ marginTop: esim ? 14 : 0 }}>
          {([["all", "All"], ["esim", "eSIM"], ["physical", "Physical"], ["not_installed", "Not installed"], ["suspended", "Suspended"]] as const).map(([key, label]) => (
            <button key={key} className={`chip ${filter === key ? "on" : ""}`} onClick={() => setFilter(key)}>{label} <small>{(counts as any)[key]}</small></button>
          ))}
        </div>

        {!devices ? <LoadingCard rows={5} /> : rows.length === 0 ? (
          <EmptyState title={devices.length === 0 ? "No SIMs yet" : "Nothing matches this filter"} text={devices.length === 0 ? "When LoopCom issues your first eSIM it appears here with its install screen." : "Try a different filter."} />
        ) : (
          <div className="lcard" style={{ padding: 0, overflow: "hidden" }}>
            <div className="twrap" style={{ border: 0 }}>
              <table className="t">
                <thead><tr><th>Device / SIM</th><th>Line</th><th>Type</th><th>ICCID</th><th>Status</th><th>Last activity</th><th></th></tr></thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.simId}>
                      <td>
                        {d.esimInstallationStatus && d.esimInstallationStatus !== "released"
                          ? <b>Installed device</b>
                          : <b className="dimtx">Not installed yet</b>}
                        <span className="sub">{d.line?.subscriber?.name ? `${d.line.subscriber.name}'s` : "Unassigned"} · issued {fmtDate(d.issuedAt)}</span>
                      </td>
                      <td>{d.line ? <span className="rowlink mono" onClick={() => router.push(`/mobile/lines/${d.line!.id}`)}>{d.line.phoneNumber ?? d.line.label}</span> : <span className="dimtx">—</span>}</td>
                      <td>{d.type === "esim" ? "eSIM" : "Physical"}</td>
                      <td className="mono">{d.iccidLast4 ? `…${d.iccidLast4}` : "—"}</td>
                      <td>{d.line ? <StatusPill status={d.line.status} /> : <span className="pill dim">Unattached</span>}</td>
                      <td>{d.lastSyncAt ? fmtDateTime(d.lastSyncAt) : <span className="dimtx">—</span>}</td>
                      <td>
                        {d.type === "esim" && d.hasActivationCode && d.line && d.line.status === "pending_activation" ? (
                          <button className="lbtn sm primary" onClick={() => void showEsim(d.line!.id)}>Install QR</button>
                        ) : d.line && (d.line.status === "suspended" || d.line.status === "lost") ? (
                          <button className="lbtn sm" onClick={() => router.push(`/mobile/lines/${d.line!.id}`)}>Manage</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="lcard">
          <div className="lcard-h"><h3>Need something else?</h3></div>
          <div className="row">
            <button className="lbtn sm" onClick={() => router.push("/mobile/support")}>Replace an eSIM (new phone) →</button>
            <button className="lbtn sm" onClick={() => router.push("/mobile/support")}>Request a physical SIM →</button>
            <button className="lbtn sm danger" onClick={() => router.push("/mobile/lines")}>Report a device lost →</button>
          </div>
          <p className="help" style={{ marginTop: 8 }}>Replacements and physical-SIM orders go through Mobile Support so the old profile is retired safely — the new eSIM's QR appears right here when it's issued.</p>
        </div>
      </div>
    </PermissionGate>
  );
}
