import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { QRPairingModal } from "../../../components/QRPairingModal";
import { ScopedActionButton } from "../../../components/ScopedActionButton";
import { SettingsNav } from "../../../components/SettingsNav";
import { SettingsSectionCard } from "../../../components/SettingsSectionCard";

export default function SettingsPage() {
  return (
    <PermissionGate permission="can_view_settings" fallback={<div className="state-box">You do not have settings access.</div>}>
      <div className="stack">
      <PageHeader title="Settings" subtitle="User and tenant preferences for telephony operations and app behavior." actions={<QRPairingModal />} />
      <section className="settings-layout">
        <SettingsNav />
        <div className="stack">
          <SettingsSectionCard title="Presence & Status">
            <div className="row-actions">
              <ScopedActionButton className="btn">Set DND</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Office Hours Override</ScopedActionButton>
            </div>
          </SettingsSectionCard>
          <SettingsSectionCard title="Call Forwarding">
            <p className="muted">Forwarding rules by schedule, status, and failover destination.</p>
            <ScopedActionButton className="btn">Manage Forwarding</ScopedActionButton>
          </SettingsSectionCard>
          <SettingsSectionCard title="Greetings / Voicemail / BLFs / Devices">
            <div className="row-actions">
              <ScopedActionButton className="btn ghost">Greetings</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Voicemail</ScopedActionButton>
              <ScopedActionButton className="btn ghost">BLFs</ScopedActionButton>
              <ScopedActionButton className="btn ghost">Audio / Video</ScopedActionButton>
            </div>
          </SettingsSectionCard>
        </div>
      </section>
      </div>
    </PermissionGate>
  );
}
