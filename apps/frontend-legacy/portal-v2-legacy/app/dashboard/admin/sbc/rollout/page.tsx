"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    return JSON.parse(atob(token.split(".")[1])).role || "";
  } catch {
    return "";
  }
}

type TenantRow = {
  id: string;
  name: string;
  mediaPolicy: "TURN_ONLY" | "RTPENGINE_PREFERRED";
  turnRequiredForMobile: boolean;
  mediaReliabilityGateEnabled: boolean;
  mediaTestStatus: "UNKNOWN" | "PASSED" | "FAILED" | "STALE";
  mediaTestedAt: string | null;
  sbcUdpExposureConfirmed: boolean;
  sbcUdpExposureConfirmedAt: string | null;
};

export default function AdminSbcRolloutPage() {
  const [role, setRole] = useState("");
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [detail, setDetail] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(null);
  const [opsPlan, setOpsPlan] = useState<any>(null);
  const [msg, setMsg] = useState("");

  const [checkWeb, setCheckWeb] = useState(false);
  const [checkMobile, setCheckMobile] = useState(false);
  const [checkOutboundAudio, setCheckOutboundAudio] = useState(false);
  const [checkInboundAudio, setCheckInboundAudio] = useState(false);
  const [checkDtmf, setCheckDtmf] = useState(false);
  const [checkEndSync, setCheckEndSync] = useState(false);

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function loadTenants() {
    const res = await fetch(`${apiBase}/admin/sbc/rollout/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => []);
    const rows = Array.isArray(json) ? json : [];
    setTenants(rows);
    if (!tenantId && rows[0]?.id) setTenantId(rows[0].id);
  }

  async function loadTenantDetail(id: string) {
    if (!id) return;
    const res = await fetch(`${apiBase}/admin/sbc/rollout/tenant/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (res.ok) setDetail(json);
  }

  async function loadReadiness() {
    const res = await fetch(`${apiBase}/admin/sbc/readiness`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (json) setReadiness(json);
  }

  async function loadOpsPlan() {
    const res = await fetch(`${apiBase}/admin/sbc/ops-plan`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (json) setOpsPlan(json);
  }

  async function updateTenantConfig(input: any) {
    if (!tenantId) return;
    const res = await fetch(`${apiBase}/admin/sbc/rollout/tenant/${tenantId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input)
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? "Tenant rollout settings updated." : String(out?.error || "Failed to update tenant rollout settings"));
    await loadTenantDetail(tenantId);
    await loadTenants();
  }

  async function runMediaTest() {
    if (!tenantId) return;
    const res = await fetch(`${apiBase}/admin/sbc/rollout/tenant/${tenantId}/media-test/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const out = await res.json().catch(() => ({}));
    setMsg(res.ok ? `Media test ${String(out?.status || "completed")}` : String(out?.error || "Failed to run media test"));
    await loadTenantDetail(tenantId);
    await loadTenants();
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r !== "SUPER_ADMIN") return;
    loadTenants().catch(() => undefined);
    loadReadiness().catch(() => undefined);
    loadOpsPlan().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (role !== "SUPER_ADMIN" || !tenantId) return;
    loadTenantDetail(tenantId).catch(() => undefined);
  }, [role, tenantId]);

  if (role !== "SUPER_ADMIN") {
    return <div className="card"><h1>SBC Rollout Wizard</h1><p>Insufficient permissions.</p></div>;
  }

  const t = detail?.tenant;
  const metrics = detail?.metrics24h;

  return (
    <div className="card">
      <h1>SBC Rollout Wizard</h1>
      <p>Safely roll out media policy per tenant with readiness checks and explicit verification steps.</p>
      <button onClick={() => { loadTenants().catch(() => undefined); loadReadiness().catch(() => undefined); loadOpsPlan().catch(() => undefined); }}>Refresh</button>
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}

      <h3>Select Tenant</h3>
      <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ minWidth: 360 }}>
        {tenants.map((row) => (
          <option key={row.id} value={row.id}>{row.name} ({row.id.slice(0, 10)})</option>
        ))}
      </select>

      {t ? (
        <>
          <h3>Current Tenant State</h3>
          <table>
            <tbody>
              <tr><td>Tenant</td><td>{t.name}</td></tr>
              <tr><td>Media Policy</td><td>{t.mediaPolicy}</td></tr>
              <tr><td>TURN Required for Mobile</td><td>{t.turnRequiredForMobile ? "yes" : "no"}</td></tr>
              <tr><td>Media Gate Enabled</td><td>{t.mediaReliabilityGateEnabled ? "yes" : "no"}</td></tr>
              <tr><td>Last Media Test</td><td>{t.mediaTestStatus} ({t.mediaTestedAt ? new Date(t.mediaTestedAt).toLocaleString() : "never"})</td></tr>
              <tr><td>Relay Rate (24h)</td><td>{metrics?.relayRate ?? 0}</td></tr>
              <tr><td>UDP Exposure Confirmed</td><td>{t.sbcUdpExposureConfirmed ? `yes (${t.sbcUdpExposureConfirmedAt ? new Date(t.sbcUdpExposureConfirmedAt).toLocaleString() : ""})` : "no"}</td></tr>
            </tbody>
          </table>

          <h3>Rollout Actions</h3>
          <div style={{ marginBottom: 8 }}>
            <label>Media Policy: </label>{" "}
            <select value={t.mediaPolicy || "TURN_ONLY"} onChange={(e) => updateTenantConfig({ mediaPolicy: e.target.value }).catch(() => undefined)}>
              <option value="TURN_ONLY">TURN_ONLY (safer default)</option>
              <option value="RTPENGINE_PREFERRED">RTPENGINE_PREFERRED</option>
            </select>
          </div>

          <label style={{ display: "block", marginBottom: 8 }}>
            <input type="checkbox" checked={!!t.mediaReliabilityGateEnabled} onChange={(e) => updateTenantConfig({ mediaReliabilityGateEnabled: e.target.checked }).catch(() => undefined)} />{" "}
            Enable Media Reliability Gate
          </label>

          <button onClick={() => runMediaTest().catch(() => undefined)}>Run Media Test</button>

          {t.mediaPolicy === "RTPENGINE_PREFERRED" ? (
            <>
              {!t.sbcUdpExposureConfirmed ? <p className="status-chip failed" style={{ borderRadius: 2 }}>RTP reliability may be degraded until UDP is opened; expect one-way audio on mobile.</p> : null}
              <h4>Ops Plan</h4>
              <p>Recommended UDP range: <strong>{opsPlan?.recommendation?.udpRange || "35000-35199/udp"}</strong></p>
              <pre style={{ whiteSpace: "pre-wrap", background: "#0f172a", color: "#e2e8f0", padding: 12, borderRadius: 6 }}>{opsPlan?.plan || "Ops plan unavailable"}</pre>
              <label style={{ display: "block", marginTop: 8 }}>
                <input type="checkbox" checked={!!t.sbcUdpExposureConfirmed} onChange={(e) => updateTenantConfig({ sbcUdpExposureConfirmed: e.target.checked }).catch(() => undefined)} />{" "}
                I have opened UDP 35000-35199 to the SBC
              </label>
            </>
          ) : (
            <p className="status-chip pending" style={{ borderRadius: 2 }}>TURN_ONLY is safer until UDP readiness is completed.</p>
          )}
        </>
      ) : null}

      <h3>Readiness Probes</h3>
      <table>
        <tbody>
          <tr><td>nginxSipProxy</td><td>{readiness?.probes?.nginxSipProxy || "UNKNOWN"}</td></tr>
          <tr><td>kamailioUp</td><td>{readiness?.probes?.kamailioUp || "UNKNOWN"}</td></tr>
          <tr><td>rtpengineUp</td><td>{readiness?.probes?.rtpengineUp || "UNKNOWN"}</td></tr>
          <tr><td>rtpengineControlReachableFromKamailio</td><td>{readiness?.probes?.rtpengineControlReachableFromKamailio || "UNKNOWN"}</td></tr>
          <tr><td>pbxReachableFromKamailio</td><td>{readiness?.probes?.pbxReachableFromKamailio || "UNKNOWN"}</td></tr>
        </tbody>
      </table>

      <h3>Verification Checklist (manual)</h3>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkWeb} onChange={(e) => setCheckWeb(e.target.checked)} /> Web softphone registers</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkMobile} onChange={(e) => setCheckMobile(e.target.checked)} /> Mobile registers</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkOutboundAudio} onChange={(e) => setCheckOutboundAudio(e.target.checked)} /> Outbound call audio both ways</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkInboundAudio} onChange={(e) => setCheckInboundAudio(e.target.checked)} /> Inbound call audio both ways</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkDtmf} onChange={(e) => setCheckDtmf(e.target.checked)} /> DTMF works</label>
      <label style={{ display: "block" }}><input type="checkbox" checked={checkEndSync} onChange={(e) => setCheckEndSync(e.target.checked)} /> Call end sync works</label>
    </div>
  );
}