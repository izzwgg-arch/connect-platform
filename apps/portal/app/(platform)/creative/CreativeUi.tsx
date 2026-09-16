"use client";
/**
 * Creative Studio — the pieces every screen in the studio is built from.
 *
 * The CSS is imported once here (not per page) so the bundle carries it a
 * single time, the way LoopCom Mobile does it with MobileUi.
 */
import { ReactNode } from "react";
import "./creative.css";

export function money(micros: number | null | undefined): string {
  const dollars = Number(micros || 0) / 1_000_000;
  if (!dollars) return "$0.00";
  return dollars < 0.01 ? "<$0.01" : `$${dollars.toFixed(2)}`;
}

export function fmtBytes(n: number | null | undefined): string {
  const bytes = Number(n || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function fmtDuration(ms: number | null | undefined): string {
  const total = Math.round(Number(ms || 0) / 1000);
  if (!total) return "—";
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function fmtWhen(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
}

/** Errors people can act on, not stack traces. */
export function errText(e: any): string {
  const body = e?.body || e?.response || e;
  const reason = body?.reason || body?.message || e?.message;
  if (body?.error === "quota_video" || body?.error === "quota_images") return String(reason || "That would pass this month's allowance.");
  if (body?.error === "refused") return String(reason || "That is not something the studio will make.");
  if (body?.error === "forbidden") return String(reason || "You do not have permission to do that.");
  if (body?.error === "no_engine") return String(reason || "No engine is switched on for that yet.");
  return String(reason || "Something went wrong. Try again.");
}

export function PageHead({ title, subtitle, actions, crumb }: { title: string; subtitle?: string; actions?: ReactNode; crumb?: string[] }) {
  return (
    <>
      {crumb?.length ? <div className="cse-crumb">{crumb.join(" › ")}</div> : null}
      <div className="cse-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {actions ? <div className="cse-actions">{actions}</div> : null}
      </div>
    </>
  );
}

export function Card({ title, sub, end, children, className }: { title?: string; sub?: string; end?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`cse-card ${className || ""}`}>
      {title || end ? (
        <div className="cse-card-h">
          {title ? <h3>{title}</h3> : null}
          {sub ? <span className="sub">{sub}</span> : null}
          {end ? <span className="end">{end}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function Pill({ kind, children }: { kind?: "ok" | "warn" | "bad" | "info" | "nub"; children: ReactNode }) {
  return <span className={`cse-pill ${kind || ""}`}>{children}</span>;
}

export function Note({ kind, children }: { kind?: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return <div className={`cse-note ${kind || ""}`}>{children}</div>;
}

export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="cse-empty">
      <h3>{title}</h3>
      {text ? <p>{text}</p> : null}
      {action}
    </div>
  );
}

export function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="cse-card">
      <div className="cse-stack">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="cse-row">
            <div className="cse-skel" style={{ width: 74, height: 42 }} />
            <div style={{ flex: 1 }}>
              <div className="cse-skel" style={{ height: 11, width: "60%" }} />
              <div className="cse-skel" style={{ height: 9, width: "35%", marginTop: 6 }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface AssetLike {
  id: string;
  kind: string;
  name: string;
  url: string;
  thumbUrl?: string | null;
  durationMs?: number | null;
  width?: number | null;
  height?: number | null;
  source?: string;
}

/**
 * One generated or uploaded thing. Video shows its own first frame and plays
 * on click; a still just shows.
 */
export function AssetThumb({ asset, shape, onClick, selected }: { asset: AssetLike; shape?: "sq" | "p45" | "v"; onClick?: () => void; selected?: boolean }) {
  const isVideo = asset.kind === "video";
  return (
    <div
      className={`cse-thumb ${shape || ""} ${selected ? "on" : ""}`}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      {isVideo ? (
        <video src={asset.url} poster={asset.thumbUrl || undefined} controls preload="metadata" playsInline />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={asset.thumbUrl || asset.url} alt={asset.name} loading="lazy" />
      )}
      {isVideo && asset.durationMs ? <span className="dur">{fmtDuration(asset.durationMs)}</span> : null}
      {asset.source === "uploaded" ? <span className="badge">Uploaded</span> : null}
    </div>
  );
}

/** A job that is running, with honest progress and a way out. */
export function JobProgress({ job, onCancel }: { job: any; onCancel?: () => void }) {
  if (!job) return null;
  const failed = job.status === "failed";
  const done = job.status === "succeeded";
  return (
    <div className="cse-stack" style={{ gap: 8 }}>
      <div className="cse-row">
        {!done && !failed ? <span className="cse-spin" /> : null}
        <b style={{ fontSize: 13 }}>
          {failed ? "It didn't work" : done ? "Finished" : job.note || "Working on it"}
        </b>
        {!done && !failed ? <span className="cse-num cse-muted" style={{ marginLeft: "auto" }}>{job.progress || 0}%</span> : null}
      </div>
      {!done && !failed ? (
        <div className="cse-bar">
          <i style={{ width: `${Math.max(4, job.progress || 0)}%` }} />
        </div>
      ) : null}
      {failed ? <Note kind="bad">{job.error || "The engine could not finish it."}</Note> : null}
      {!done && !failed && onCancel ? (
        <div className="cse-row">
          <span className="cse-help">You can close this page — it keeps going.</span>
          <button type="button" className="cse-btn sm" style={{ marginLeft: "auto" }} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

export const CREATE_KINDS: Array<{ label: string; kind: string; hint: string; href: string }> = [
  { label: "Image", kind: "image", hint: "Photos, product shots, illustrations", href: "/creative/images" },
  { label: "AI video", kind: "video", hint: "Up to 15 seconds per shot", href: "/creative/video" },
  { label: "Social graphic", kind: "social", hint: "Instagram, Facebook, WhatsApp", href: "/creative/design" },
  { label: "Advertisement", kind: "ad", hint: "Paid social and display", href: "/creative/design" },
  { label: "Flyer", kind: "flyer", hint: "Print and PDF", href: "/creative/design" },
  { label: "Poster", kind: "poster", hint: "Large format", href: "/creative/design" },
  { label: "Presentation graphic", kind: "presentation", hint: "Slides and diagrams", href: "/creative/design" },
  { label: "Product creative", kind: "product", hint: "Desk phones, hardware, packs", href: "/creative/images" },
  { label: "Logo / branding", kind: "logo", hint: "Marks, lockups, variations", href: "/creative/images" },
  { label: "Custom canvas", kind: "custom", hint: "Any size you like", href: "/creative/design" },
];
