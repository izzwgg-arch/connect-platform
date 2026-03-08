"use client";

import { PbxResourcePage } from "../../../../components/PbxResourcePage";

export default function PbxExtensionsPage() {
  return (
    <PbxResourcePage
      title="Extensions"
      subtitle="Manage extension inventory, assignment, and registration-facing fields via VitalPBX."
      resource="extensions"
      permission="can_view_team"
    />
  );
}
