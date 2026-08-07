"use client";

/* Shared pieces for the rebuilt billing pages. Private folder (underscore), so
   Next never routes to it. */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiGet } from "../../../../../services/apiClient";

export function money(cents: number | null | undefined): string {
  const n = Number(cents ?? 0);
  return `${n < 0 ? "-" : ""}$${Math.abs(n / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function longDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(
    [],
    { hour: "numeric", minute: "2-digit" },
  )}`;
}

export function ordinal(n: number): string {
  const v = Number(n) || 1;
  if (v % 100 >= 11 && v % 100 <= 13) return `${v}th`;
  return `${v}${["th", "st", "nd", "rd"][v % 10] ?? "th"}`;
}

/** ⛔ ApiError exposes the server's JSON body as `.body`. `.payload` has never existed. */
export function errText(e: any, fallback: string): string {
  return e?.body?.detail || e?.body?.message || e?.body?.error || e?.message || fallback;
}

export type PillTone = "ok" | "warn" | "bad" | "info" | "off";

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return <span className={`cbill-pill ${tone}`}>{children}</span>;
}

/** Invoice status → the words a person uses, plus a colour. */
export function invoiceTone(status: string): { tone: PillTone; label: string } {
  switch (String(status || "").toUpperCase()) {
    case "PAID": return { tone: "ok", label: "Paid" };
    case "OPEN": return { tone: "info", label: "Waiting" };
    case "DRAFT": return { tone: "off", label: "Draft" };
    case "FAILED": return { tone: "bad", label: "Payment failed" };
    case "OVERDUE": return { tone: "bad", label: "Overdue" };
    case "VOID": return { tone: "off", label: "Cancelled" };
    default: return { tone: "off", label: status || "—" };
  }
}

export function txTone(status: string): { tone: PillTone; label: string } {
  switch (String(status || "").toUpperCase()) {
    case "APPROVED": return { tone: "ok", label: "Approved" };
    case "DECLINED": return { tone: "bad", label: "Declined" };
    case "ERROR": return { tone: "bad", label: "Error" };
    case "REFUNDED": return { tone: "warn", label: "Refunded" };
    case "VOIDED": return { tone: "off", label: "Voided" };
    case "PENDING": return { tone: "info", label: "Pending" };
    default: return { tone: "off", label: status || "—" };
  }
}

export function Card({
  title,
  hint,
  actions,
  children,
  bodyPadded = true,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyPadded?: boolean;
}) {
  return (
    <section className="cbill-card">
      <div className="cbill-card-hd">
        <h3>{title}</h3>
        <div className="cbill-toolbar">
          {hint ? <span className="hint">{hint}</span> : null}
          {actions}
        </div>
      </div>
      {bodyPadded ? <div className="cbill-card-bd">{children}</div> : children}
    </section>
  );
}

/** Small fetch hook — every page tolerates a failed call rather than blanking. */
export function useApi<T>(path: string | null, transform?: (raw: any) => T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(Boolean(path));

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError("");
    try {
      const raw = await apiGet<any>(path);
      setData(transform ? transform(raw) : (raw as T));
    } catch (e: any) {
      setError(errText(e, "Could not load this."));
      setData(null);
    } finally {
      setLoading(false);
    }
    // transform is intentionally not a dep — callers pass inline functions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload };
}

/** Tolerate the several list shapes the billing API returns. */
export function asList<T = any>(raw: any, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  for (const k of keys) {
    if (Array.isArray(raw?.[k])) return raw[k] as T[];
  }
  return [];
}

/** The rebuilt billing nav — the tab bar from the design, replacing the old
    nine-tab workspace toolbar these pages used to be wrapped in. */
export function BillingNav({ current }: { current: string }) {
  const items: Array<{ key: string; label: string; href: string }> = [
    { key: "month", label: "This month", href: "/admin/billing/month" },
    { key: "customers", label: "Customers", href: "/admin/billing/customers" },
    { key: "invoices", label: "Invoices", href: "/admin/billing/invoice" },
    { key: "payments", label: "Payments", href: "/admin/billing/money" },
    { key: "needs-you", label: "Needs you", href: "/admin/billing/needs-you" },
    { key: "catalog", label: "Catalog", href: "/admin/billing/catalog" },
  ];
  return (
    <nav className="cbill-nav" aria-label="Billing">
      {items.map((it) => (
        <a key={it.key} href={it.href} data-on={it.key === current ? "true" : "false"}>
          {it.label}
        </a>
      ))}
    </nav>
  );
}
