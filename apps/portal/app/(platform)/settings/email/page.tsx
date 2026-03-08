import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsEmailPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Email Settings" subtitle="Configure tenant email providers, test flows, and operational notification behavior." />
      <DetailCard title="Email Provider">
        <p className="muted">Email provider configuration and queue behavior are managed through tenant settings APIs.</p>
      </DetailCard>
    </div>
  );
}
