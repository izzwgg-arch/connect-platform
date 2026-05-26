"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { readAuthToken } from "../services/session";
import { bootstrapVisualQaSession, isVisualQaModeEnabled } from "../services/visualQaMode";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (isVisualQaModeEnabled()) {
      bootstrapVisualQaSession();
      setReady(true);
      return undefined;
    }

    const isDesktopPassiveWindow =
      typeof window !== "undefined" &&
      Boolean(window.connectDesktop?.isDesktop && window.connectDesktop.windowKind && window.connectDesktop.windowKind !== "full");

    const hasToken = () => Boolean(readAuthToken());
    if (hasToken()) {
      setReady(true);
      return undefined;
    }

    setReady(false);

    if (!isDesktopPassiveWindow) {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/login?next=${next}`);
      return undefined;
    }

    // Desktop mini/phone-engine windows should wait for token instead of
    // redirecting to /login, otherwise hidden windows can get stuck there.
    const onStorage = () => {
      if (hasToken()) setReady(true);
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(() => {
      if (hasToken()) {
        setReady(true);
        window.clearInterval(timer);
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
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
