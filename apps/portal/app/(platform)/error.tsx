"use client";

import { useEffect } from "react";
import { ErrorState } from "../../components/ErrorState";

export default function PlatformError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    try {
      console.error("platform-route-error:", error);
    } catch {}
  }, [error]);
  return <ErrorState message="The workspace failed to render. Reload to recover." />;
}
