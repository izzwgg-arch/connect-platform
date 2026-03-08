import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsMessagingPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="Messaging Settings" subtitle="SMS and WhatsApp provider controls and tenant routing behavior." />
      <DetailCard title="Messaging Provider Controls">
        <div className="row-actions">
          <Link className="btn ghost" href="/apps/sms-campaigns">SMS Campaigns</Link>
          <Link className="btn ghost" href="/apps/whatsapp">WhatsApp Inbox</Link>
        </div>
      </DetailCard>
    </div>
  );
}
