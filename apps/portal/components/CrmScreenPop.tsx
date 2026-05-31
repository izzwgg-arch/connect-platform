"use client";

/**
 * CrmScreenPop — Phase 2B
 *
 * Watches the live telephony WebSocket for new inbound ringing calls,
 * looks up the caller's CRM contact, and shows a non-intrusive flyout.
 *
 * Hard rules:
 *  - Never throws / spams — silent on lookup failure or 403.
 *  - Deduplicates by linkedId so the same call never pops twice.
 *  - Auto-dismisses when the call hangs up.
 *  - Only activates when CRM is enabled (API enforces; 403 = silent skip).
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PhoneIncoming, X, User, CheckSquare, ChevronRight } from "lucide-react";
import { useTelephony } from "../contexts/TelephonyContext";
import { useAppContext } from "../hooks/useAppContext";
import type { LiveCall } from "../types/liveCall";
import { apiGet } from "../services/apiClient";
import { shouldShowCrmInboundQuickAction } from "../lib/crmInboundCallDisplay";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LookupContact {
  id: string;
  displayName: string;
  company?: string | null;
  crmStage?: string | null;
  isInCrm: boolean;
  primaryPhone?: { numberRaw: string } | null;
}

interface PopEntry {
  call: LiveCall;
  contact: LookupContact | null;
  openTasksCount: number;
  nextDueTask: { title: string; dueAt: string | null } | null;
  loading: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  LEAD: "Lead",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  CUSTOMER: "Customer",
  CLOSED_LOST: "Closed",
};

const STAGE_COLORS: Record<string, { bg: string; text: string }> = {
  LEAD:        { bg: "#fef3c7", text: "#92400e" },
  CONTACTED:   { bg: "#dbeafe", text: "#1e40af" },
  QUALIFIED:   { bg: "#d1fae5", text: "#065f46" },
  CUSTOMER:    { bg: "#ede9fe", text: "#5b21b6" },
  CLOSED_LOST: { bg: "#fee2e2", text: "#991b1b" },
};

/** Returns true for short extensions (2–6 digits) that are internal. */
function looksInternal(num: string): boolean {
  return /^\d{2,6}$/.test(num.replace(/\D/g, ""));
}

function formatDueDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.floor((d.getTime() - today.setHours(0, 0, 0, 0)) / 86400000);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Single pop card ───────────────────────────────────────────────────────────

