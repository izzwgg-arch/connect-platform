import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function BillingReceiptsPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Receipts" subtitle="Receipt delivery and post-payment email outcomes." />
      <DetailCard title="Receipt Tracking">
        <p className="muted">Receipt events are generated from successful payment flows and tracked through email jobs.</p>
      </DetailCard>
    </div>
  );
}
