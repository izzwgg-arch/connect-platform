import Link from "next/link";
import { DetailCard } from "../../../../components/DetailCard";
import { PageHeader } from "../../../../components/PageHeader";

export default function SettingsWebrtcPage() {
  return (
    <div className="stack compact-stack">
      <PageHeader title="WebRTC / Media Policy" subtitle="Media transport policy, registration checks, and client diagnostic guidance." />
      <DetailCard title="WebRTC Policy Controls">
        <div className="row-actions">
          <Link className="btn ghost" href="/pbx/softphone">Softphone</Link>
          <Link className="btn ghost" href="/pbx/sbc-connectivity">SBC Diagnostics</Link>
        </div>
      </DetailCard>
    </div>
  );
}
