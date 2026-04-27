"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAppContext } from "../../../../hooks/useAppContext";
import { apiGet, apiPost, ApiError } from "../../../../services/apiClient";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

type DeployService = "api" | "portal" | "telephony" | "realtime" | "worker" | "full-stack";
type JobStatus = "queued" | "running" | "success" | "failed" | "cancelled";

type JobRow = {
  id: string;
  service: DeployService;
  branch: string;
  commitHash: string | null;
  deployedCommit: string | null;
  requestedBy: string;
  status: JobStatus;
  dryRun: boolean;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  duration: number | null;
  currentStage: string | null;
  skipReason: string | null;
  logPath: string | null;
  errorMessage: string | null;
};

type QueueStatus = {
  queuedCount: number;
  runningCount: number;
  maxQueued: number;
  runningJob: JobRow | null;
  targets: DeployService[];
  lock: { present: boolean; pid: number | null; pidAlive: boolean | null };
  version: { deployQueuePackage: string; repoHead: string | null };
};

type JobsResponse = { jobs: JobRow[] };
type JobResponse = { job: JobRow; logTail?: string | null };
type LogResponse = { id: string; lines: number; text: string };
type EnqueueResponse = { job: JobRow };

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS  (matches ops-center / call-flight palette)
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg: "#07111f",
  surface: "#0f1c2e",
  card: "#121f33",
  border: "#1e3352",
  borderLight: "#253d5e",
  text: "#e2e8f0",
  textMuted: "#64748b",
  textDim: "#334155",
  ok: "#22c55e",
  okBg: "#052e1633",
  okBorder: "#16653444",
  warn: "#f59e0b",
  warnBg: "#45200544",
  warnBorder: "#78350f55",
  crit: "#ef4444",
  critBg: "#45050544",
  critBorder: "#7f1d1d55",
  info: "#60a5fa",
  infoBg: "#0f2a4f44",
  infoBorder: "#1e40af44",
  blue: "#3b82f6",
  purple: "#a78bfa",
  teal: "#14b8a6",
  orange: "#fb923c",
  slate: "#64748b",
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const SERVICES: DeployService[] = ["api", "portal", "telephony", "realtime", "worker", "full-stack"];

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function fmtTs(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString();
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const STATUS_CONFIG: Record<JobStatus, { color: string; bg: string; border: string; label: string }> = {
  queued:    { color: C.info,   bg: C.infoBg,   border: C.infoBorder,   label: "QUEUED"    },
  running:   { color: C.warn,   bg: C.warnBg,   border: C.warnBorder,   label: "RUNNING"   },
  success:   { color: C.ok,     bg: C.okBg,     border: C.okBorder,     label: "SUCCESS"   },
  failed:    { color: C.crit,   bg: C.critBg,   border: C.critBorder,   label: "FAILED"    },
  cancelled: { color: C.slate,  bg: "#1e293b44", border: "#33415544",   label: "CANCELLED" },
};

function statusCfg(job: JobRow) {
  if (job.status === "success" && job.skipReason) {
    return { color: C.purple, bg: "#2e1a4744", border: "#6d28d955", label: "SKIPPED" };
  }
  return STATUS_CONFIG[job.status] ?? STATUS_CONFIG.cancelled;
}

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 12 }}>
      {children}
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px", ...style }}>
      {children}
    </div>
  );
}

function StatusPill({ job }: { job: JobRow }) {
  const cfg = statusCfg(job);
  const isRunning = job.status === "running";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 10, fontWeight: 700, color: cfg.color,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      padding: "3px 8px", borderRadius: 5, whiteSpace: "nowrap",
    }}>
      {isRunning && (
        <span style={{
          width: 6, height: 6, borderRadius: "50%", background: cfg.color,
          boxShadow: `0 0 6px ${cfg.color}`, flexShrink: 0,
          animation: "pulse 1.4s ease-in-out infinite",
        }} />
      )}
      {cfg.label}
      {job.skipReason && <span style={{ opacity: 0.75, fontWeight: 500 }}> ({job.skipReason.replace(/_/g, " ")})</span>}
    </span>
  );
}

