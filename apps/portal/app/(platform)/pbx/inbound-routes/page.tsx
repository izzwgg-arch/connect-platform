"use client";

import { PbxResourcePage } from "../../../../components/PbxResourcePage";

export default function PbxInboundRoutesPage() {
  return (
    <PbxResourcePage
      title="Inbound Routes"
      subtitle="Map DIDs and source patterns to PBX destinations."
      resource="routes"
    />
  );
}
