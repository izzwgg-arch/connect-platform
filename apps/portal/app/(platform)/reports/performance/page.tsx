import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function ReportsPerformancePage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Agent / Extension Performance" subtitle="Operational view for extension-level handling and response metrics." />
      <DetailCard title="Performance Summary">
        <ul className="list">
          <li>Extension distribution and call handling trends are sourced from PBX CDR exports.</li>
          <li>Use extension and date filters in call reports for deep analysis.</li>
          <li>Queue and extension KPI overlays are available in dashboard activity widgets.</li>
        </ul>
      </DetailCard>
    </div>
  );
}
