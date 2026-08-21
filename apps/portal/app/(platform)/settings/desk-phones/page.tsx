"use client";

/**
 * Settings → Devices → Desk Phones.
 *
 * ⛔⛔ THIS IS NOT A PERMANENT ONBOARDING SCREEN. The "finish setting up your desk
 * phones" card is driven by whether anything is actually left to do; once every
 * phone is connected it is not rendered at all and the customer never sees
 * provisioning terminology again. What stays is a quiet list for adding a phone,
 * replacing one, or running setup again.
 *
 * ⛔ A Next.js App Router page may only export a default component — a named export
 * fails the production build and `tsc --noEmit` does NOT catch it.
 */

import { useCallback, useEffect, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { apiGet } from "../../../../services/apiClient";
import { DeskPhoneWizard } from "../../../../components/deskPhones/DeskPhoneWizard";

type SetupState = {
  hasActiveRun: boolean;
  showSetupCard: boolean;
  invitedByLoopcom: boolean;
  runId: string | null;
  summary: { total: number; ready: number; needsAttention: number; finished: boolean; headline: string };
};

export default function DeskPhonesPage() {
  return (
    <PermissionGate
      permission={"can_setup_desk_phones" as any}
      fallback={
        <div className="card" style={{ margin: 24, padding: 24 }}>
          <h2>Desk phones</h2>
          <p>You do not have permission to set up desk phones.</p>
        </div>
      }
    >
      <DeskPhonesConsole />
    </PermissionGate>
  );
}

function DeskPhonesConsole() {
  const [state, setState] = useState<SetupState | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiGet<SetupState>("/desk-phones/state"));
      setLoadError(false);
    } catch {
      // ⛔ An unreadable state is said out loud rather than rendered as "nothing to
      // do here", which would hide a half-finished setup from the person who
      // started it.
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const closeWizard = useCallback(() => { setWizardOpen(false); void load(); }, [load]);

  if (wizardOpen) {
    return (
      <div style={{ padding: 24 }}>
        <DeskPhoneWizard onClose={closeWizard} />
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 860 }}>
      <h2 style={{ font: "700 20px/1.2 Inter, sans-serif", letterSpacing: "-0.02em", margin: "0 0 3px" }}>
        Devices
      </h2>
      <p style={{ color: "var(--text-dim)", fontSize: 13, margin: "0 0 18px" }}>
        Phones, computers and apps signed in to Loopcom.
      </p>

      {loadError && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 14 }}>
            We could not check your desk phones just now. Reload the page to try again.
          </p>
        </div>
      )}

      {state?.showSetupCard && (
        <div
          className="card"
          style={{ padding: "18px 20px", marginBottom: 14, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}
        >
          <div style={{ flex: 1, minWidth: 230 }}>
            <div style={{ font: "700 16px/1.3 Inter, sans-serif", letterSpacing: "-0.01em" }}>
              {state.invitedByLoopcom
                ? "Your desk phones are ready to be set up"
                : "Finish setting up your desk phones"}
            </div>
            <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 5, maxWidth: "46ch" }}>
              {state.invitedByLoopcom
                ? "Loopcom can automatically find and configure the desk phones in your office. Nothing changes on a phone until you say so."
                : "Loopcom can find the desk phones in your office and connect them for you — it takes about five minutes."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            style={{
              border: 0, borderRadius: 9, padding: "10px 17px", cursor: "pointer",
              font: "600 13.5px/1 Inter, sans-serif", background: "var(--accent)", color: "#04121d",
            }}
          >
            {state.invitedByLoopcom ? "Start Setup" : "Set Up My Phones"}
          </button>
        </div>
      )}

      <div
        style={{
          font: "600 11px/1 Inter, sans-serif", letterSpacing: ".09em", textTransform: "uppercase",
          color: "var(--text-dim)", margin: "20px 0 9px",
        }}
      >
        Desk phones
      </div>

      {state && state.summary.total > 0 ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13.5 }}>
          {state.summary.headline}
        </p>
      ) : (
        <p style={{ color: "var(--text-dim)", fontSize: 13.5 }}>
          No desk phones have been set up on this account yet.
        </p>
      )}

      <div style={{ marginTop: 13, display: "flex", gap: 9, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          style={{
            border: "1px solid var(--border)", background: "transparent", color: "var(--text)",
            borderRadius: 8, padding: "7px 12px", font: "600 12.5px/1 Inter, sans-serif", cursor: "pointer",
          }}
        >
          {state && state.summary.total > 0 ? "Add a phone" : "Set up desk phones"}
        </button>
        {state && state.summary.total > 0 && (
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            style={{
              border: "1px solid var(--border)", background: "transparent", color: "var(--text)",
              borderRadius: 8, padding: "7px 12px", font: "600 12.5px/1 Inter, sans-serif", cursor: "pointer",
            }}
          >
            Run setup again
          </button>
        )}
      </div>
    </div>
  );
}
