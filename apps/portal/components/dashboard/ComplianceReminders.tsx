"use client";

// The dashboard half of the compliance calendar (Izzy, 2026-08-23): any
// regulatory deadline due within 30 days — or overdue — sits at the top of the
// super-admin dashboard UNTIL it is marked done. Marking done here goes
// through the same api route as the Compliance page (yearly items roll
// forward a year; nothing is silently closed).
//
// ⛔ Renders for SUPER_ADMIN only, and renders NOTHING on any fetch error —
// a broken banner must never break the dashboard. The api route refuses
// non-super-admins anyway; the role check just avoids a guaranteed 403 in
// every customer admin's console.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "../../services/apiClient";
import { useAppContext } from "../../hooks/useAppContext";

type Item = {
  id: string;
  title: string;
  dueDate: string | null;
  recurrence: "yearly" | null;
  completedAt: string | null;
  daysLeft: number | null;
};

function fmtDue(ymd: string | null): string {
  if (!ymd) return "";
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}

export function ComplianceReminders() {
  const { backendJwtRole } = useAppContext();
  const isSuper = backendJwtRole === "SUPER_ADMIN";
  const [items, setItems] = useState<Item[]>([]);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ items: Item[] }>("/admin/compliance/items");
      setItems((res.items || []).filter((i) => !i.completedAt && i.daysLeft != null && i.daysLeft <= 30));
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (!isSuper) return;
    void load();
  }, [isSuper, load]);

  const complete = async (item: Item) => {
    const msg =
      item.recurrence === "yearly"
        ? `Mark "${item.title}" done for this year? It moves to next year's date.`
        : `Mark "${item.title}" done? This closes it for good.`;
    if (!window.confirm(msg)) return;
    setBusyId(item.id);
    try {
      await apiPost(`/admin/compliance/items/${item.id}/complete`);
      await load();
    } catch {
      // The Compliance page shows real errors; the banner stays quiet.
    } finally {
      setBusyId("");
    }
  };

  if (!isSuper || items.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--warning)",
        borderRadius: 12,
        padding: "12px 16px",
        marginBottom: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Compliance deadlines</div>
        <Link href="/admin/compliance" style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
          Open the calendar →
        </Link>
      </div>
      {items.map((item) => {
        const overdue = (item.daysLeft ?? 0) < 0;
        return (
          <div
            key={item.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0 0", flexWrap: "wrap" }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 999,
                padding: "2px 9px",
                background: overdue ? "var(--danger)" : "var(--warning)",
                color: overdue ? "#fff" : "#1a1305",
                flexShrink: 0,
              }}
            >
              {overdue
                ? `Overdue`
                : item.daysLeft === 0
                  ? "Due today"
                  : `${item.daysLeft}d left`}
            </span>
            <span style={{ fontSize: 13, color: "var(--text)", flex: 1, minWidth: 200 }}>
              {item.title} <span style={{ color: "var(--text-dim)" }}>— due {fmtDue(item.dueDate)}</span>
            </span>
            <button
              onClick={() => void complete(item)}
              disabled={busyId === item.id}
              style={{
                border: "1px solid var(--border)",
                background: "var(--panel-2)",
                color: "var(--text)",
                borderRadius: 8,
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {item.recurrence === "yearly" ? "Done for this year" : "Mark done"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
