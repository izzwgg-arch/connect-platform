import type { MemberStatus, QueueMember } from "./queueTypes";

export function isQueueMemberActionable(m: QueueMember): boolean {
  return m.queueWorkEligible !== false;
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function callbackTimeLabel(iso: string): { label: string; urgent: boolean } {
  const d = new Date(iso);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const absDiff = Math.abs(diff) / 1000;

  if (diff < -86400) return { label: `Overdue ${Math.floor(absDiff / 86400)}d`, urgent: true };
  if (diff < 0) {
    return {
      label: `Overdue ${Math.floor(absDiff / 3600)}h ${Math.floor((absDiff % 3600) / 60)}m`,
      urgent: true,
    };
  }
  if (diff < 3600) return { label: `Due in ${Math.floor(diff / 1000 / 60)}m`, urgent: false };
  if (diff < 86400) return { label: `Due in ${Math.floor(diff / 1000 / 3600)}h`, urgent: false };
  const dStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const tStr = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { label: `${dStr} at ${tStr}`, urgent: false };
}

export function priorityReason(member: QueueMember): string | null {
  if (member.status === "CALLBACK" && member.callbackAt) {
    const diff = new Date(member.callbackAt).getTime() - Date.now();
    if (diff < 0) return "Overdue callback";
    const hours = diff / 3_600_000;
    if (hours <= 24) return "Due today";
    return "Scheduled callback";
  }
  const cp = member.campaign?.priority ?? "NORMAL";
  if (member.attemptCount === 0) {
    if (cp === "URGENT") return "Urgent campaign · fresh lead";
    if (cp === "HIGH") return "High priority · fresh lead";
    return "Fresh lead, no attempts";
  }
  if (member.attemptCount <= 3) {
    if (cp === "URGENT") return "Urgent campaign · fewer attempts";
    if (cp === "HIGH") return "High priority · fewer attempts";
    return "Fewer attempts";
  }
  if (cp === "URGENT") return "Urgent campaign";
  if (cp === "HIGH") return "High priority campaign";
  return null;
}

export function assignedAgeLabel(member: QueueMember): string | null {
  if (!member.createdAt) return null;
  return `Assigned ${relativeTime(member.createdAt)}`;
}

export function memberPriorityTier(member: QueueMember): "high" | "medium" | "low" {
  if (member.status === "CALLBACK" && member.callbackAt) {
    const { urgent } = callbackTimeLabel(member.callbackAt);
    if (urgent) return "high";
    const diff = new Date(member.callbackAt).getTime() - Date.now();
    if (diff <= 86_400_000) return "medium";
  }
  if (member.attemptCount === 0 && (member.campaign?.priority === "URGENT" || member.campaign?.priority === "HIGH")) {
    return "medium";
  }
  return "low";
}

export const MEMBER_STATUS_COLORS: Record<MemberStatus, string> = {
  PENDING: "bg-crm-surface-2 text-crm-muted border border-crm-border/80",
  IN_PROGRESS: "bg-crm-accent/15 text-crm-accent border border-crm-accent/25",
  CONTACTED: "bg-purple-500/15 text-purple-300 border border-purple-500/25",
  CALLBACK: "bg-crm-warning/15 text-crm-warning border border-crm-warning/30",
  CONVERTED: "bg-crm-success/15 text-crm-success border border-crm-success/30",
  SKIPPED: "bg-crm-surface-2 text-crm-muted border border-crm-border/80",
  DO_NOT_CALL: "bg-crm-danger/15 text-crm-danger border border-crm-danger/30",
};

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In Progress",
  CONTACTED: "Contacted",
  CALLBACK: "Callback",
  CONVERTED: "Converted",
  SKIPPED: "Skipped",
  DO_NOT_CALL: "DNC",
};
