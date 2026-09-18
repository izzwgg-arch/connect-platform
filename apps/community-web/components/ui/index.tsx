"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { mediaUrl } from "@/lib/api";
import { Icon } from "./Icon";

export { Icon } from "./Icon";

/* ── Avatar ─────────────────────────────────────────────────────────────── */
const TONES = ["", "t2", "t3", "t4", "t5"];
export function toneFor(key: string): string {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TONES[h % TONES.length];
}

export function Avatar({ name, assetId, size = 36, square = false, className = "" }: { name: string; assetId?: string | null; size?: number; square?: boolean; className?: string }) {
  const ini = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const src = mediaUrl(assetId, size > 96 ? "medium" : "thumb");
  return (
    <span className={`av ${toneFor(name)} ${square ? "sq" : ""} ${className}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }} title={name} aria-label={name}>
      {src ? <img src={src} alt="" /> : ini}
    </span>
  );
}

/* ── Chip ───────────────────────────────────────────────────────────────── */
export function Chip({ children, kind = "", icon, onClick, className = "", title }: { children: ReactNode; kind?: "" | "ok" | "warn" | "bad" | "ac" | "sel"; icon?: string; onClick?: () => void; className?: string; title?: string }) {
  const inner = (
    <>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </>
  );
  if (onClick)
    return (
      <button type="button" className={`chip ${kind} ${className}`} onClick={onClick} title={title} aria-pressed={kind === "sel"}>
        {inner}
      </button>
    );
  return (
    <span className={`chip ${kind} ${className}`} title={title}>
      {inner}
    </span>
  );
}

export const VChip = ({ children }: { children: ReactNode }) => (
  <Chip kind="ok" icon="check">
    {children}
  </Chip>
);

/* ── Button ─────────────────────────────────────────────────────────────── */
export function Button({ children, kind = "", icon, small, wide, href, className = "", loading, ...rest }: { children: ReactNode; kind?: "" | "p" | "g" | "d" | "g d"; icon?: string; small?: boolean; wide?: boolean; href?: string; className?: string; loading?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const cls = `btn ${kind} ${small ? "s" : ""} ${wide ? "w" : ""} ${className}`;
  const inner = (
    <>
      {loading ? <Icon name="refresh" /> : icon ? <Icon name={icon} /> : null}
      {children}
    </>
  );
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  return (
    <button type="button" className={cls} disabled={loading || rest.disabled} {...rest}>
      {inner}
    </button>
  );
}

/* ── Field ──────────────────────────────────────────────────────────────── */
export function Field({ label, htmlFor, help, error, children }: { label: string; htmlFor: string; help?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="field">
      <label className="lbl" htmlFor={htmlFor} style={{ marginBottom: 0 }}>
        {label}
      </label>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );
}

/* ── Switch ─────────────────────────────────────────────────────────────── */
export function Switch({ on, onChange, label, id }: { on: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return <button type="button" id={id} role="switch" aria-checked={on} aria-label={label} className={`sw ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
type Toast = { id: number; text: string; kind?: "ok" | "err"; action?: { label: string; run: () => void } };
const ToastCtx = createContext<{ toast: (text: string, opts?: Omit<Toast, "id" | "text">) => void }>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const toast = useCallback((text: string, opts: Omit<Toast, "id" | "text"> = {}) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), opts.action ? 6000 : 3200);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      {items.map((t, i) => (
        <div key={t.id} className={`toast ${t.kind === "err" ? "err" : ""}`} role="status" style={{ bottom: 20 + i * 52 }}>
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                setItems((s) => s.filter((x) => x.id !== t.id));
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx).toast;

/* ── Dialog ─────────────────────────────────────────────────────────────── */
export function Dialog({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ fontSize: 17 }}>{title}</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        {children}
        {footer ? <div className="row" style={{ justifyContent: "flex-end" }}>{footer}</div> : null}
      </div>
    </div>
  );
}

/* ── Menu ───────────────────────────────────────────────────────────────── */
export function Menu({ trigger, children, label = "More" }: { trigger?: ReactNode; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="ib" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {trigger ?? <Icon name="dots" />}
      </button>
      {open ? (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/* ── Empty / Skeleton ───────────────────────────────────────────────────── */
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {text ? <span className="sm">{text}</span> : null}
      {action}
    </div>
  );
}
export function Skeleton({ h = 14, w = "100%" }: { h?: number; w?: string | number }) {
  return <div className="skel" style={{ height: h, width: w }} />;
}

/* ── Time ───────────────────────────────────────────────────────────────── */
export function timeAgo(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
}

export function fmtDate(iso: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" }): string {
  if (!iso) return "";
  return (typeof iso === "string" ? new Date(iso) : iso).toLocaleDateString(undefined, opts);
}

export function fmtMoney(n: number | string | null | undefined, currency = "USD"): string {
  if (n == null || n === "") return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(n));
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
