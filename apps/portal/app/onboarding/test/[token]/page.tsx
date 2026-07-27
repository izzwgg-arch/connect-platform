"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiPost } from "../../../../services/apiClient";

/**
 * Reusable TEST entry point. Opening this URL mints a brand-new onboarding
 * submission (via the spawn endpoint) and drops the visitor straight into a
 * fresh wizard — the same link works for unlimited runs.
 */
export default function OnboardingTestEntryPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const fired = useRef(false);

  useEffect(() => {
    const token = String(params?.token || "");
    if (!token || fired.current) return;
    fired.current = true;
    (async () => {
      try {
        const r = await apiPost<{ ok?: boolean; token?: string }>(
          `/onboarding/test/${encodeURIComponent(token)}/spawn`,
          {},
        );
        if (r?.token) {
          router.replace(`/onboarding/${encodeURIComponent(r.token)}`);
        } else {
          setError("This test link isn't valid anymore.");
        }
      } catch {
        setError("This test link isn't valid anymore.");
      }
    })();
  }, [params, router]);

  return (
    <div className="ob-success-wrap">
      <h1 className="ob-success-title">{error ? "Link unavailable" : "Starting a fresh run…"}</h1>
      <p className="ob-success-sub">
        {error || "Setting up a brand-new onboarding session for you. One moment."}
      </p>
    </div>
  );
}
