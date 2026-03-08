import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function BillingPaymentsPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Payments" subtitle="Payment attempts, outcomes, and reconciliation events." />
      <DetailCard title="Payment Operations">
        <p className="muted">Payment events and failure analytics are visible from billing summary and dashboard activity feeds.</p>
      </DetailCard>
    </div>
  );
}
