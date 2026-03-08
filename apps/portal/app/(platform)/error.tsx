"use client";

import { ErrorState } from "../../components/ErrorState";

export default function PlatformError() {
  return <ErrorState message="The workspace failed to render. Reload to recover." />;
}
