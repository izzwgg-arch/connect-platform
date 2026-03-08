import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function AppsSmsCampaignsPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="SMS Campaigns" subtitle="Campaign workflow entrypoint for draft, preview, send, and status tracking." />
      <DetailCard title="Campaign Manager">
        <p className="muted">Use the SMS operations console for live campaign management and guardrail-aware sends.</p>
        <div className="row-actions">
          <Link className="btn" href="/sms">Open SMS Console</Link>
        </div>
      </DetailCard>
    </div>
  );
}
