import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function AppsCustomersPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Customer Hub" subtitle="CRM workflow center for customer records, billing context, and communication history." />
      <DetailCard title="Customer Operations">
        <div className="row-actions">
          <Link className="btn" href="/contacts">Open Customer Directory</Link>
        </div>
      </DetailCard>
    </div>
  );
}