function Btn({
  children, onClick, disabled, variant = "primary", small,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  small?: boolean;
}) {
  const bgs = {
    primary: C.blue,
    secondary: C.surface,
    danger: C.crit,
    ghost: "transparent",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: small ? "5px 12px" : "8px 18px",
        background: bgs[variant],
        border: `1px solid ${variant === "secondary" ? C.border : variant === "ghost" ? C.borderLight : "transparent"}`,
        borderRadius: 8,
        color: variant === "secondary" || variant === "ghost" ? C.textMuted : "#fff",
        fontSize: small ? 11 : 13,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {children}
    </button>
  );
}

function Input({ value, onChange, placeholder, style }: { value: string; onChange: (v: string) => void; placeholder?: string; style?: React.CSSProperties }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        color: C.text, padding: "9px 14px", fontSize: 13, outline: "none",
        width: "100%", boxSizing: "border-box", ...style,
      }}
    />
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        color: C.text, padding: "9px 14px", fontSize: 13, outline: "none",
        width: "100%", cursor: "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — HEADER
// ─────────────────────────────────────────────────────────────────────────────

function Header({
  status, loading, refreshing, lastUpdated, onRefresh,
}: {
  status: QueueStatus | null;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: string | null;
  onRefresh: () => void;
}) {
  const queueOnline = !!status;
  const healthColor = queueOnline ? C.ok : C.crit;
  const healthBg = queueOnline ? C.okBg : C.critBg;
  const healthLabel = queueOnline ? "Queue Healthy" : "Queue Offline";

  return (
    <div style={{
      padding: "14px 24px 12px",
      borderBottom: `1px solid ${C.border}`,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      flexWrap: "wrap", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ fontSize: 22 }}>🚀</span>
        <div>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: C.text }}>Deploy Center</h1>
          <div style={{ fontSize: 11, color: C.textMuted }}>
            Manage production deployments via the safe deploy queue · SUPER_ADMIN only
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {/* Health pill */}
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 11, fontWeight: 700, color: healthColor,
          background: healthBg, border: `1px solid ${healthColor}33`,
          padding: "5px 12px", borderRadius: 20, whiteSpace: "nowrap",
        }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: healthColor, boxShadow: `0 0 6px ${healthColor}88`, display: "block", flexShrink: 0 }} />
          {healthLabel}
        </span>

        {/* Running job indicator */}
        {status?.runningJob && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 11, fontWeight: 700, color: C.warn,
            background: C.warnBg, border: `1px solid ${C.warnBorder}`,
            padding: "5px 12px", borderRadius: 20, whiteSpace: "nowrap",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.warn, animation: "pulse 1.2s infinite", display: "block" }} />
            Deploying {status.runningJob.service} ({status.runningJob.currentStage ?? "running"})
          </span>
        )}

        {/* Version info */}
        {status && (
          <span style={{ fontSize: 11, color: C.textDim, fontFamily: "monospace" }}>
            v{status.version.deployQueuePackage}
            {status.version.repoHead && ` · ${status.version.repoHead}`}
          </span>
        )}

        {lastUpdated && <span style={{ fontSize: 11, color: C.textDim }}>Updated {lastUpdated}</span>}

        <Btn variant="secondary" small onClick={onRefresh} disabled={refreshing || loading}>
          {refreshing ? "…" : "↻ Refresh"}
        </Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — ENQUEUE CARD
// ─────────────────────────────────────────────────────────────────────────────

