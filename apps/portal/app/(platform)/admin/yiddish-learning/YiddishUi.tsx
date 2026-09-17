"use client";
/**
 * Yiddish Learning Engine — shared UI for the admin section (2026-09-15).
 *
 * ⛔ THREE RULES THIS FILE EXISTS TO ENFORCE IN THE UI LAYER:
 *
 *  1. REAL DATA ONLY. Nothing here invents a number. Every figure on every
 *     screen comes from `/admin/yiddish/*`. When a call fails, the screen
 *     shows the failure (status + the server's own message); when a route is
 *     not implemented yet it says exactly that. There is no placeholder
 *     figure anywhere in this section — a wrong number that looks right is
 *     worse than an error.
 *  2. GOVERNANCE IS VISIBLE. Every source and every row carries its
 *     governance class and its training-export eligibility. Yiddish Labs
 *     derived rows say "serving only". Customer-private rows are counted,
 *     never read. A control that cannot legally run is DISABLED and carries
 *     the server's plain-English reason — never enabled-and-failing.
 *  3. ⛔ NO HEBREW-SCRIPT YIDDISH IS EVER WRITTEN BY US. Yiddish text only
 *     ever arrives from the API and is rendered through <YiddishText>, which
 *     sets dir="rtl" lang="yi" and a Hebrew-capable font stack. Every UI
 *     label in this section is English.
 *
 * The types below MIRROR apps/api/src/yiddishCorpus/contracts.ts. They are
 * copied rather than imported: the portal does not import across the api
 * boundary (same as every other portal page).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { ApiError, apiGet } from "../../../../services/apiClient";
import "./yiddish.css";

/* ═══════════════════ contract mirror (contracts.ts) ═══════════════════ */

export const YC_API_PREFIX = "/admin/yiddish";

export type YcGovernanceClass = "PLATFORM" | "CUSTOMER_PRIVATE" | "EXTERNAL";
export type YcTrainingEligibility = "UNKNOWN" | "ALLOWED" | "RESTRICTED" | "EXCLUDED";
export type YcAudioFetchMode = "DISABLED" | "OWNER_AUTHORIZED";
export type YcAllowedUse = "metadata_only" | "analysis" | "store_audio" | "training_export";
export type YcRightsState = "GRANTED" | "DENIED" | "UNKNOWN";
export type YcRunMode = "METADATA_ONLY" | "AUDIO_ONLY" | "SELECTIVE" | "FULL";

export interface YcGovernanceBadge {
  governanceClass: YcGovernanceClass;
  trainingExportEligibility: YcTrainingEligibility;
  contentAllowed: boolean;
  ylDerived: boolean;
  note?: string;
}

export interface YcEvidenceSupport {
  obs: number;
  speakers: number;
  sources: number;
}

export interface YcVariantScore {
  variantKey: string;
  realization: string | null;
  score: number;
  share: number;
  support: YcEvidenceSupport;
  effective: number;
  humanConfirmed: boolean;
  eligibleForRule: boolean;
  blockedReason: string | null;
}

export interface YcBudgetView {
  scope: string;
  apiCentsPerDay: number;
  transcriptionMinutesPerDay: number;
  storageBytesMax: string;
  concurrency: number;
  requestsPerMinute: number;
  mode: YcRunMode;
  paused: boolean;
  spentCentsToday: number;
  transcribedMinutesToday: number;
}

export interface YcSourceSummary {
  key: string;
  name: string;
  kind: string;
  adapterKey: string | null;
  governanceClass: YcGovernanceClass;
  trainingExportEligibility: YcTrainingEligibility;
  contentAllowed: boolean;
  audioFetchMode: YcAudioFetchMode;
  enabled: boolean;
  termsUrl: string | null;
  termsCheckedAt: string | null;
  rightsNote: string | null;
  itemCount: number;
  audioHours: number;
  transcriptCount: number;
  lastRunAt: string | null;
  budget: YcBudgetView | null;
  rights: { allowedUse: YcAllowedUse; state: YcRightsState; decidedBy: string | null; decidedAt: string }[];
  health: { probeKey: string; state: string; detail: string | null; checkedAt: string }[];
  /** Plain-English reason the audio stages cannot run, or null when they can. */
  audioBlockedReason: string | null;
}

