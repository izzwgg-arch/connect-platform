"use client";

import { AdminModuleCard } from "../../../components/AdminModuleCard";
import { ErrorState } from "../../../components/ErrorState";
import { IntegrationCard } from "../../../components/IntegrationCard";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { RoleGate } from "../../../components/RoleGate";
import { ScopeBadge } from "../../../components/ScopeBadge";
import { useAppContext } from "../../../hooks/useAppContext";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadAdminSignals } from "../../../services/platformData";
import Link from "next/link";

export default function AdminPage() {
  const { adminScope } = useAppContext();
  const signals = useAsyncResource(() => loadAdminSignals(adminScope), [adminScope]);

  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have admin access.</div>}>
      {signals.status === "loading" ? <LoadingSkeleton rows={4} /> : null}
      {signals.status === "error" ? <ErrorState message={signals.error} /> : null}
      <div className="stack">
        <PageHeader
          title="Admin Console"
          subtitle="Tenant and platform administration with role-gated controls."
          badges={<ScopeBadge scope={adminScope} />}
        />
        {signals.status === "success" ? (
          <div className="row-wrap">
            <span className="chip info">Scope: {adminScope}</span>
            <span className="chip info">PBX Instances: {signals.data.pbxInstanceCount}</span>
            <span className="chip warning">Degraded Instances: {signals.data.degraded}</span>
            {adminScope === "GLOBAL" ? <span className="chip info">Tenants: {signals.data.tenantCount}</span> : null}
            {adminScope === "GLOBAL" ? <span className="chip warning">SMS Failovers: {signals.data.failoversRecent}</span> : null}
          </div>
        ) : null}

        <section className="grid three">
          <AdminModuleCard title="Users & Extensions" summary="Manage users, extension assignment, role templates, and onboarding." href="/pbx/extensions" />
          <AdminModuleCard title="PBX Routing" summary="Ring groups, queues, IVRs, office hours, routes, and greetings." href="/pbx" />
          <AdminModuleCard title="Provisioning" summary="Devices, templates, BLF defaults, and policy enforcement." href="/admin/pbx" />
        </section>

        <section className="grid three">
          <AdminModuleCard title="Audit Logs" summary="Security and telecom operation logs with tenant context." href="/admin/pbx/events" />
          <AdminModuleCard title="Permissions" summary="Role-based feature access controls for all platform capabilities." href="/admin/permissions" />
          <AdminModuleCard title="Billing & Plan" summary="Tenant billing visibility, license controls, and plan modules." href="/admin/billing" />
        </section>

        <RoleGate allow={["SUPER_ADMIN"]}>
          <section className="grid three">
            <AdminModuleCard title="Global Tenant Management" summary="Create, suspend, and impersonate tenants with safe context switching." href="/admin/tenants" />
            <AdminModuleCard title="Global Policies" summary="Permission templates, security baselines, and default telephony policies." href="/admin/permissions" />
            <AdminModuleCard title="Platform Health" summary="Provider health, trunk registration, and incident boards." href="/admin/pbx" />
          </section>
        </RoleGate>

        <section className="grid three">
          <IntegrationCard name="VitalPBX Connection" status="Configured" configureHref="/admin/pbx" auditHref="/admin/pbx" />
          <IntegrationCard name="VoIPDNS / Provider Routing" status="Requires review" />
          <IntegrationCard name="QuickBooks & PaymentHub" status="Not connected" />
        </section>
        <section className="panel">
          <h3>Admin Shortcuts</h3>
          <div className="row-actions">
            <Link className="btn ghost" href="/admin/tenants">Tenants</Link>
            <Link className="btn ghost" href="/admin/pbx">PBX Instances</Link>
            <Link className="btn ghost" href="/admin/pbx/events">PBX Events</Link>
            <Link className="btn ghost" href="/admin/billing">Admin Billing</Link>
          </div>
        </section>
      </div>
    </PermissionGate>
  );
}
