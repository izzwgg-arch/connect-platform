import Link from "next/link";
import { DetailCard } from "../../../../../components/DetailCard";
import { PageHeader } from "../../../../../components/PageHeader";

export default function VoiceCallsRoutePage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Voice Calls" subtitle="Voice route alias for the main calls console." />
      <DetailCard title="Open Calls Console">
        <p className="muted">Use the unified calls console for live sessions and historical CDR records.</p>
        <div className="row-actions">
          <Link className="btn" href="/calls">Open Calls Console</Link>
        </div>
      </DetailCard>
    </div>
  );
}
