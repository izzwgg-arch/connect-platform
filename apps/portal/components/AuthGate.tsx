"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { readAuthToken } from "../services/session";
import { hasNavigatedToLogin, SESSION_EXPIRED_EVENT } from "../lib/sessionExpiry";
import {
  bootstrapVisualQaSession,
  clearStaleVisualQaSession,
  isVisualQaModeEnabled,
} from "../services/visualQaMode";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  // Bumped when the api refuses our token (see lib/sessionExpiry.ts). Re-runs
  // the gate below, which now finds no token: a full window is already being
  // sent to /login by the handler; a desktop passive window drops its content
  // and goes back to waiting for the main window's next sign-in.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionExpired, setSessionExpired] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onExpired = () => {
      setSessionExpired(true);
      // Drop the shell right away — every poller under this gate unmounts on
      // this render, before the handler's navigation has even landed.
      setReady(false);
      setSessionEpoch((n) => n + 1);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    if (isVisualQaModeEnabled()) {
      bootstrapVisualQaSession();
      setReady(true);
      return undefined;
    }

    if (clearStaleVisualQaSession()) {
      const next = encodeURIComponent(pathname || "/dashboard");
      router.replace(`/login?next=${next}`);
      return undefined;
    }

    const isDesktopPassiveWindow =
      typeof window !== "undefined" &&
      Boolean(window.connectDesktop?.isDesktop && window.connectDesktop.windowKind && window.connectDesktop.windowKind !== "full");

    const hasToken = () => Boolean(readAuthToken());
    if (hasToken()) {
      setSessionExpired(false);
      setReady(true);
      return undefined;
    }

    setReady(false);

    if (!isDesktopPassiveWindow) {
      // The dead-session handler in lib/sessionExpiry.ts already started a hard
      // navigation to /login for this window; a second, client-side one here
      // would only race it.
      if (hasNavigatedToLogin()) return undefined;
      // Keep the query string: "?firstrun=1" on IVR Studio is what opens the
      // new-customer walkthrough — dropping it sent every fresh sign-up to the
      // bare Studio with no guidance after their first login.
      const search = typeof window !== "undefined" ? window.location.search : "";
      const next = encodeURIComponent(`${pathname || "/dashboard"}${search || ""}`);
      router.replace(`/login?next=${next}`);
      return undefined;
    }

    // Desktop mini/phone-engine windows should wait for token instead of
    // redirecting to /login, otherwise hidden windows can get stuck there.
    // The same wait covers an EXPIRED session: the main window's next sign-in
    // writes a fresh token, the `storage` event crosses windows, and this
    // window comes back on its own.
    const onStorage = () => {
      if (hasToken()) {
        setSessionExpired(false);
        setReady(true);
      }
    };
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(() => {
      if (hasToken()) {
        setSessionExpired(false);
        setReady(true);
        window.clearInterval(timer);
      }
    }, 1000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("storage", onStorage);
    };
  }, [pathname, router, sessionEpoch]);

  if (!ready) {
    const passiveWindow =
      typeof window !== "undefined" &&
      Boolean(window.connectDesktop?.isDesktop && window.connectDesktop.windowKind && window.connectDesktop.windowKind !== "full");
    return (
      <div className="stack">
        <div className="panel">
          <h3>{sessionExpired ? "Signed out" : "Checking session..."}</h3>
          <p className="muted">
            {sessionExpired
              ? passiveWindow
                ? "Your session has ended. Sign in again from the main Connect window and this will reconnect on its own."
                : "Your session has ended. Taking you to the sign-in page…"
              : "Validating authentication before loading workspace."}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
