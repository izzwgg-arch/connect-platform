"use client";

import { useEffect, useMemo, useState } from "react";
import { ScrollText, Search } from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm } from "../../../../components/crm";
import { deliveryApi } from "../../../../services/deliveryApi";

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | number;
  actorUserId?: string | number | null;
  metadata?: unknown;
  createdAt: string;
}

// ── Result derivation ────────────────────────────────────────────────────────
// The API has no explicit result field, so we derive a label + tone from the
// action string. Tones use ONLY design-system tokens (light/dark safe).
type Tone = "success" | "danger" | "accent" | "muted";

const TONE_CLASSES: Record<Tone, string> = {
  success: "border-crm-success/40 bg-crm-success/10 text-crm-success",
  danger: "border-crm-danger/40 bg-crm-danger/10 text-crm-danger",
  accent: "border-crm-accent/40 bg-crm-accent/10 text-crm-accent",
  muted: "border-crm-border bg-crm-surface-2 text-crm-muted",
};

function deriveResult(action: string): { label: string; tone: Tone } {
  const a = action.toLowerCase();
  if (a.includes("delivered")) return { label: "delivered", tone: "success" };
  if (a.includes("signed") || a.includes("proof")) return { label: "signed", tone: "success" };
  if (a.includes("revoked") || a.includes("deactivated") || a.includes("failed"))
    return { label: "failed", tone: "danger" };
  if (a.includes("access") || a.includes("view")) return { label: "access-logged", tone: "muted" };
  if (
    a.includes("minted") ||
    a.includes("created") ||
    a.includes("note") ||
    a.includes("reassigned") ||
    a.includes("updated") ||
    a.includes("sent")
  )
    return { label: "ok", tone: "accent" };
  return { label: "ok", tone: "muted" };
}

// Human-readable action label: strip the "delivery." prefix, turn dots /
// underscores into spaces.
function actionLabel(action: string): string {
  return action.replace(/^delivery\./, "").replace(/[._]/g, " ");
}

// Action-type filter groups come from the distinct prefixes present (first
// segment after any "delivery." prefix, e.g. "order", "tracking_link", "proof").
function actionPrefix(action: string): string {
  const stripped = action.replace(/^delivery\./, "");
  return stripped.split(".")[0] || stripped;
}

function actorLabel(actorUserId?: string | number | null): string {
  if (actorUserId == null || actorUserId === "") return "system";
  return String(actorUserId).slice(-8);
}

function targetLabel(row: AuditRow): string {
  return `${row.entityType}:${String(row.entityId).slice(-6)}`;
}

export default function TrackingAuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actionType, setActionType] = useState("");

  useEffect(() => {
    deliveryApi
      .audit()
      .then((r) => setRows(r as AuditRow[]))
      .catch((e) =>
        setError(
          e?.message === "delivery_not_enabled"
            ? "Delivery isn't enabled for this tenant yet."
            : "Couldn't load the audit log."
        )
      )
      .finally(() => setLoading(false));
  }, []);

  // Distinct action prefixes present, for the filter pills.
  const actionTypes = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(actionPrefix(r.action));
    return Array.from(set).sort();
  }, [rows]);

  // Client-side filtering across action / target / actor + action-type pill.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (actionType && actionPrefix(r.action) !== actionType) return false;
      if (!q) return true;
      const haystack = `${actionLabel(r.action)} ${r.action} ${targetLabel(r)} ${actorLabel(
        r.actorUserId
      )}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query, actionType]);

  return (
    <CRMPageShell innerClassName={crm.pageInnerWide}>
      <CRMPageHeader
        icon={<ScrollText size={20} />}
        title="Audit log"
        subtitle="Immutable, tenant-scoped record of every delivery action — including proof-access logging."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-crm-muted"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search action, target, actor…"
                className={`${crm.input} ${crm.inputWithIcon} sm:w-72`}
              />
            </div>
            {actionTypes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  className={actionType === "" ? crm.filterPillActive : crm.filterPill}
                  onClick={() => setActionType("")}
                >
                  all
                </button>
                {actionTypes.map((t) => (
                  <button
                    key={t}
                    className={actionType === t ? crm.filterPillActive : crm.filterPill}
                    onClick={() => setActionType(t)}
                  >
                    {t.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      />

      <CRMCard padding="none">
        {error ? (
          <p className="p-4 text-sm text-crm-muted">{error}</p>
        ) : loading ? (
          <p className="p-4 text-sm text-crm-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">No delivery activity recorded yet.</p>
        ) : filtered.length === 0 ? (
          <p className="p-4 text-sm text-crm-muted">No entries match your filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-crm-border text-left text-[11px] uppercase tracking-wide text-crm-muted">
                  <th className="px-4 py-2 font-semibold">Time</th>
                  <th className="px-4 py-2 font-semibold">Action</th>
                  <th className="px-4 py-2 font-semibold">Target</th>
                  <th className="px-4 py-2 font-semibold">Actor</th>
                  <th className="px-4 py-2 font-semibold">Result</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const result = deriveResult(a.action);
                  return (
                    <tr key={a.id} className="border-b border-crm-border hover:bg-crm-surface-2">
                      <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-crm-muted">
                        {new Date(a.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2.5 text-crm-text">{actionLabel(a.action)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-crm-muted">{targetLabel(a)}</td>
                      <td className="px-4 py-2.5 text-crm-muted">{actorLabel(a.actorUserId)}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[result.tone]}`}
                        >
                          {result.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CRMCard>
    </CRMPageShell>
  );
}