export interface YcDashboardView {
  corpus: {
    items: number;
    audioHours: number;
    transcripts: number;
    translations: number;
    pairs: number;
    lexemes: number;
    observations: number;
    rules: number;
    openConflicts: number;
    speakerClusters: number;
    benchmarkCases: number;
    findings: number;
  };
  walled: { label: string; count: number; hours: number | null; note: string }[];
  sources: YcSourceSummary[];
  queue: { state: string; count: number }[];
  worker: { alive: boolean; lastTickAt: string | null; leasedJobs: number; note: string };
  profile: { key: string; version: number; status: string; meanRating: number | null; n: number } | null;
  series: { day: string; metric: string; value: number }[];
  recentFindings: { id: string; kind: string; statement: string; status: string; createdAt: string }[];
}

/** The engine's own plain-English refusals. Mirrored verbatim from contracts.ts
 *  so a screen still reads honestly when a payload omits its own copy. */
export const YC_CUSTOMER_WALL_MESSAGE =
  "Customer voicemails, calls and chats are counted, never read. Their content stays out " +
  "of the corpus, the review queue, benchmarks and every export until the owner records a basis.";

export const YC_YL_SERVING_ONLY_MESSAGE =
  "Yiddish Labs output is serving-only: it can inform spelling and meaning, and is excluded " +
  "from every training export.";

export const YIDDISH24_SOURCE_KEY = "yiddish24";

/* ═══════════════════ formatting (never invents a value) ═══════════════════ */

export function errText(e: any, fallback: string): string {
  return e?.body?.message || e?.body?.error || e?.body?.detail || e?.message || fallback;
}

/** A number the API gave us. `null`/`undefined` renders as an em dash, never 0. */
export function num(n: number | null | undefined): string {
  return n == null || Number.isNaN(Number(n)) ? "—" : Number(n).toLocaleString();
}

