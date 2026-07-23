"use client";

import { Route } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";

// The run board (create/assign/reorder/optimize) is built out in the next dispatcher
// increment. The API foundation (create run, add stop, start run) already exists.
export default function TrackingRunsPage() {
  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader icon={<Route size={20} />} title="Runs" subtitle="Build and monitor delivery runs." />
      <CRMCard>
        <p className="text-sm text-crm-text">The run board is the next dispatcher increment.</p>
        <p className="mt-2 text-sm text-crm-muted">
          Orders and their assignments are live now on the <a href="/tracking/orders" className="text-crm-accent underline">Orders</a> page.
          The run board (create · assign · reorder · optimize · start) builds on the existing run API
          (<span className="font-mono text-xs">create run · add stop · start run</span>).
        </p>
      </CRMCard>
    </CRMPageShell>
  );
}
