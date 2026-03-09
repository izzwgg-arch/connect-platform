 "use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "../../../services/apiClient";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { GlobalScopeNotice } from "../../../components/GlobalScopeNotice";
import { LiveCallBadge } from "../../../components/LiveCallBadge";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { MetricCard } from "../../../components/MetricCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { PresenceBadge } from "../../../components/PresenceBadge";
import { QRPairingModal } from "../../../components/QRPairingModal";
import { RegistrationBadge } from "../../../components/RegistrationBadge";
import { RoleGate } from "../../../components/RoleGate";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { getTenantTelephonyState } from "../../../services/asteriskService";
import { loadDashboardData } from "../../../services/platformData";

type PbxDashboardKpi = {
  extensions: number | null;
  trunks: number | null;
  queues: number | null;
  ivr: number | null;
  conferences: number | null;
  parkingLots: number | null;
  activeCalls: number | null;
};

type NormalizedCall = {
  startedAt: Date;
  direction: "incoming" | "outgoing" | "internal";
};

export default function DashboardPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadDashboardData(adminScope), [adminScope]);
  const telephonyState = useAsyncResource(
    () => (adminScope === "TENANT" ? getTenantTelephonyState("current") : Promise.resolve(null)),
    [adminScope]
  );
  const pbxKpis = useAsyncResource<PbxDashboardKpi>(
    async () => {
      if (adminScope === "GLOBAL") {
        return { activeCalls: null, extensions: null, trunks: null, queues: null, ivr: null, conferences: null, parkingLots: null };
      }
      const safeCount = async (resource: string): Promise<number | null> => {
        try {
          const res = await apiGet<{ rows?: unknown[] }>(`/voice/pbx/resources/${resource}`);
          return Array.isArray(res?.rows) ? res.rows.length : 0;
        } catch {
          return null;
        }
      };
      const [calls, extensions, trunks, queues, ivr, conferences, parkingLots] = await Promise.all([
        apiGet<any>("/voice/pbx/call-reports").catch(() => null),
        safeCount("extensions"),
        safeCount("trunks"),
        safeCount("queues"),
        safeCount("ivr"),
        safeCount("conferences"),
        safeCount("parking-lots")
      ]);
      const reportRows = Array.isArray(calls?.report?.items) ? calls.report.items : Array.isArray(calls?.report) ? calls.report : [];
      return {
        activeCalls: reportRows.slice(0, 20).filter((row: any) => String(row?.disposition || "").toLowerCase() === "answered").length,
        extensions,
        trunks,
        queues,
        ivr,
        conferences,
        parkingLots
      };
    },
    [adminScope]
  );

  const data = state.status === "success" ? state.data : null;
  const metrics = data?.metrics || [];
  const activity = data?.activity || [];
  const scopeLabel = data?.scopeLabel || (adminScope as "GLOBAL" | "TENANT");
  const metricMap = useMemo(() => {
    const out = new Map<string, string>();
    for (const item of metrics) out.set(item.label, item.value);
    return out;
  }, [metrics]);
  const topTiles = [
    { label: "PJSIP Contacts", value: metricMap.get("Calls Today") || "--", meta: "Live call signals" },
    { label: "SIP Devices", value: metricMap.get("Registered Extensions") || "--", meta: "Registered endpoints" },
    { label: "IAX Devices", value: metricMap.get("Trunks Online") || "--", meta: "Online trunk paths" }
  ];
  const [liveTick, setLiveTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setLiveTick((v) => v + 1), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const liveCallsState = useAsyncResource<{ rows: NormalizedCall[]; activeNow: number }>(
    async () => {
      const parseDirection = (row: any): "incoming" | "outgoing" | "internal" => {
        const raw = String(row?.direction || row?.callDirection || row?.type || "").toLowerCase();
        if (raw.includes("in")) return "incoming";
        if (raw.includes("out")) return "outgoing";
        if (raw.includes("internal")) return "internal";
        return "outgoing";
      };

      if (adminScope === "GLOBAL") {
        const instances = await apiGet<any[]>("/admin/pbx/instances").catch(() => []);
        const enabled = (Array.isArray(instances) ? instances : []).filter((i) => i?.isEnabled).map((i) => String(i.id));
        const pick = enabled.length > 0 ? enabled.slice(0, 3) : (Array.isArray(instances) ? instances.slice(0, 1).map((i) => String(i.id)) : []);
        const allRows: NormalizedCall[] = [];
        for (const instanceId of pick) {
          const res = await apiGet<{ rows?: any[] }>(`/admin/pbx/resources/cdr?instanceId=${encodeURIComponent(instanceId)}`).catch(() => null);
          const rows = Array.isArray(res?.rows) ? res.rows : [];
          for (const row of rows.slice(0, 300)) {
            const tsRaw = row?.startedAt || row?.createdAt || row?.date || row?.timestamp;
            const ts = tsRaw ? new Date(String(tsRaw)) : new Date();
            if (!Number.isFinite(ts.getTime())) continue;
            allRows.push({ startedAt: ts, direction: parseDirection(row) });
          }
        }
        const cutoff = Date.now() - 5 * 60 * 1000;
        const activeNow = allRows.filter((row) => row.startedAt.getTime() >= cutoff).length;
        return { rows: allRows, activeNow };
      }

      const liveRows = await apiGet<any[]>("/voice/calls").catch(() => []);
      const report = await apiGet<any>("/voice/pbx/call-reports").catch(() => null);
      const normalized: NormalizedCall[] = [];
      if (Array.isArray(liveRows) && liveRows.length > 0) {
        for (const row of liveRows) {
          normalized.push({ startedAt: new Date(), direction: parseDirection(row) });
        }
        return { rows: normalized, activeNow: liveRows.length };
      }

      const reportRows = Array.isArray(report?.report?.items) ? report.report.items : Array.isArray(report?.report) ? report.report : [];
      for (const row of reportRows.slice(0, 300)) {
        const tsRaw = row?.startedAt || row?.createdAt || row?.date || row?.timestamp;
        const ts = tsRaw ? new Date(String(tsRaw)) : new Date();
        if (!Number.isFinite(ts.getTime())) continue;
        normalized.push({ startedAt: ts, direction: parseDirection(row) });
      }
      const cutoff = Date.now() - 5 * 60 * 1000;
      const activeNow = normalized.filter((row) => row.startedAt.getTime() >= cutoff).length;
      return { rows: normalized, activeNow };
    },
    [adminScope, liveTick]
  );

  const liveTraffic = useMemo(() => {
    const rows = liveCallsState.status === "success" ? liveCallsState.data.rows : [];
    const now = new Date();
    const buckets: Array<{ label: string; incoming: number; outgoing: number; internal: number }> = [];
    for (let i = 11; i >= 0; i -= 1) {
      const bucketTs = new Date(now.getTime() - i * 5 * 60 * 1000);
      const label = `${String(bucketTs.getHours()).padStart(2, "0")}:${String(bucketTs.getMinutes()).padStart(2, "0")}`;
      buckets.push({ label, incoming: 0, outgoing: 0, internal: 0 });
    }
    for (const row of rows) {
      const diff = now.getTime() - row.startedAt.getTime();
      if (diff < 0 || diff > 60 * 60 * 1000) continue;
      const idxFromEnd = Math.floor(diff / (5 * 60 * 1000));
      const idx = buckets.length - 1 - idxFromEnd;
      if (idx < 0 || idx >= buckets.length) continue;
      buckets[idx][row.direction] += 1;
    }
    const incoming = rows.filter((row) => row.direction === "incoming").length;
    const outgoing = rows.filter((row) => row.direction === "outgoing").length;
    const internal = rows.filter((row) => row.direction === "internal").length;
    const made = outgoing + internal;
    const peak = Math.max(1, ...buckets.map((b) => Math.max(b.incoming, b.outgoing, b.internal)));
    return { buckets, incoming, outgoing, internal, made, peak, activeNow: liveCallsState.status === "success" ? liveCallsState.data.activeNow : 0 };
  }, [liveCallsState]);
  const sideCards = [
    { label: "Active Calls", value: liveCallsState.status === "success" ? liveTraffic.activeNow : pbxKpis.status === "success" ? pbxKpis.data.activeCalls : null },
    { label: "Extensions", value: pbxKpis.status === "success" ? pbxKpis.data.extensions : null },
    { label: "Trunks", value: pbxKpis.status === "success" ? pbxKpis.data.trunks : null },
    { label: "Queues", value: pbxKpis.status === "success" ? pbxKpis.data.queues : null },
    { label: "IVRs", value: pbxKpis.status === "success" ? pbxKpis.data.ivr : null },
    { label: "Conferences", value: pbxKpis.status === "success" ? pbxKpis.data.conferences : null },
    { label: "Parking Lots", value: pbxKpis.status === "success" ? pbxKpis.data.parkingLots : null }
  ];

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="stack compact-stack">
        <PageHeader
          title="Operations Dashboard"
          subtitle={`Telecom-native command center for calls, messaging, users, and health (${scopeLabel.toLowerCase()} scope).`}
          badges={<ScopeBadge scope={scopeLabel} />}
          actions={<QRPairingModal />}
        />
        <div className="dashboard-tabs-row">
          <Link href="/pbx/ring-groups" className="dashboard-tab">Ring Groups</Link>
          <Link href="/pbx/ivr" className="dashboard-tab">IVR</Link>
          <Link href="/dashboard" className="dashboard-tab active">Dashboard</Link>
        </div>
        {state.status === "loading" ? <LoadingSkeleton rows={2} /> : null}
        {state.status === "error" ? <ErrorState message={`Live metrics unavailable: ${state.error}`} /> : null}
        {isGlobal ? <GlobalScopeNotice /> : null}

        <section className="dashboard-top-tiles">
          {topTiles.map((metric) => (
            <MetricCard key={metric.label} label={metric.label} value={metric.value} meta={metric.meta} />
          ))}
        </section>

        <section className="dashboard-main-grid">
          <DetailCard title="Calls Traffic Today">
            {liveCallsState.status === "error" ? (
              <ErrorState message={liveCallsState.error} />
            ) : liveTraffic.buckets.length === 0 ? (
              <EmptyState title="No live call traffic yet" message="Waiting for live call records from PBX." />
            ) : (
              <div className="live-traffic-graph">
                {liveTraffic.buckets.map((bucket) => (
                  <div key={bucket.label} className="live-traffic-col">
                    <div className="live-traffic-bars">
                      <span className="live-bar incoming" style={{ height: `${Math.max(2, (bucket.incoming / liveTraffic.peak) * 68)}px` }} />
                      <span className="live-bar outgoing" style={{ height: `${Math.max(2, (bucket.outgoing / liveTraffic.peak) * 68)}px` }} />
                      <span className="live-bar internal" style={{ height: `${Math.max(2, (bucket.internal / liveTraffic.peak) * 68)}px` }} />
                    </div>
                    <span className="live-traffic-time">{bucket.label}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="row-wrap">
              <span className="chip info">Made: {liveTraffic.made}</span>
              <span className="chip success">Incoming: {liveTraffic.incoming}</span>
              <span className="chip warning">Outgoing: {liveTraffic.outgoing}</span>
              <span className="chip">Internal: {liveTraffic.internal}</span>
              <span className="chip info">Updated: {liveCallsState.status === "success" ? "Live (15s)" : "--"}</span>
            </div>
          </DetailCard>

          <div className="dashboard-side-stack">
            {sideCards.map((item) => (
              <article key={item.label} className="dashboard-side-card">
                <div className="dashboard-side-title">{item.label}</div>
                <div className="dashboard-side-value">{item.value === null ? "N/A" : String(item.value)}</div>
              </article>
            ))}
          </div>
        </section>

        <section className="grid two">
          <DetailCard title="Operator Status">
            <div className="row-wrap">
              <RegistrationBadge registered={true} />
              <PresenceBadge presence="AVAILABLE" />
              <LiveCallBadge active={false} />
            </div>
            <div className="row-actions">
              <ScopedActionButton className="btn">DND Toggle</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Office Hours Override</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Call Forwarding</ScopedActionButton>
            </div>
          </DetailCard>
          <DetailCard title="Quick Actions">
            <div className="row-actions">
              <ScopedActionButton className="btn ghost">Create Extension</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Create Campaign</ScopedActionButton>
              <ScopedActionButton className="btn ghost" allowInGlobal>Create Invoice</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Add Customer</ScopedActionButton>
            </div>
          </DetailCard>
        </section>

        <DetailCard title="Asterisk Discovery-First State">
          {adminScope === "GLOBAL" ? (
            <div className="muted">Discovery checks are tenant-scoped. Switch to Tenant mode to inspect Asterisk object existence.</div>
          ) : telephonyState.status === "loading" ? (
            <div className="muted">Checking existing PBX objects...</div>
          ) : telephonyState.status === "error" ? (
            <div className="muted">Could not verify telephony state; using safe read-only mode.</div>
          ) : (
            <div className="row-wrap">
              {telephonyState.data?.discovered.map((item) => (
                <span key={item.kind} className={`chip ${item.exists ? "success" : "neutral"}`}>
                  {item.kind}: {item.exists ? "found" : "missing"}
                </span>
              ))}
            </div>
          )}
        </DetailCard>

        <DetailCard title="Recent Activity Feed">
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" message="As events flow from billing, messaging, and PBX, activity appears here." />
          ) : (
            <ul className="list">
              {activity.map((item, idx) => (
                <li key={`${item.type}-${idx}`}>
                  <strong>{item.type}</strong>: {item.label}
                </li>
              ))}
            </ul>
          )}
        </DetailCard>

        <RoleGate allow={["TENANT_ADMIN", "SUPER_ADMIN"]}>
          <section className="grid two">
            <DetailCard title="Tenant Admin Signals">
              <ul className="list">
                <li>Tenant scoped metrics are shown from live dashboard APIs.</li>
                <li>Use PBX section for call-routing and provisioning operations.</li>
                <li>Use Billing section for invoice and payment lifecycle controls.</li>
              </ul>
            </DetailCard>
            <DetailCard title="Super Admin Snapshot">
              <ul className="list">
                <li>Switch to Global mode from tenant switcher to audit all tenants.</li>
                <li>Use Admin section for PBX instances and tenant synchronization.</li>
                <li>Use Reports for CDR and platform health analysis.</li>
              </ul>
            </DetailCard>
          </section>
        </RoleGate>
      </div>
    </PermissionGate>
  );
}
