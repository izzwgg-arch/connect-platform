import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function AppsWhatsappPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="WhatsApp Inbox" subtitle="Thread-style messaging operations with provider status and reply workflows." />
      <DetailCard title="WhatsApp Operations">
        <p className="muted">Use the chat workspace to handle inbound and outbound communication streams.</p>
        <div className="row-actions">
          <Link className="btn" href="/chat">Open Messaging Workspace</Link>
        </div>
      </DetailCard>
    </div>
  );
}
