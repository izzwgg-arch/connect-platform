import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsBillingPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Billing Settings" subtitle="Tenant SOLA/Cardknox credentials, policy toggles, and billing control options." />
      <DetailCard title="Billing Provider">
        <div className="row-actions">
          <Link className="btn" href="/billing">Open Billing Workspace</Link>
        </div>
      </DetailCard>
    </div>
  );
}