function EnqueueCard({
  onEnqueued, userEmail,
}: {
  onEnqueued: (job: JobRow) => void;
  userEmail: string;
}) {
  const [service, setService] = useState<DeployService>("portal");
  const [branch, setBranch] = useState("main");
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const isFullStack = service === "full-stack";
  const needsStrongConfirm = !dryRun && isFullStack;
  const canSubmit = needsStrongConfirm ? confirmText.trim() === "DEPLOY" : true;

  function handleServiceChange(v: string) {
    setService(v as DeployService);
    if (v === "full-stack") {
      setBranch("");
    } else {
      setBranch("main");
    }
    setConfirmText("");
    setShowConfirm(false);
    setError(null);
    setSuccess(null);
  }

  async function submit() {
    if (!branch.trim()) {
      setError(isFullStack ? "Tag is required for full-stack deploys." : "Branch is required.");
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await apiPost<EnqueueResponse>("/admin/deploy/enqueue", {
        service,
        branch: branch.trim(),
        dryRun,
        reason: "via Deploy Center UI",
      });
      onEnqueued(resp.job);
      setSuccess(`Job ${resp.job.id.slice(0, 8)}… queued for ${service}${dryRun ? " (dry run)" : ""}.`);
      setConfirmText("");
      setShowConfirm(false);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      if (msg.includes("duplicate_active_job_for_service")) {
        setError("Another deploy for this target is already queued or running.");
      } else if (msg.includes("queue_full")) {
        setError("The deploy queue is full. Wait for jobs to complete or cancel some.");
      } else {
        setError(msg || "Enqueue failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  function handleEnqueueClick() {
    if (needsStrongConfirm && !showConfirm) {
      setShowConfirm(true);
      return;
    }
    void submit();
  }

  return (
    <Card>
      <SectionLabel>Enqueue Deploy</SectionLabel>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {/* Row 1: target + branch */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
              Target Service
            </label>
            <Select
              value={service}
              onChange={handleServiceChange}
              options={SERVICES.map((s) => ({
                value: s,
                label: s === "full-stack" ? "full-stack (entire platform)" : s,
              }))}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>
              {isFullStack ? "Release Tag" : "Branch"}
            </label>
            <Input
              value={branch}
              onChange={setBranch}
              placeholder={isFullStack ? "e.g. v2.1.70" : "main"}
            />
          </div>
        </div>

        {/* Row 2: dry run toggle + requestedBy (read-only) */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <div
              onClick={() => { setDryRun((v) => !v); setShowConfirm(false); setConfirmText(""); }}
              style={{
                width: 40, height: 22, borderRadius: 11,
                background: dryRun ? C.blue : C.surface,
                border: `1px solid ${dryRun ? C.blue : C.border}`,
                position: "relative", cursor: "pointer", transition: "background 0.2s",
              }}
            >
              <div style={{
                position: "absolute", top: 2, left: dryRun ? 2 : 18,
                width: 16, height: 16, borderRadius: "50%",
                background: "#fff", transition: "left 0.2s",
              }} />
            </div>
            <span style={{ fontSize: 13, color: dryRun ? C.info : C.textMuted, fontWeight: 600 }}>
              {dryRun ? "Dry Run (safe — no changes)" : "Real Deploy"}
            </span>
          </label>
          <span style={{ fontSize: 11, color: C.textDim }}>
            as: <span style={{ color: C.textMuted, fontFamily: "monospace" }}>{userEmail}</span>
          </span>
        </div>

        {/* Safety warnings */}
        {!dryRun && !isFullStack && (
          <div style={{ background: C.warnBg, border: `1px solid ${C.warnBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.warn }}>
            ⚠ This will restart the <strong>{service}</strong> service. Ensure the branch is ready for production.
          </div>
        )}
        {!dryRun && isFullStack && (
          <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.crit }}>
            🔴 Full-stack deploys rebuild and restart <strong>all services</strong> and run Prisma migrations.
            This is a high-impact operation. Tag must exist on origin.
          </div>
        )}

        {/* Strong-confirm box for real full-stack */}
        {showConfirm && needsStrongConfirm && (
          <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, color: C.crit, fontWeight: 700, marginBottom: 10 }}>
              Type <code style={{ background: "#00000033", padding: "2px 6px", borderRadius: 4 }}>DEPLOY</code> to confirm full-stack deploy of <strong>{branch || "(no tag)"}</strong>
            </div>
            <Input
              value={confirmText}
              onChange={setConfirmText}
              placeholder="Type DEPLOY"
              style={{ fontFamily: "monospace", letterSpacing: "0.1em" }}
            />
          </div>
        )}

        {/* Feedback */}
        {error && (
          <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.crit }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{ background: C.okBg, border: `1px solid ${C.okBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.ok }}>
            ✓ {success}
          </div>
        )}

        {/* Submit */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn
            onClick={handleEnqueueClick}
            disabled={busy || !canSubmit}
            variant={dryRun ? "secondary" : "primary"}
          >
            {busy ? "Enqueueing…" : dryRun ? "▶ Dry Run" : "🚀 Deploy"}
          </Btn>
          {showConfirm && (
            <Btn variant="ghost" small onClick={() => { setShowConfirm(false); setConfirmText(""); }}>
              Cancel
            </Btn>
          )}
        </div>
      </div>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — QUEUE STATS ROW
// ─────────────────────────────────────────────────────────────────────────────

function QueueStatsRow({ status }: { status: QueueStatus }) {
  const lockOk = !status.lock.present || status.lock.pidAlive === false;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
      {[
        { label: "Queued", value: status.queuedCount, color: status.queuedCount > 0 ? C.info : C.text },
        { label: "Running", value: status.runningCount, color: status.runningCount > 0 ? C.warn : C.text },
        { label: "Max Queued", value: status.maxQueued, color: C.textMuted },
        { label: "Worker Lock", value: lockOk ? "Free" : "Held", color: lockOk ? C.ok : C.warn },
        { label: "Targets", value: status.targets.length, color: C.textMuted },
      ].map(({ label, value, color }) => (
        <div key={label} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — JOBS TABLE
// ─────────────────────────────────────────────────────────────────────────────

const TH_STYLE: React.CSSProperties = {
  textAlign: "left", padding: "8px 10px",
  fontSize: 10, color: C.textMuted,
  textTransform: "uppercase", letterSpacing: "0.06em",
  borderBottom: `1px solid ${C.border}`, fontWeight: 700,
  whiteSpace: "nowrap",
};
const TD_STYLE: React.CSSProperties = { padding: "9px 10px", verticalAlign: "middle" };

function JobsTable({
  jobs, onViewLog, onCancel, refreshing,
}: {
  jobs: JobRow[];
  onViewLog: (job: JobRow) => void;
  onCancel: (job: JobRow) => void;
  refreshing: boolean;
}) {
  if (jobs.length === 0) {
    return (
      <Card>
        <SectionLabel>Recent Jobs</SectionLabel>
        <div style={{ textAlign: "center", padding: "32px 0", color: C.textMuted, fontSize: 13 }}>
          No deploy jobs yet. Use the Enqueue Deploy card above.
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ padding: "18px 0" }}>
      <div style={{ padding: "0 20px 12px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.textMuted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          Recent Jobs
        </div>
        {refreshing && <span style={{ fontSize: 11, color: C.textDim }}>refreshing…</span>}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Service", "Branch / Tag", "Status", "Dry Run", "Requested By", "Queued", "Started", "Finished", "Duration", "Stage", "Skip Reason", "Deployed Commit", "Actions"].map((h) => (
                <th key={h} style={TH_STYLE}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.map((job, i) => (
              <JobRow
                key={job.id}
                job={job}
                even={i % 2 === 0}
                onViewLog={() => onViewLog(job)}
                onCancel={() => onCancel(job)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function JobRow({
  job, even, onViewLog, onCancel,
}: {
  job: JobRow;
  even: boolean;
  onViewLog: () => void;
  onCancel: () => void;
}) {
  const cfg = statusCfg(job);
  return (
    <tr style={{ background: even ? "transparent" : C.surface + "33" }}>
      <td style={{ ...TD_STYLE, fontWeight: 700, color: C.text, fontFamily: "monospace" }}>{job.service}</td>
      <td style={{ ...TD_STYLE, fontFamily: "monospace", color: C.textMuted, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {job.branch}
      </td>
      <td style={TD_STYLE}><StatusPill job={job} /></td>
      <td style={{ ...TD_STYLE, color: job.dryRun ? C.info : C.textDim }}>
        {job.dryRun ? "✓ Dry" : "—"}
      </td>
      <td style={{ ...TD_STYLE, color: C.textMuted, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {job.requestedBy}
      </td>
      <td style={{ ...TD_STYLE, color: C.textDim, whiteSpace: "nowrap" }}>{fmtAgo(job.queuedAt)}</td>
      <td style={{ ...TD_STYLE, color: C.textDim, whiteSpace: "nowrap", fontFamily: "monospace" }}>{fmtTs(job.startedAt)}</td>
      <td style={{ ...TD_STYLE, color: C.textDim, whiteSpace: "nowrap", fontFamily: "monospace" }}>{fmtTs(job.finishedAt)}</td>
      <td style={{ ...TD_STYLE, color: C.textMuted, whiteSpace: "nowrap" }}>{fmtDuration(job.duration)}</td>
      <td style={{ ...TD_STYLE, color: C.textDim, fontFamily: "monospace", whiteSpace: "nowrap" }}>
        {job.currentStage ?? "—"}
      </td>
      <td style={{ ...TD_STYLE, color: C.purple, fontFamily: "monospace", fontSize: 11 }}>
        {job.skipReason ? job.skipReason.replace(/_/g, " ") : "—"}
      </td>
      <td style={{ ...TD_STYLE, fontFamily: "monospace", color: C.textDim, fontSize: 11 }}>
        {job.deployedCommit ? job.deployedCommit.slice(0, 9) : "—"}
      </td>
      <td style={{ ...TD_STYLE, whiteSpace: "nowrap" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onViewLog}
            title="View log"
            style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, background: C.infoBg, border: `1px solid ${C.infoBorder}`, borderRadius: 6, color: C.info, cursor: "pointer" }}
          >
            Log
          </button>
          {job.status === "queued" && (
            <button
              onClick={onCancel}
              title="Cancel this job"
              style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 6, color: C.crit, cursor: "pointer" }}
            >
              Cancel
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — LOG DRAWER
// ─────────────────────────────────────────────────────────────────────────────

function LogDrawer({
  job, onClose,
}: {
  job: JobRow | null;
  onClose: () => void;
}) {
  const [logText, setLogText] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [lines, setLines] = useState(200);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = job?.status === "running" || job?.status === "queued";

  const fetchLog = useCallback(async (silent = false) => {
    if (!job) return;
    if (!silent) setLogLoading(true);
    setLogError(null);
    try {
      const resp = await apiGet<LogResponse>(`/admin/deploy/jobs/${job.id}/log?lines=${lines}`);
      setLogText(resp.text);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      if (msg.includes("log_not_available")) {
        setLogText("Log not yet available. Job may still be initialising.");
      } else {
        setLogError(msg);
      }
    } finally {
      setLogLoading(false);
    }
  }, [job, lines]);

  useEffect(() => {
    if (!job) return;
    void fetchLog();
    if (isRunning) {
      timerRef.current = setInterval(() => { void fetchLog(true); }, 3000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [job, fetchLog, isRunning]);

  async function copyLog() {
    if (!logText) return;
    try {
      await navigator.clipboard.writeText(logText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }

  if (!job) return null;

  const cfg = statusCfg(job);

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "#00000077", zIndex: 998 }}
      />
      {/* Drawer */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(760px, 90vw)",
        background: C.card, borderLeft: `1px solid ${C.border}`,
        zIndex: 999, display: "flex", flexDirection: "column",
        boxShadow: "-8px 0 40px #00000055",
      }}>
        {/* Drawer header */}
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 800, color: C.text, fontFamily: "monospace" }}>{job.service}</span>
              <StatusPill job={job} />
            </div>
            <div style={{ fontSize: 11, color: C.textMuted, fontFamily: "monospace" }}>
              {job.id.slice(0, 12)}… · branch: {job.branch}
              {job.dryRun && <span style={{ color: C.info, marginLeft: 8 }}>dry run</span>}
            </div>
            {isRunning && (
              <div style={{ fontSize: 11, color: C.warn, marginTop: 4 }}>
                ⚡ Auto-refreshing every 3 seconds…
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select
              value={lines}
              onChange={(e) => setLines(Number(e.target.value))}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.textMuted, padding: "5px 10px", fontSize: 11, cursor: "pointer" }}
            >
              {[100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>{n} lines</option>
              ))}
            </select>
            <button
              onClick={copyLog}
              disabled={!logText}
              style={{ padding: "5px 12px", fontSize: 11, fontWeight: 600, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: copied ? C.ok : C.textMuted, cursor: "pointer" }}
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button
              onClick={onClose}
              style={{ padding: "5px 12px", fontSize: 13, background: "transparent", border: "none", color: C.textMuted, cursor: "pointer" }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Error message */}
        {job.errorMessage && job.status === "failed" && (
          <div style={{ padding: "10px 20px", background: C.critBg, borderBottom: `1px solid ${C.critBorder}`, fontSize: 12, color: C.crit }}>
            <strong>Error:</strong> {job.errorMessage}
          </div>
        )}

        {/* Log body */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {logLoading && !logText && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textMuted, fontSize: 14 }}>
              Loading log…
            </div>
          )}
          {logError && (
            <div style={{ padding: 20, color: C.crit, fontSize: 12 }}>
              Failed to load log: {logError}
            </div>
          )}
          {logText != null && (
            <pre style={{
              margin: 0, height: "100%", overflowY: "auto",
              padding: "14px 20px",
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
              fontSize: 11.5, lineHeight: 1.65,
              color: C.text, background: "#070f1c",
              whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>
              {logText || "(log is empty)"}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: "8px 20px", borderTop: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 10, color: C.textDim }}>
            {job.currentStage && <>Stage: <span style={{ color: C.textMuted }}>{job.currentStage}</span> · </>}
            Duration: {fmtDuration(job.duration)}
            {job.skipReason && <> · Skip: <span style={{ color: C.purple }}>{job.skipReason}</span></>}
          </div>
          <Btn variant="ghost" small onClick={() => void fetchLog()}>↻ Reload</Btn>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function DeployCenterPage() {
  const { user } = useAppContext();
  const userEmail = user?.email ?? "unknown";

  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [logJob, setLogJob] = useState<JobRow | null>(null);

  const statusTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const jobsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async (silent = false) => {
    if (!silent) setLoadingStatus(true);
    else setRefreshing(true);
    setStatusError(null);
    try {
      const r = await apiGet<QueueStatus>("/admin/deploy/status");
      setStatus(r);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setStatusError(msg);
    } finally {
      setLoadingStatus(false);
      setRefreshing(false);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await apiGet<JobsResponse>("/admin/deploy/jobs?limit=50");
      setJobs(r.jobs);
    } catch {
      /* silently skip job refresh errors */
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchJobs();

    statusTimerRef.current = setInterval(() => { void fetchStatus(true); }, 5000);
    jobsTimerRef.current = setInterval(() => { void fetchJobs(); }, 5000);

    return () => {
      if (statusTimerRef.current) clearInterval(statusTimerRef.current);
      if (jobsTimerRef.current) clearInterval(jobsTimerRef.current);
    };
  }, [fetchStatus, fetchJobs]);

  function handleEnqueued(job: JobRow) {
    setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
    void fetchStatus(true);
  }

  async function handleCancel(job: JobRow) {
    setCancelError(null);
    try {
      await apiPost<{ ok: boolean }>(`/admin/deploy/jobs/${job.id}/cancel`);
      void fetchJobs();
      void fetchStatus(true);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : String(e);
      setCancelError(`Cancel failed: ${msg}`);
    }
  }

  function handleViewLog(job: JobRow) {
    setLogJob(job);
  }

  const pageStyle: React.CSSProperties = {
    minHeight: "100vh",
    background: C.bg,
    color: C.text,
    fontFamily: "'Inter', system-ui, sans-serif",
  };

  // Pulse animation keyframe (injected once)
  const pulseKeyframes = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
  `;

  if (loadingStatus && !status) {
    return (
      <PermissionGate permission="can_manage_deploys">
        <style>{pulseKeyframes}</style>
        <div style={{ ...pageStyle, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🚀</div>
            <div style={{ fontSize: 15, color: C.textMuted }}>Connecting to deploy queue…</div>
          </div>
        </div>
      </PermissionGate>
    );
  }

  const queueOffline = !status && !loadingStatus;

  return (
    <PermissionGate permission="can_manage_deploys">
      <style>{pulseKeyframes}</style>
      <div style={pageStyle}>
        <Header
          status={status}
          loading={loadingStatus}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
          onRefresh={() => { void fetchStatus(); void fetchJobs(); }}
        />

        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 20, maxWidth: 1400, margin: "0 auto" }}>
          {/* Queue offline banner */}
          {queueOffline && (
            <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.crit, marginBottom: 6 }}>Deploy queue is offline or unreachable</div>
              <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
                {statusError || "Could not connect to http://127.0.0.1:3910. Check that connect-deploy-worker is running (pm2 status)."}
              </div>
              <Btn onClick={() => { void fetchStatus(); }} variant="secondary" small>Retry</Btn>
            </div>
          )}

          {/* Status error (but may still have cached status) */}
          {statusError && status && (
            <div style={{ background: C.warnBg, border: `1px solid ${C.warnBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.warn }}>
              ⚠ Status refresh failed: {statusError}
            </div>
          )}

          {/* Cancel error */}
          {cancelError && (
            <div style={{ background: C.critBg, border: `1px solid ${C.critBorder}`, borderRadius: 8, padding: "10px 14px", fontSize: 12, color: C.crit }}>
              {cancelError}
              <button onClick={() => setCancelError(null)} style={{ marginLeft: 12, background: "none", border: "none", color: C.crit, cursor: "pointer", fontSize: 12 }}>✕</button>
            </div>
          )}

          {/* Row 1: Enqueue + Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.8fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
            <EnqueueCard onEnqueued={handleEnqueued} userEmail={userEmail} />

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {status && <QueueStatsRow status={status} />}
              {status && (
                <Card>
                  <SectionLabel>Queue Info</SectionLabel>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.textMuted }}>Targets</span>
                      <span style={{ color: C.text, fontFamily: "monospace", fontSize: 11 }}>{status.targets.join(", ")}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.textMuted }}>Worker Lock</span>
                      <span style={{ color: status.lock.present && status.lock.pidAlive ? C.warn : C.ok }}>
                        {status.lock.present
                          ? status.lock.pidAlive
                            ? `Held (PID ${status.lock.pid})`
                            : "Stale (will auto-clear)"
                          : "Free"}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: C.textMuted }}>Queue version</span>
                      <span style={{ color: C.text, fontFamily: "monospace", fontSize: 11 }}>v{status.version.deployQueuePackage}</span>
                    </div>
                    {status.version.repoHead && (
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span style={{ color: C.textMuted }}>Repo HEAD</span>
                        <span style={{ color: C.text, fontFamily: "monospace", fontSize: 11 }}>{status.version.repoHead}</span>
                      </div>
                    )}
                  </div>
                </Card>
              )}
            </div>
          </div>

          {/* Row 2: Jobs table */}
          <JobsTable
            jobs={jobs}
            onViewLog={handleViewLog}
            onCancel={handleCancel}
            refreshing={refreshing}
          />

          {/* Footer */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: `1px solid ${C.border}`, marginTop: 4, flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontSize: 11, color: C.textDim }}>
              Deploy Center · Polling every 5s · Token never leaves server · All actions audited ·{" "}
              <a href="/admin/ops-center" style={{ color: C.blue, textDecoration: "none" }}>Ops Center →</a>
            </div>
            <div style={{ fontSize: 11, color: C.textDim }}>
              Docs: <code style={{ fontSize: 10, color: C.textMuted }}>docs/safe-deploy-queue.md</code>
            </div>
          </div>
        </div>

        {/* Log drawer */}
        <LogDrawer job={logJob} onClose={() => setLogJob(null)} />
      </div>
    </PermissionGate>
  );
}
