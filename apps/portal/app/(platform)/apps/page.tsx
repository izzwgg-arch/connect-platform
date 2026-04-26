import { AppDownloadCard } from "../../../components/AppDownloadCard";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { QRPairingModal } from "../../../components/QRPairingModal";
import Link from "next/link";

export default function AppsPage() {
  return (
    <PermissionGate permission="can_view_apps" fallback={<div className="state-box">You do not have apps access.</div>}>
      <div className="stack">
      <PageHeader title="Apps & Pairing" subtitle="Distribute mobile apps and pair extension access via QR." actions={<QRPairingModal />} />
      <section className="grid two">
        <AppDownloadCard title="ConnectComms Mobile" description="Android APK and iOS App Store access for extension login and on-the-go calling." />
        <AppDownloadCard title="ConnectComms Desktop" description="Desktop softphone rollout channel for Windows and macOS users." />
      </section>
      <section className="panel">
        <h3>Operations Apps</h3>
        <div className="row-actions">
          <Link className="btn ghost" href="/apps/sms-campaigns">SMS Campaigns</Link>
          <Link className="btn ghost" href="/apps/whatsapp">WhatsApp Inbox</Link>
          <Link className="btn ghost" href="/apps/voip-ms">VoIP.ms</Link>
          <Link className="btn ghost" href="/apps/customers">Customer Hub</Link>
        </div>
      </section>
      <section className="panel">
        <h3>Pairing Instructions</h3>
        <ol className="list">
          <li>Open mobile app and tap Pair Device.</li>
          <li>Scan QR from this page or Settings.</li>
          <li>Confirm extension and status profile.</li>
          <li>Run audio and push notification test.</li>
        </ol>
      </section>
      </div>
    </PermissionGate>
  );
}
