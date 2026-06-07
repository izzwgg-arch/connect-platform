import type { CrmStage } from "./contactTypes";

export const STAGE_OPTIONS: { value: CrmStage; label: string; color: string }[] = [
  { value: "LEAD", label: "Lead", color: "#6366f1" },
  { value: "CONTACTED", label: "Contacted", color: "#f59e0b" },
  { value: "QUALIFIED", label: "Qualified", color: "#10b981" },
  { value: "CUSTOMER", label: "Customer", color: "#3b82f6" },
  { value: "CLOSED_LOST", label: "Closed Lost", color: "#6b7280" },
];

export const TASK_PRIORITY_COLOR: Record<string, string> = {
  LOW: "#6b7280",
  MEDIUM: "#3b82f6",
  HIGH: "#f59e0b",
  URGENT: "#ef4444",
};

export function initials(name?: string | null): string {
  const s = (name ?? "").trim();
  if (!s) return "?";
  const letters = s
    .split(/\s+/)
    .map((p) => p && p[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || "?";
}

const AVATAR_GRADIENTS = [
  ["#6366f1", "#8b5cf6"],
  ["#0ea5e9", "#2563eb"],
  ["#06b6d4", "#14b8a6"],
  ["#10b981", "#22c55e"],
  ["#84cc16", "#16a34a"],
  ["#f59e0b", "#f97316"],
  ["#fb7185", "#e11d48"],
  ["#ec4899", "#a855f7"],
  ["#8b5cf6", "#3b82f6"],
  ["#14b8a6", "#0f766e"],
  ["#f43f5e", "#d946ef"],
  ["#64748b", "#475569"],
  ["#7c3aed", "#db2777"],
  ["#0891b2", "#4f46e5"],
  ["#ca8a04", "#ea580c"],
  ["#0d9488", "#65a30d"],
];

function avatarPaletteIndex(seed?: string | null): number {
  const source = (seed ?? "").trim().toLowerCase();
  if (!source) return 0;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return hash % AVATAR_GRADIENTS.length;
}

export function avatarGradient(seed?: string | null): string {
  const [from, to] = AVATAR_GRADIENTS[avatarPaletteIndex(seed)] ?? AVATAR_GRADIENTS[0]!;
  return `linear-gradient(135deg, ${from}, ${to})`;
}

export function formatDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso as any);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10) || "-";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso as any);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16) || "-";
  const ds = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const ts = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return ds + " " + ts;
}

export function formatTimeAgo(iso: string): string {
  if (!iso) return "unknown";
  const d = new Date(iso as any);
  if (isNaN(d.getTime())) return "unknown";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days}d ago` : formatDate(iso);
}

export function stageColor(stage: CrmStage): string {
  return STAGE_OPTIONS.find((s) => s.value === stage)?.color ?? "#6b7280";
}

export function stageLabel(stage: CrmStage): string {
  return STAGE_OPTIONS.find((s) => s.value === stage)?.label ?? stage;
}

export function ownerLabel(
  assignedTo: {
    displayName?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    email: string;
  } | null | undefined,
): string | null {
  if (!assignedTo) return null;
  return (
    assignedTo.displayName ||
    [assignedTo.firstName, assignedTo.lastName].filter(Boolean).join(" ") ||
    assignedTo.email
  );
}

export function callbackTimeLabel(iso: string): { label: string; urgent: boolean } {
  if (!iso) return { label: "-", urgent: false };
  const d = new Date(iso as any);
  if (isNaN(d.getTime())) return { label: String(iso), urgent: false };
  const diff = d.getTime() - Date.now();
  const absDiff = Math.abs(diff) / 1000;

  if (diff < -86400)
    return { label: `Overdue ${Math.floor(absDiff / 86400)}d`, urgent: true };
  if (diff < 0)
    return {
      label: `Overdue ${Math.floor(absDiff / 3600)}h`,
      urgent: true,
    };
  if (diff < 3600) return { label: `Due in ${Math.floor(diff / 60000)}m`, urgent: false };
  if (diff < 86400) return { label: `Due in ${Math.floor(diff / 3600000)}h`, urgent: false };
  const dStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const tStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { label: `${dStr} at ${tStr}`, urgent: false };
}
