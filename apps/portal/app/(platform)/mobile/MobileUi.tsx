"use client";
/**
 * LoopCom Mobile — shared UI bits for the product section (2026-09-16).
 * Formatters, status labels, and the small components every page reuses.
 * All colors ride the platform tokens through mobile.css (.lmx scope).
 */
import type { ReactNode } from "react";
import "./mobile.css";

export function money(cents: number | null | undefined): string {
  return `$${(Number(cents ?? 0) / 100).toFixed(2)}`;
}

export function gb(mb: number | null | undefined): string {
  if (mb == null) return "—";
  const n = Number(mb);
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} GB` : `${Math.round(n)} MB`;
}

export function minutes(seconds: number | null | undefined): string {
  return `${Math.round(Number(seconds ?? 0) / 60).toLocaleString()} min`;
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Being set up",
  pending_activation: "Ready to install",
  active: "Active",
  suspended: "Paused",
  lost: "Suspended · lost device",
  terminated: "Closed",
};

export const STATUS_PILL: Record<string, string> = {
  draft: "dim",
  pending_activation: "info",
  active: "ok",
  suspended: "bad",
  lost: "bad",
  terminated: "dim",
};

export const PORT_STATUS_LABEL: Record<string, string> = {
  draft: "Draft — details needed",
  submitted: "Filed with carrier",
  pending: "Carrier check",
  foc: "Transfer date set",
  action_required: "Needs your attention",
  completed: "Completed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const PORT_STATUS_PILL: Record<string, string> = {
  draft: "dim", submitted: "info", pending: "info", foc: "ok",
  action_required: "warn", completed: "ok", rejected: "bad", cancelled: "dim",
};

export function errText(e: any, fallback: string): string {
  return e?.body?.message || e?.body?.error || e?.message || fallback;
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_PILL[status] ?? "dim"}`}>{STATUS_LABEL[status] ?? status.replace(/_/g, " ")}</span>;
}

export function PortStatusPill({ status }: { status: string }) {
  return <span className={`pill ${PORT_STATUS_PILL[status] ?? "dim"}`}>{PORT_STATUS_LABEL[status] ?? status.replace(/_/g, " ")}</span>;
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="lmx-pagehead">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export function Note({ note }: { note: { kind: "ok" | "bad"; text: string } | null }) {
  if (!note) return null;
  return <div className={`note ${note.kind}`}>{note.text}</div>;
}

export function UsageBar({ used, included, width = 90 }: { used: number; included: number | null; width?: number }) {
  if (!included || included <= 0) {
    return <span className="dimtx small">{gb(used)}</span>;
  }
  const pct = Math.min(100, Math.round((used / included) * 100));
  const cls = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
  return (
    <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
      <span className="bar" style={{ width }}><i className={cls} style={{ width: `${pct}%` }} /></span>
      <span className="dimtx small" style={{ whiteSpace: "nowrap" }}>{gb(used)} / {gb(included)}</span>
    </span>
  );
}

export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="state-box">
      <b className="t">{title}</b>
      <p>{text}</p>
      {children ? <div className="act">{children}</div> : null}
    </div>
  );
}

export function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="lcard" aria-busy="true" aria-label="Loading">
      <div className="skel" style={{ height: 14, width: "38%", marginBottom: 10 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 32, marginBottom: 8 }} />
      ))}
    </div>
  );
}

export function Modal({ title, onClose, footer, children }: { title: string; onClose: () => void; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="lmx-modal-back" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lmx-modal">
        <div className="mh"><h4>{title}</h4><button className="mx" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="mb">{children}</div>
        {footer ? <div className="mf">{footer}</div> : null}
      </div>
    </div>
  );
}
