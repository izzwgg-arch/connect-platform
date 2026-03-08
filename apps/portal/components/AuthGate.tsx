"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { readAuthToken } from "../services/session";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = readAuthToken();
    if (!token) {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/login?next=${next}`);
      return;
    }
    setReady(true);
  }, [pathname, router]);

  if (!ready) {
    return (
      <div className="stack">
        <div className="panel">
          <h3>Checking session...</h3>
          <p className="muted">Validating authentication before loading workspace.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