function PopCard({
  entry,
  onDismiss,
}: {
  entry: PopEntry;
  onDismiss: (linkedId: string) => void;
}) {
  const router = useRouter();
  const { call, contact, openTasksCount, nextDueTask, loading } = entry;
  const stageColors = contact?.crmStage ? STAGE_COLORS[contact.crmStage] : null;

  return (
    <div
      style={{
        width: 312,
        background: "var(--surface, #fff)",
        borderRadius: 12,
        boxShadow: "0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.1)",
        borderLeft: "4px solid #10b981",
        overflow: "hidden",
        animation: "crm-pop-slide-in 0.22s ease-out",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.625rem 0.875rem",
          background: "#f0fdf4",
          borderBottom: "1px solid #d1fae5",
        }}
      >
        <PhoneIncoming size={14} style={{ color: "#10b981", flexShrink: 0 }} />
        <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#065f46", flex: 1 }}>
          Incoming Call
        </span>
        <span style={{ fontSize: "0.75rem", color: "#065f46", fontFamily: "monospace" }}>
          {call.from ?? "Unknown"}
        </span>
        <button
          onClick={() => onDismiss(call.linkedId)}
          title="Dismiss"
          style={{
            background: "none", border: "none", cursor: "pointer", padding: "0.125rem",
            color: "#6b7280", lineHeight: 1, flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Body */}
      <div style={{ padding: "0.75rem 0.875rem" }}>
        {loading && (
          <div style={{ fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
            Looking up contact…
          </div>
        )}

        {!loading && !contact && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <User size={16} style={{ color: "var(--text-dim, #9ca3af)" }} />
            <span style={{ fontSize: "0.8125rem", color: "var(--text-dim, #9ca3af)" }}>
              Unknown caller
            </span>
          </div>
        )}

        {!loading && contact && (
          <>
            {/* Contact identity */}
            <div style={{ marginBottom: "0.375rem" }}>
              <div style={{ fontWeight: 700, fontSize: "0.9375rem", color: "var(--text, #111)" }}>
                {contact.displayName}
              </div>
              {contact.company && (
                <div style={{ fontSize: "0.75rem", color: "var(--text-dim, #6b7280)", marginTop: "0.1rem" }}>
                  {contact.company}
                </div>
              )}
            </div>

            {/* Stage badge */}
            {contact.crmStage && stageColors && (
              <span
                style={{
                  display: "inline-block",
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  padding: "0.125rem 0.5rem",
                  borderRadius: 20,
                  background: stageColors.bg,
                  color: stageColors.text,
                  marginBottom: "0.5rem",
                }}
              >
                {STAGE_LABELS[contact.crmStage] ?? contact.crmStage}
              </span>
            )}

            {/* Task count + next task */}
            {openTasksCount > 0 && (
              <div
                style={{
                  display: "flex", alignItems: "center", gap: "0.375rem",
                  fontSize: "0.75rem", color: "#d97706", marginBottom: "0.25rem",
                }}
              >
                <CheckSquare size={12} />
                <span>{openTasksCount} open task{openTasksCount !== 1 ? "s" : ""}</span>
              </div>
            )}
            {nextDueTask && (
              <div
                style={{
                  fontSize: "0.75rem", color: "var(--text-dim, #6b7280)",
                  marginBottom: "0.5rem",
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                }}
              >
                Next: {nextDueTask.title}
                {nextDueTask.dueAt && (
                  <span style={{ color: "#d97706", marginLeft: "0.25rem" }}>
                    ({formatDueDate(nextDueTask.dueAt)})
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Actions */}
      {!loading && contact && (
        <div
          style={{
            display: "flex", flexDirection: "column", gap: "0.375rem",
            padding: "0.5rem 0.875rem 0.75rem",
          }}
        >
          {/* Primary: Open Live Workspace — the main agent action */}
          <button
            onClick={() => {
              router.push(`/crm/live-call?contactId=${contact.id}&linkedId=${encodeURIComponent(call.linkedId)}&from=${encodeURIComponent(call.from ?? "")}`);
              onDismiss(call.linkedId);
            }}
            style={{
              width: "100%", display: "flex", alignItems: "center", justifyContent: "center",
              gap: "0.3rem",
              padding: "0.45rem 0", borderRadius: 6,
              background: "var(--accent, #6366f1)", color: "#fff",
              border: "none", cursor: "pointer", fontSize: "0.8125rem", fontWeight: 700,
            }}
          >
            Open Live Workspace <ChevronRight size={12} />
          </button>
          {/* Secondary: open contact detail only */}
          <button
            onClick={() => {
              router.push(`/crm/contacts/${contact.id}`);
              onDismiss(call.linkedId);
            }}
            style={{
              width: "100%", padding: "0.375rem 0", borderRadius: 6,
              background: "transparent", color: "var(--text-dim, #6b7280)",
              border: "1px solid var(--border, #e5e7eb)",
              cursor: "pointer", fontSize: "0.75rem",
            }}
          >
            View Contact
          </button>
        </div>
      )}

      {/* Unknown caller — still offer to search */}
      {!loading && !contact && (
        <div style={{ padding: "0 0.875rem 0.75rem" }}>
          <button
            onClick={() => onDismiss(call.linkedId)}
            style={{
              width: "100%", padding: "0.4rem 0", borderRadius: 6,
              background: "transparent", color: "var(--text-dim, #6b7280)",
              border: "1px solid var(--border, #e5e7eb)",
              cursor: "pointer", fontSize: "0.75rem",
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function CrmScreenPop() {
  const { activeCalls } = useTelephony();
  const { tenantId } = useAppContext();
  const [pops, setPops] = useState<PopEntry[]>([]);

  // Tracks linkedIds we've already initiated a lookup for (dedup guard)
  const seenLinkedIds = useRef(new Set<string>());
  // Tracks linkedIds that the user explicitly dismissed (don't re-pop same call)
  const dismissedLinkedIds = useRef(new Set<string>());

  const dismiss = useCallback((linkedId: string) => {
    dismissedLinkedIds.current.add(linkedId);
    setPops((prev) => prev.filter((p) => p.call.linkedId !== linkedId));
  }, []);

  useEffect(() => {
    // Clean up pops for calls that have ended (left activeCalls)
    setPops((prev) =>
      prev.filter((p) => activeCalls.some((c) => c.linkedId === p.call.linkedId)),
    );

    // Find new inbound ringing calls not yet seen or dismissed
    const newCalls = activeCalls.filter(
      (c) =>
        c.direction === "inbound" &&
        c.state === "ringing" &&
        c.from &&
        !looksInternal(c.from) &&
        !seenLinkedIds.current.has(c.linkedId) &&
        !dismissedLinkedIds.current.has(c.linkedId),
    );

    for (const call of newCalls) {
      seenLinkedIds.current.add(call.linkedId);

      // Add a loading placeholder immediately
      setPops((prev) => {
        // Only keep one pop at a time — replace older ringing pops if stacked
        const withoutThisCall = prev.filter((p) => p.call.linkedId !== call.linkedId);
        return [
          ...withoutThisCall,
          { call, contact: null, openTasksCount: 0, nextDueTask: null, loading: true },
        ];
      });

      const callLinkedId = call.linkedId;

      // Server-side match on telephony WS payload (permission-filtered per viewer).
      if (shouldShowCrmInboundQuickAction(call) && call.crmContactId) {
        setPops((prev) =>
          prev.map((p) =>
            p.call.linkedId === callLinkedId
              ? {
                  ...p,
                  loading: false,
                  contact: {
                    id: call.crmContactId!,
                    displayName: call.crmContactName ?? "Contact",
                    company: call.crmCompanyName ?? null,
                    isInCrm: true,
                    primaryPhone: call.from ? { numberRaw: call.from } : null,
                  },
                  openTasksCount: 0,
                  nextDueTask: null,
                }
              : p,
          ),
        );
        continue;
      }

      // Fallback: legacy lookup when WS enrichment unavailable (e.g. enricher disabled).
      if (!call.from) {
        setPops((prev) => prev.filter((p) => p.call.linkedId !== callLinkedId));
        continue;
      }
      const phone = call.from;
      apiGet<{ results: Array<{ matchedPhone: string; contact: LookupContact; openTasksCount: number; nextDueTask: { title: string; dueAt: string | null } | null }> }>(
        `/crm/contacts/lookup?phone=${encodeURIComponent(phone)}`,
      )
        .then((data) => {
          const top = data.results?.[0];
          setPops((prev) =>
            prev.map((p) =>
              p.call.linkedId === callLinkedId
                ? {
                    ...p,
                    loading: false,
                    contact: top?.contact ?? null,
                    openTasksCount: top?.openTasksCount ?? 0,
                    nextDueTask: top?.nextDueTask ?? null,
                  }
                : p,
            ),
          );
        })
        .catch(() => {
          setPops((prev) => prev.filter((p) => p.call.linkedId !== callLinkedId));
        });
    }
  }, [activeCalls]); // eslint-disable-line react-hooks/exhaustive-deps

  if (pops.length === 0 || !tenantId) return null;

  return (
    <>
      {/* Keyframe for slide-in animation */}
      <style>{`
        @keyframes crm-pop-slide-in {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          maxWidth: 312,
          pointerEvents: "auto",
        }}
      >
        {pops.map((entry) => (
          <PopCard key={entry.call.linkedId} entry={entry} onDismiss={dismiss} />
        ))}
      </div>
    </>
  );
}
