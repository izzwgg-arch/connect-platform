 "use client";

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
import { dashboardMetrics } from "../../../services/mockData";
import { loadDashboardData } from "../../../services/platformData";

export default function DashboardPage() {
  const { adminScope } = useAppContext();
  const isGlobal = adminScope === "GLOBAL";
  const state = useAsyncResource(() => loadDashboardData(adminScope), [adminScope]);
  const telephonyState = useAsyncResource(
    () => (adminScope === "TENANT" ? getTenantTelephonyState("current") : Promise.resolve(null)),
    [adminScope]
  );

  const fallbackData = {
    scopeLabel: adminScope as "GLOBAL" | "TENANT",
    metrics: dashboardMetrics,
    activity: [{ type: "DASHBOARD", label: "Loading live metrics. Fallback snapshot shown." }]
  };

  const data = state.status === "success" ? state.data : fallbackData;
  const metrics = data.metrics;
  const activity = data.activity;

  return (
    <PermissionGate permission="can_view_dashboard" fallback={<div className="state-box">You do not have dashboard access.</div>}>
      <div className="stack">
      <PageHeader
        title="Operations Dashboard"
        subtitle={`Telecom-native command center for calls, messaging, users, and health (${data.scopeLabel.toLowerCase()} scope).`}
        badges={<ScopeBadge scope={data.scopeLabel} />}
        actions={<QRPairingModal />}
      />
      {state.status === "loading" ? <LoadingSkeleton rows={2} /> : null}
      {state.status === "error" ? <ErrorState message={`Live metrics unavailable: ${state.error}`} /> : null}
      {isGlobal ? <GlobalScopeNotice /> : null}

      <section className="metric-grid">
        {metrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} meta={metric.delta} />
        ))}
      </section>

      <section className="grid two">
        <DetailCard title="My Status">
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
        <DetailCard title="Today Activity">
          <ul className="list">
            <li>Answered calls: 33</li>
            <li>Missed calls: 7</li>
            <li>Voicemails: 4 unread</li>
            <li>SMS messages: 22 unread</li>
            <li>Chats: 9 unread</li>
          </ul>
        </DetailCard>
      </section>

      <section className="grid two">
        <DetailCard title="Live Tenant Overview">
          <ul className="list">
            <li>Queues with callers waiting: 2</li>
            <li>Ring group coverage alerts: 1</li>
            <li>Agents on active calls: 12</li>
            <li>Failed registrations in last 15m: 3</li>
          </ul>
        </DetailCard>
        <DetailCard title="Quick Actions">
          <div className="row-actions">
            <ScopedActionButton className="btn">Manage BLFs</ScopedActionButton>
            <ScopedActionButton className="btn">Record Greeting</ScopedActionButton>
            <ScopedActionButton className="btn" allowInGlobal>Open Contacts</ScopedActionButton>
            <ScopedActionButton className="btn ghost">Create Extension</ScopedActionButton>
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
              <li>Users online: 42</li>
              <li>Registration health: 94%</li>
              <li>Provisioning jobs pending: 3</li>
            </ul>
          </DetailCard>
          <DetailCard title="Super Admin Snapshot">
            <ul className="list">
              <li>Tenant count: 38</li>
              <li>Suspended tenants: 2</li>
              <li>Global integration incidents: 1</li>
            </ul>
          </DetailCard>
        </section>
      </RoleGate>
      </div>
    </PermissionGate>
  );
}
