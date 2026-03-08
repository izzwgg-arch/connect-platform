import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsVoicePage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Voice Settings" subtitle="Tenant voice preferences, call behavior defaults, and office-hour policy controls." />
      <DetailCard title="Voice Policy">
        <div className="row-actions">
          <Link className="btn" href="/dashboard/voice/settings">Open Voice Policy Console</Link>
          <Link className="btn ghost" href="/pbx/time-conditions">Time Conditions</Link>
        </div>
      </DetailCard>
    </div>
  );
}
