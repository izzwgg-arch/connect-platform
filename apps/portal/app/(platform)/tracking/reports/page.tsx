"use client";

import { BarChart3 } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";

// Reporting & analytics is Phase 11. This page is an honest placeholder so the nav link
// resolves; it fabricates no metrics.
export default function TrackingReportsPage() {
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<BarChart3 size={20} />} title="Reports" subtitle="Delivery performance and operational analytics." />
      <CRMCard>
        <p className="text-sm text-crm-text">Reporting lands in a later phase.</p>
        <p className="mt-2 text-sm text-crm-muted">
          Delivery-success rate, first-attempt success, ETA accuracy, driver/store performance, and
          calls-avoided will draw from real delivery data — no fabricated figures. Operational counts
          are already visible on the <a href="/tracking/dashboard" className="text-crm-accent underline">Dashboard</a>.
        </p>
      </CRMCard>
    </CRMPageShell>
  );
}
