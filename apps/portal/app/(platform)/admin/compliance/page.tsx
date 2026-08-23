"use client";

// The regulatory compliance calendar (Izzy, 2026-08-23) — every FCC/USAC/state
// deadline in one place. Items due within 30 days (or overdue) also appear as
// a banner on the super-admin dashboard until they are marked done, and the
// api's reminder sweep texts + emails the owner at T-30 days then weekly.
//
// ⛔ Access: the PermissionGate here is presentation only — the real fences
// are the SUPER_ADMIN force line in navConfig.isNavItemVisibleForUser and the
// api routes' requireSuperAdmin (prefix /admin/compliance also carries
// can_manage_global_settings in PORTAL_API_PERMISSION_RULES).
// ⛔ No native <select> on this page — house rule; the only controls are text
// inputs, a date input and a checkbox.

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";
import { PermissionGate } from "../../../../components/PermissionGate";
import "./compliance.css";

export type ComplianceItem = {
  id: string;
  key: string | null;
  title: string;
  details: string | null;
  dueDate: string | null; // YYYY-MM-DD
  recurrence: "yearly" | null;
  completedAt: string | null;
  lastCompletedAt: string | null;
  lastReminderAt: string | null;
  reminderCount: number;
  daysLeft: number | null;
};

function errText(e: any, fallback: string): string {
  return e?.body?.detail || e?.body?.message || e?.body?.error || e?.message || fallback;
}

function fmtDate(ymd: string | null): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
}

function dueChip(item: ComplianceItem): { cls: string; text: string } {
  const n = item.daysLeft;
  if (n == null) return { cls: "cmp-chip-ok", text: "" };
  if (n < 0) return { cls: "cmp-chip-overdue", text: `Overdue by ${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}` };
  if (n === 0) return { cls: "cmp-chip-overdue", text: "Due today" };
  if (n <= 30) return { cls: "cmp-chip-soon", text: `${n} day${n === 1 ? "" : "s"} left` };
  return { cls: "cmp-chip-ok", text: `${n} days left` };
}