export function hours(h: number | null | undefined): string {
  if (h == null || Number.isNaN(Number(h))) return "—";
  const v = Number(h);
  return v >= 10 ? `${Math.round(v).toLocaleString()} h` : `${v.toFixed(1)} h`;
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${(Number(v) * 100).toFixed(digits)}%`;
}

export function money(cents: number | null | undefined): string {
  return cents == null ? "—" : `$${(Number(cents) / 100).toFixed(2)}`;
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime())
    ? String(d)
    : dt.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "—";
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ═══════════════════ data loading ═══════════════════ */

export type Loaded<T> = { data: T | null; error: ApiError | Error | null; loading: boolean; reload: () => void };

/**
 * One GET, honestly reported. There is no fallback value and no cached
 * placeholder: either the server answered, or the screen says what went wrong.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(path != null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path == null) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    apiGet<T>(path)
      .then((out) => {
        if (!live) return;
        setData(out);
        setError(null);
      })
      .catch((e) => {
        if (!live) return;
        setData(null);
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/** Accepts either a bare array or `{ <key>: [] }` — both shapes read honestly. */
export function listFrom<T>(payload: any, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const inner = payload?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

/* ═══════════════════ components ═══════════════════ */

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ylx-pagehead">
      <div>
        <h2>{title}</h2>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </div>
  );
}

export const YIDDISH_SECTION_PAGES: { href: string; label: string }[] = [
  { href: "/admin/yiddish-learning", label: "Dashboard" },
  { href: "/admin/yiddish-learning/corpus", label: "Corpus" },
  { href: "/admin/yiddish-learning/alignment", label: "Alignment" },
  { href: "/admin/yiddish-learning/review", label: "Review" },
  { href: "/admin/yiddish-learning/benchmark", label: "Benchmark" },
  { href: "/admin/yiddish-learning/progress", label: "Progress" },
  { href: "/admin/yiddish-learning/sources", label: "Sources" },
  { href: "/admin/yiddish-learning/export", label: "Export" },
  { href: "/admin/yiddish-learning/governance", label: "Governance" },
  { href: "/admin/yiddish-learning/yiddish24", label: "Yiddish24" },
  { href: "/admin/yiddish-learning/gold", label: "Gold set" },
];

export function SectionNav() {
  const pathname = usePathname();
  return (
    <nav className="subnav" aria-label="Yiddish Learning">
      {YIDDISH_SECTION_PAGES.map((p) => (
        <Link key={p.href} href={p.href} className={pathname === p.href ? "on" : ""}>
          {p.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * ⛔ THE ONLY PLACE YIDDISH TEXT IS RENDERED. The value must come from the
 * API; this component never supplies one of its own. Empty input renders an
 * em dash rather than an empty RTL box.
 */
export function YiddishText({ text, className, block }: { text: string | null | undefined; className?: string; block?: boolean }) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return <span className="dimtx">—</span>;
  return (
    <span dir="rtl" lang="yi" className={`yi${block ? " block" : ""}${className ? ` ${className}` : ""}`}>
      {value}
    </span>
  );
}

const GOV_CLASS: Record<string, string> = {
  PLATFORM: "platform",
  CUSTOMER_PRIVATE: "customer",
  EXTERNAL: "external",
};
const GOV_LABEL: Record<string, string> = {
  PLATFORM: "Platform",
  CUSTOMER_PRIVATE: "Customer-private",
  EXTERNAL: "External",
};

export function GovernanceChip({ value, title }: { value: string | null | undefined; title?: string }) {
  const key = String(value ?? "");
  return (
    <span className={`gov ${GOV_CLASS[key] ?? "unknown"}`} title={title ?? GOV_LABEL[key] ?? "Governance class not reported"}>
      {GOV_LABEL[key] ?? "Class unknown"}
    </span>
  );
}

const ELIG_CLASS: Record<string, string> = {
  ALLOWED: "allowed",
  RESTRICTED: "restricted",
  EXCLUDED: "excluded",
  UNKNOWN: "",
};
const ELIG_LABEL: Record<string, string> = {
  ALLOWED: "Training: allowed",
  RESTRICTED: "Training: restricted",
  EXCLUDED: "Training: excluded",
  UNKNOWN: "Training: unknown",
};

export function EligibilityChip({ value }: { value: string | null | undefined }) {
  const key = String(value ?? "UNKNOWN");
  return <span className={`elig ${ELIG_CLASS[key] ?? ""}`}>{ELIG_LABEL[key] ?? `Training: ${key.toLowerCase()}`}</span>;
}

/** The serving-only chip. Shown on every Yiddish Labs derived row. */
export function ServingOnlyChip({ note }: { note?: string | null }) {
  return (
    <span className="pill warn" title={note || YC_YL_SERVING_ONLY_MESSAGE}>
      Yiddish Labs output — serving only
    </span>
  );
}

/** Governance class + eligibility + (when YL-derived) the serving-only chip. */
export function GovernanceBadges({ badge }: { badge: Partial<YcGovernanceBadge> | null | undefined }) {
  if (!badge) return <span className="dimtx small">Governance not reported by the API</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <GovernanceChip value={badge.governanceClass} />
      <EligibilityChip value={badge.trainingExportEligibility} />
      {badge.ylDerived ? <ServingOnlyChip note={badge.note} /> : null}
      {badge.contentAllowed === false ? (
        <span className="pill bad" title={badge.note || YC_CUSTOMER_WALL_MESSAGE}>
          Content walled
        </span>
      ) : null}
    </span>
  );
}

export function Note({ note }: { note: { kind: "ok" | "bad"; text: string } | null }) {
  if (!note) return null;
  return <div className={`note ${note.kind}`}>{note.text}</div>;
}

export function LoadingCard({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="lcard" aria-busy="true" aria-label={label}>
      <div className="skel" style={{ height: 14, width: "38%", marginBottom: 10 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 30, marginBottom: 8 }} />
      ))}
    </div>
  );
}

/**
 * The honest failure state. A 404/501 says the route is not built yet; every
 * other status shows the server's own words. ⛔ It never substitutes a number.
 */
export function ErrorCard({ error, what, onRetry }: { error: unknown; what: string; onRetry?: () => void }) {
  const status = (error as ApiError)?.status;
  const notBuilt = status === 404 || status === 501;
  const msg = errText(error, "The request failed and the server sent no message.");
  return (
    <div className="lcard">
      <div className="state-box bad">
        <b className="t">{notBuilt ? `${what} — this endpoint is not implemented yet` : `${what} couldn't be loaded`}</b>
        <p>
          {notBuilt
            ? `The portal asked the engine for this and the server answered ${status}. Nothing is shown in its place — a figure here would be invented.`
            : msg}
        </p>
        <p className="small dimtx" style={{ marginTop: 6 }}>
          {status ? `HTTP ${status}` : "No response"} · {msg}
        </p>
        {onRetry ? (
          <div className="act">
            <button className="lbtn sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
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

/** loading → error → empty → content, in that order, for one loaded resource. */
export function Resource<T>({
  state,
  what,
  children,
  isEmpty,
  empty,
  skeletonRows,
}: {
  state: Loaded<T>;
  what: string;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeletonRows?: number;
}) {
  if (state.loading && state.data == null) return <LoadingCard rows={skeletonRows ?? 3} label={`Loading ${what}`} />;
  if (state.error) return <ErrorCard error={state.error} what={what} onRetry={state.reload} />;
  if (state.data == null) return <ErrorCard error={new Error("The server returned no body.")} what={what} onRetry={state.reload} />;
  if (isEmpty && isEmpty(state.data) && empty) return <>{empty}</>;
  return <>{children(state.data)}</>;
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "warn";
}) {
  return (
    <div className="kpi">
      <span className="lbl">{label}</span>
      <span className="val">{value}</span>
      {sub ? <span className={`sub${tone ? ` ${tone}` : ""}`}>{sub}</span> : null}
    </div>
  );
}

export function Card({
  title,
  sub,
  right,
  children,
  className,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`lcard${className ? ` ${className}` : ""}`}>
      {title || right ? (
        <div className="lcard-h">
          <div>
            {title ? <h3>{title}</h3> : null}
            {sub ? <div className="sub">{sub}</div> : null}
          </div>
          {right}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Tables always scroll inside their own container, never the page. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="twrap">{children}</div>;
}

export function Modal({
  title,
  onClose,
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="ylx-modal-back"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ylx-modal">
        <div className="mh">
          <h4>{title}</h4>
          <button className="mx" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mb">{children}</div>
        {footer ? <div className="mf">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * A control that the engine says cannot legally run. It is ALWAYS disabled,
 * and the server's reason is printed under it. ⛔ Never render one of these
 * enabled "so the user can find out" — that is enabled-and-failing.
 */
export function BlockedButton({ label, reason }: { label: string; reason: string }) {
  return (
    <div>
      <button className="lbtn" disabled title={reason} aria-disabled="true">
        {label}
      </button>
      <div className="blocked-why">⛔ {reason}</div>
    </div>
  );
}

/** The customer data wall card. Counts only — never content. */
export function CustomerWallCard({
  rows,
  note,
}: {
  rows: { label: string; count: number; hours: number | null; note: string }[];
  note?: string;
}) {
  return (
    <Card
      className="wall"
      title="⛔ Customer data wall"
      sub="Counted, never read"
      right={<span className="pill bad">Closed</span>}
    >
      {rows.length === 0 ? (
        <EmptyState
          title="The engine reported no walled sources"
          text="Nothing is being counted behind the wall right now. This is the API's answer, not a default."
        />
      ) : (
        <TableWrap>
          <table className="t">
            <thead>
              <tr>
                <th>Origin</th>
                <th className="num">Rows</th>
                <th className="num">Audio</th>
                <th>Why it is walled</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{num(r.count)}</td>
                  <td className="num">{r.hours == null ? "—" : hours(r.hours)}</td>
                  <td className="dimtx small">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <div className="wall-note">{note || YC_CUSTOMER_WALL_MESSAGE}</div>
    </Card>
  );
}

/** A simple magnitude bar list — proportions only, drawn from real values. */
export function Bars({
  rows,
}: {
  rows: { label: string; value: number; tone?: "warn" | "bad" | "dim"; display?: string }[];
}) {
  const max = rows.reduce((m, r) => Math.max(m, Number(r.value) || 0), 0);
  if (rows.length === 0) return <span className="dimtx small">Nothing to chart — the API returned no rows.</span>;
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div className="hbar" key={r.label}>
          <span className="dimtx">{r.label}</span>
          <span className="track">
            <i className={r.tone ?? ""} style={{ width: max > 0 ? `${Math.max(2, (Number(r.value) / max) * 100)}%` : "0%" }} />
          </span>
          <b>{r.display ?? num(r.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Page shell: the sub-nav + a consistent scope class. */
export function YiddishPage({ children }: { children: ReactNode }) {
  return (
    <div className="ylx">
      <SectionNav />
      {children}
    </div>
  );
}

/** Presentation-only gate; the real fences are the SUPER_ADMIN force line in
 *  navConfig and requireSuperAdmin on every /admin/yiddish route. */
export function OwnerOnlyNotice({ title }: { title: string }) {
  return (
    <div className="ylx">
      <PageHead title={title} subtitle="This page is for the platform owner." />
    </div>
  );
}
