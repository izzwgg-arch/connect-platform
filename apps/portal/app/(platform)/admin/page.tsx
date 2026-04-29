"use client";

import { AdminModuleCard } from "../../../components/AdminModuleCard";
import { IntegrationCard } from "../../../components/IntegrationCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { RoleGate } from "../../../components/RoleGate";

export default function AdminPage() {
  return (
    <PermissionGate permission="can_view_admin" fallback={<div className="state-box">You do not have admin access.</div>}>
      <div className="stack">
        <PageHeader
          title="Admin Console"
          subtitle="Tenant and platform administration with role-gated controls."
        />

        <section className="grid three">
          <AdminModuleCard title="Users" summary="Create users, assign tenant extensions, send invites, and manage access." href="/admin/users" />
          <AdminModuleCard title="Extensions" summary="Manage PBX extensions, SIP credentials, and softphone assignment." href="/pbx/extensions" />
          <AdminModuleCard title="Audit Logs" summary="Security and telecom operation logs with tenant context." href="/admin/pbx/events" />
          <AdminModuleCard title="Permissions" summary="Role-based feature access controls for all platform capabilities." href="/admin/permissions" />
          <IntegrationCard name="VitalPBX Connection" status="Configured" configureHref="/admin/pbx" auditHref="/admin/pbx" />
        </section>

        <RoleGate allow={["SUPER_ADMIN"]}>
          <section className="grid three">
            <AdminModuleCard title="Deploy Center" summary="Enqueue, monitor, and manage production deployments through the safe deploy queue. View logs and cancel jobs." href="/admin/deploy-center" />
            <AdminModuleCard title="Global Tenant Management" summary="Create, suspend, and impersonate tenants with safe context switching." href="/admin/tenants" />
            <AdminModuleCard
              title="Call Flight Recorder"
              summary="Full structured event timeline for every mobile call. Search by invite, PBX ID, phone, or extension. AI-powered diagnosis per call."
              href="/admin/call-flight"
            />
            <AdminModuleCard
              title="Call Timeline (WebRTC)"
              summary="Session-level WebRTC diagnostics, ICE/TURN analysis, and AI explanation for voice quality issues."
              href="/admin/call-timeline"
            />
            <AdminModuleCard
              title="Audio Intelligence"
              summary="Media test results, TURN relay verification, and real-time quality scoring."
              href="/admin/audio-intelligence"
            />
          </section>
        </RoleGate>
      </div>
    </PermissionGate>
  );
}