function CompliancePageBody() {
  const [items, setItems] = useState<ComplianceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  // Add form
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [yearly, setYearly] = useState(true);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet<{ items: ComplianceItem[] }>("/admin/compliance/items");
      setItems(res.items || []);
    } catch (e: any) {
      setError(errText(e, "Could not load the compliance calendar."));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const open = useMemo(() => items.filter((i) => !i.completedAt), [items]);
  const attention = useMemo(() => open.filter((i) => i.daysLeft != null && i.daysLeft <= 30), [open]);
  const upcoming = useMemo(() => open.filter((i) => i.daysLeft == null || i.daysLeft > 30), [open]);
  const done = useMemo(() => items.filter((i) => i.completedAt), [items]);

  const complete = async (item: ComplianceItem) => {
    const msg =
      item.recurrence === "yearly"
        ? `Mark "${item.title}" done for this year? It will move to next year's date and the reminders stop until then.`
        : `Mark "${item.title}" done? This closes it for good.`;
    if (!window.confirm(msg)) return;
    setBusyId(item.id);
    setError("");
    try {
      await apiPost(`/admin/compliance/items/${item.id}/complete`);
      await load();
    } catch (e: any) {
      setError(errText(e, "Could not mark that done."));
    } finally {
      setBusyId("");
    }
  };

  const remove = async (item: ComplianceItem) => {
    if (!window.confirm(`Delete "${item.title}"? This only works for items you added yourself.`)) return;
    setBusyId(item.id);
    setError("");
    try {
      await apiDelete(`/admin/compliance/items/${item.id}`);
      await load();
    } catch (e: any) {
      setError(errText(e, "Could not delete that item."));
    } finally {
      setBusyId("");
    }
  };

  const add = async () => {
    if (!title.trim() || !dueDate) {
      setError("A new item needs a title and a due date.");
      return;
    }
    setAdding(true);
    setError("");
    try {
      await apiPost("/admin/compliance/items", {
        title: title.trim(),
        details: details.trim() || undefined,
        dueDate,
        recurrence: yearly ? "yearly" : null,
      });
      setTitle("");
      setDetails("");
      setDueDate("");
      setYearly(true);
      await load();
    } catch (e: any) {
      setError(errText(e, "Could not add the item."));
    } finally {
      setAdding(false);
    }
  };

  const renderItem = (item: ComplianceItem) => {
    const chip = dueChip(item);
    const cardCls =
      item.daysLeft != null && item.daysLeft < 0 ? "cmp-card cmp-overdue" : item.daysLeft != null && item.daysLeft <= 30 ? "cmp-card cmp-soon" : "cmp-card";
    return (
      <div key={item.id} className={item.completedAt ? "cmp-card" : cardCls}>
        <div className="cmp-main">
          <p className="cmp-item-title">{item.title}</p>
          {item.details ? <p className="cmp-item-details">{item.details}</p> : null}
          <div className="cmp-meta">
            {item.completedAt ? (
              <span className="cmp-chip cmp-chip-ok">Done {fmtDate(item.completedAt.slice(0, 10))}</span>
            ) : (
              <>
                <span className="cmp-chip cmp-chip-ok">Due {fmtDate(item.dueDate)}</span>
                {chip.text ? <span className={`cmp-chip ${chip.cls}`}>{chip.text}</span> : null}
              </>
            )}
            {item.recurrence === "yearly" ? <span className="cmp-chip cmp-chip-yearly">Every year</span> : null}
            {item.reminderCount > 0 && !item.completedAt ? (
              <span className="cmp-note">
                {item.reminderCount} reminder{item.reminderCount === 1 ? "" : "s"} sent
              </span>
            ) : null}
            {item.lastCompletedAt && !item.completedAt ? <span className="cmp-note">Last done {fmtDate(item.lastCompletedAt.slice(0, 10))}</span> : null}
          </div>
        </div>
        {!item.completedAt ? (
          <div className="cmp-actions">
            <button className="cmp-btn cmp-btn-primary" disabled={busyId === item.id} onClick={() => void complete(item)}>
              {item.recurrence === "yearly" ? "Done for this year" : "Mark done"}
            </button>
            {!item.key ? (
              <button className="cmp-btn cmp-btn-quiet" disabled={busyId === item.id} onClick={() => void remove(item)}>
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="cmp-page">
      <div className="cmp-head">
        <h1 className="cmp-title">Compliance calendar</h1>
      </div>
      <p className="cmp-sub">
        Every regulatory deadline in one place. A month before each due date you get a text and an email, then once a week until it&apos;s marked done. Items due
        soon also sit on the dashboard until completed.
      </p>

      {error ? <div className="cmp-error">{error}</div> : null}
      {loading ? <div className="cmp-empty">Loading the calendar…</div> : null}

      {!loading && attention.length > 0 ? (
        <>
          <div className="cmp-section">Needs attention</div>
          {attention.map(renderItem)}
        </>
      ) : null}

      {!loading ? (
        <>
          <div className="cmp-section">Coming up</div>
          {upcoming.length ? upcoming.map(renderItem) : <div className="cmp-empty">Nothing further out on the calendar.</div>}
        </>
      ) : null}

      {!loading && done.length > 0 ? (
        <>
          <div className="cmp-section">Done</div>
          {done.map(renderItem)}
        </>
      ) : null}

      <div className="cmp-add">
        <h3>Add a deadline</h3>
        <div className="cmp-add-grid">
          <input className="cmp-input" placeholder="What has to be filed or renewed?" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="cmp-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <textarea
            className="cmp-textarea cmp-full"
            placeholder="Notes — where it gets filed, account details, anything the person doing it needs. (Optional)"
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </div>
        <div className="cmp-add-foot">
          <label className="cmp-checkline">
            <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
            Repeats every year
          </label>
          <button className="cmp-btn cmp-btn-primary" disabled={adding} onClick={() => void add()}>
            {adding ? "Adding…" : "Add to calendar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CompliancePage() {
  return (
    <PermissionGate permission={"can_manage_global_settings" as never} fallback={<div className="cmp-empty">This page is for the platform owner.</div>}>
      <CompliancePageBody />
    </PermissionGate>
  );
}
