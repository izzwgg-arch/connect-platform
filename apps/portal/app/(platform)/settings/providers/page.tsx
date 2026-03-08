import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsProvidersPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Provider Settings" subtitle="Configure PBX, messaging, and third-party provider connectivity." />
      <DetailCard title="Provider Integrations">
        <div className="row-actions">
          <Link className="btn" href="/admin/pbx">VitalPBX Connection</Link>
          <Link className="btn ghost" href="/admin">Admin Integrations</Link>
        </div>
      </DetailCard>
    </div>
  );
}
