"use client";

import { PageHeader } from "../../../../components/PageHeader";
import { LiveBadge } from "../../../../components/LiveBadge";
import { PresenceGrid } from "../../../../components/PresenceGrid";
import { useTelephony } from "../../../../contexts/TelephonyContext";

export default function PresenceDashboardPage() {
  const telephony = useTelephony();

  return (
    <div className="stack compact-stack">
      <PageHeader
        title="Extension Presence"
        subtitle="Live view of all extension states. Green = available, blinking red = ringing, solid red = on call, grey = offline."
        actions={<LiveBadge status={telephony.status} />}
      />

      <PresenceGrid showOffline={true} />
    </div>
  );
}
