"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAppContext } from "../../../hooks/useAppContext";
import { apiGet, apiPut } from "../../../services/apiClient";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";

type CrmSettings = {
  enabled: boolean;
  localPresenceEnabled: boolean;
  transcriptionEnabled: boolean;
};

type State =
  | { phase: "loading" }
  | { phase: "not_enabled"; isAdmin: boolean }
  | { phase: "ready" };

export default function CrmLayout({ children }: { children: ReactNode }) {
  const { can, backendJwtRole, permissionsHydrated } = useAppContext();
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "loading" });
  const [enabling, setEnabling] = useState(false);

  const isAdmin =
    backendJwtRole === "ADMIN" ||
    backendJwtRole === "TENANT_ADMIN" ||
    backendJwtRole === "SUPER_ADMIN";

  const hasCrmPermission = can("can_view_section_crm");

  useEffect(() => {
    if (!permissionsHydrated) return;
    if (!hasCrmPermission) {
      router.replace("/dashboard");
      return;
    }

    let active = true;
    apiGet<CrmSettings>("/crm/settings")
      .then((s) => {
        if (!active) return;
        if (s.enabled) {
          setState({ phase: "ready" });
        } else {
          setState({ phase: "not_enabled", isAdmin });
        }
      })
      .catch(() => {
        if (!active) return;
        // On error treat as not enabled rather than crashing
        setState({ phase: "not_enabled", isAdmin });
      });
    return () => { active = false; };
  }, [hasCrmPermission, isAdmin, permissionsHydrated, router]);

  if (!permissionsHydrated) {
    return <div className="crm-route-background">{children}</div>;
  }

  if (!hasCrmPermission) {
    return null;
  }

  if (state.phase === "loading") {
    return (
      <div className="crm-route-background">
        <div style={{ padding: "2rem" }}>
          <LoadingSkeleton rows={4} />
        </div>
      </div>
    );
  }

  if (state.phase === "not_enabled") {
    const handleEnable = async () => {
      setEnabling(true);
      try {
        await apiPut("/crm/settings", { enabled: true });
        setState({ phase: "ready" });
      } catch {
        setEnabling(false);
      }
    };

    return (
      <div className="crm-route-background">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", padding: "2rem" }}>
          <div style={{
            maxWidth: 480,
            width: "100%",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            padding: "2rem",
            textAlign: "center",
          }}>
            <div style={{ fontSize: "2.5rem", marginBottom: "1rem" }}>📋</div>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem", fontWeight: 700 }}>
              CRM is not enabled
            </h2>
            <p style={{ margin: "0 0 1.5rem", color: "var(--text-dim)", fontSize: "0.9375rem", lineHeight: 1.6 }}>
              {state.isAdmin
                ? "Enable the CRM module to start managing contacts, leads, campaigns, and call workflows for your team."
                : "CRM has not been enabled for your workspace. Ask a tenant admin to enable it."}
            </p>
            {state.isAdmin && (
              <button
                onClick={handleEnable}
                disabled={enabling}
                style={{
                  padding: "0.625rem 1.5rem",
                  borderRadius: "0.5rem",
                  background: "var(--accent)",
                  color: "#fff",
                  border: "none",
                  fontSize: "0.9375rem",
                  fontWeight: 600,
                  cursor: enabling ? "not-allowed" : "pointer",
                  opacity: enabling ? 0.7 : 1,
                  transition: "opacity 0.15s",
                }}
              >
                {enabling ? "Enabling…" : "Enable CRM"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <div className="crm-route-background">{children}</div>;
}
