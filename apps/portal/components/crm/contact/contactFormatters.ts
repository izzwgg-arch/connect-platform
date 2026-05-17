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

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  );
}

export function formatTimeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
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
  const d = new Date(iso);
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
