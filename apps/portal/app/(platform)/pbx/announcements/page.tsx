"use client";

import { PbxResourcePage } from "../../../../components/PbxResourcePage";

export default function PbxAnnouncementsPage() {
  return (
    <PbxResourcePage
      title="Announcements"
      subtitle="Manage PBX announcement and voicemail resources used by IVR and call flows."
      resource="voicemail"
      permission="can_view_recordings"
    />
  );
}
