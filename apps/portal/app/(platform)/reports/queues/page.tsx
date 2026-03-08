import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function ReportsQueuesPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Queue Reports" subtitle="Queue-level visibility for volume, handling, and response quality." />
      <DetailCard title="Queue Analytics">
        <ul className="list">
          <li>Queue performance uses PBX CDR and queue resource data.</li>
          <li>Filter by queue ID and date range from call report surfaces.</li>
          <li>Use this page as the queue reporting launch point.</li>
        </ul>
      </DetailCard>
    </div>
  );
}
