"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { applySession, useAuth } from "@/lib/auth";
import { Button, Icon } from "@/components/ui";

const PORTAL = (process.env.NEXT_PUBLIC_LOOPCOM_PORTAL_URL || "https://app.loopcom.net").replace(/\/$/, "");

/**
 * Loopcom SSO landing. Two ways in:
 *  1. The Loopcom portal/app opens /sso/loopcom?token=<its own JWT>&next=/…
 *  2. A person clicks "Sign in with Loopcom" here → we send them to the portal,
 *     which comes back with the token.
 * The api verifies the token against Loopcom; nothing is trusted client-side.
 */
function Inner() {
  const params = useSearchParams();
  const router = useRouter();
  const { reload } = useAuth();
  const token = params.get("token");
  const next = params.get("next") || "/";
  const [state, setState] = useState<"idle" | "busy" | "error">(token ? "busy" : "idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const body = await api("/auth/loopcom", { body: { token }, auth: false });
        applySession(body);
        const m = await reload();
        router.replace(body.created || (m && !m.person.onboardingDone) ? "/welcome" : next);
      } catch (err) {
        setError((err as Error).message);
        setState("error");
      }
    })();
  }, [token, next, reload, router]);

  const goToPortal = () => {
    const back = `${window.location.origin}/sso/loopcom?next=${encodeURIComponent(next)}`;
    window.location.href = `${PORTAL}/login?community=1&redirect=${encodeURIComponent(back)}`;
  };

  return (
    <div className="auth">
      <div className="authcard">
        <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        <div style={{ textAlign: "center" }}>
          <h1 style={{ fontSize: 18 }}>Sign in with Loopcom</h1>
          <p className="dim sm">Loopcom phone-system customers use their existing Loopcom sign-in. No second password.</p>
        </div>
        {state === "busy" ? <p className="row" style={{ justifyContent: "center" }}><Icon name="refresh" /> Checking with Loopcom…</p> : null}
        {state === "error" ? <div className="chip bad" role="alert" style={{ whiteSpace: "normal" }}>{error}</div> : null}
        {state !== "busy" ? (
          <Button kind="p" wide icon="link" onClick={goToPortal} data-testid="sso-go">
            Continue to Loopcom
          </Button>
        ) : null}
        <p className="xs dim" style={{ textAlign: "center" }}>
          Already inside the Loopcom app? Open Community from its sidebar and you'll land here signed in.
        </p>
        <p className="sm dim" style={{ textAlign: "center" }}>
          Not a Loopcom customer? <Link href="/join">Create a free Loopcom ID</Link>.
        </p>
      </div>
    </div>
  );
}

export default function LoopcomSsoPage() {
  return <Suspense fallback={null}><Inner /></Suspense>;
}
