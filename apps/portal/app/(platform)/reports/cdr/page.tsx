import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function ReportsCdrPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="CDR Reports" subtitle="Call detail records and disposition analytics." />
      <DetailCard title="CDR Workspace">
        <p className="muted">Use the PBX call reports surface for filtered CDR views and summary metrics.</p>
        <div className="row-actions">
          <Link className="btn" href="/pbx/call-reports">Open CDR Table</Link>
        </div>
      </DetailCard>
    </div>
  );
}
