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
  const topMetrics = [
    { label: "Active Calls", value: "18", meta: "4 queues engaged" },
    { label: "Calls Today", value: "412", meta: "+7% vs yesterday" },
    { label: "Missed Calls", value: "23", meta: "Needs follow-up" },
    { label: "SMS Sent", value: "1,284", meta: "97.8% delivered" },
    { label: "WhatsApp", value: "342", meta: "28 unread inbound" },
    { label: "Unpaid Invoices", value: "19", meta: "$14,220 open" },
    { label: "Collections", value: "$28.4k", meta: "Last 30 days" }
  ];

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
        {topMetrics.map((metric) => (
          <MetricCard key={metric.label} label={metric.label} value={metric.value} meta={metric.meta} />
        ))}
      </section>

      <section className="grid three">
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
        <DetailCard title="System Health">
          <ul className="list">
            <li>PBX Connectivity: Healthy</li>
            <li>SBC Readiness: Stable</li>
            <li>Messaging Providers: 1 degraded</li>
            <li>Email Queue: 3 delayed jobs</li>
            <li>Webhook Sync: Last seen 18s ago</li>
          </ul>
        </DetailCard>
        <DetailCard title="Attention Needed">
          <ul className="list">
            <li>4 overdue invoices older than 14 days</li>
            <li>2 failed campaign sends pending review</li>
            <li>3 payment declines need follow-up</li>
            <li>5 inbound WhatsApp messages unassigned</li>
            <li>1 tenant warning for SMS daily cap</li>
          </ul>
        </DetailCard>
      </section>

      <section className="grid two">
        <DetailCard title="Quick Actions">
          <div className="row-actions">
            <ScopedActionButton className="btn ghost">Create Extension</ScopedActionButton>
            <ScopedActionButton className="btn ghost">Create Campaign</ScopedActionButton>
            <ScopedActionButton className="btn ghost" allowInGlobal>Create Invoice</ScopedActionButton>
            <ScopedActionButton className="btn ghost">Add Customer</ScopedActionButton>
          </div>
        </DetailCard>
        <DetailCard title="Live Tenant Overview">
          <ul className="list">
            <li>Queues with callers waiting: 2</li>
            <li>Ring group coverage alerts: 1</li>
            <li>Agents on active calls: 12</li>
            <li>Failed registrations in last 15m: 3</li>
          </ul>
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

      <section className="grid two">
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
        <DetailCard title="Queue and Campaign Snapshot">
          <ul className="list">
            <li>Support queue ASA: 00:42</li>
            <li>Sales queue abandon rate: 3.1%</li>
            <li>Campaigns sent today: 7</li>
            <li>Campaign delivery failures: 13</li>
            <li>Pending reminders: 9 invoices</li>
          </ul>
        </DetailCard>
      </section>

      <DetailCard title="Platform Metrics Feed">
        {activity.length === 0 ? (
          <EmptyState title="No telemetry yet" message="Metric snapshots appear here once collectors complete." />
        ) : (
          <ul className="list">
            {metrics.map((item, idx) => (
              <li key={`${item.label}-${idx}`}>
                <strong>{item.label}</strong>: {item.value} ({item.delta})
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
