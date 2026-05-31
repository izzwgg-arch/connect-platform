/** Pure helpers for CRM contact / campaign workspace layout and navigation. */

export const CRM_CONTACT_WORKSPACE_SCROLL_CLASSES = {
  left: "crm-contact-left-scroll",
  center: "crm-contact-center-scroll",
  rightRail: "crm-contact-right-rail-scroll",
  quickDispositionSlot: "crm-contact-quick-disposition-slot",
} as const;

export type ContactWorkspaceTab =
  | "timeline"
  | "script"
  | "checklist"
  | "email"
  | "sms"
  | "notes"
  | "files"
  | "discoveries"
  | "intelligence"
  | "tasks";

export type WorkspaceTabDef = {
  id: ContactWorkspaceTab;
  label: string;
  shortLabel?: string;
};

export const WORKSPACE_TABS: WorkspaceTabDef[] = [
  { id: "timeline", label: "Timeline", shortLabel: "Timeline" },
  { id: "script", label: "Script", shortLabel: "Script" },
  { id: "checklist", label: "Checklist", shortLabel: "Checklist" },
  { id: "email", label: "Email", shortLabel: "Email" },
  { id: "sms", label: "SMS", shortLabel: "SMS" },
  { id: "notes", label: "Notes", shortLabel: "Notes" },
  { id: "files", label: "Files", shortLabel: "Files" },
  { id: "discoveries", label: "Discoveries", shortLabel: "Docs" },
  { id: "intelligence", label: "AI Intelligence", shortLabel: "AI" },
  { id: "tasks", label: "Tasks", shortLabel: "Tasks" },
];

/** Primary tabs shown inline; remainder go in overflow menu (no horizontal scroll). */
export const WORKSPACE_PRIMARY_TAB_COUNT = 5;

export function splitWorkspaceTabs(
  tabs: WorkspaceTabDef[] = WORKSPACE_TABS,
  primaryCount = WORKSPACE_PRIMARY_TAB_COUNT,
): { primary: WorkspaceTabDef[]; overflow: WorkspaceTabDef[] } {
  const safeCount = Math.max(1, Math.min(primaryCount, tabs.length));
  return {
    primary: tabs.slice(0, safeCount),
    overflow: tabs.slice(safeCount),
  };
}

export function workspaceTabLabel(tab: ContactWorkspaceTab): string {
  return WORKSPACE_TABS.find((t) => t.id === tab)?.label ?? "Workspace";
}

export type CampaignNavMember = {
  id: string;
  contactId: string;
  sortOrder: number;
};

export function sortCampaignNavMembers<T extends CampaignNavMember>(members: T[]): T[] {
  return [...members].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function findCampaignMemberIndex(
  members: CampaignNavMember[],
  opts: { memberId?: string | null; contactId?: string | null },
): number {
  if (opts.memberId) {
    const byMember = members.findIndex((m) => m.id === opts.memberId);
    if (byMember >= 0) return byMember;
  }
  if (opts.contactId) {
    return members.findIndex((m) => m.contactId === opts.contactId);
  }
  return -1;
}

export function campaignLeadNeighbors(
  members: CampaignNavMember[],
  currentIndex: number,
): { previous: CampaignNavMember | null; next: CampaignNavMember | null; position: number; total: number } {
  const total = members.length;
  if (currentIndex < 0 || total === 0) {
    return { previous: null, next: null, position: 0, total };
  }
  return {
    previous: currentIndex > 0 ? members[currentIndex - 1]! : null,
    next: currentIndex < total - 1 ? members[currentIndex + 1]! : null,
    position: currentIndex + 1,
    total,
  };
}

export function buildCampaignContactHref(
  contactId: string,
  campaignId: string,
  memberId: string,
  returnTo?: string | null,
): string {
  const params = new URLSearchParams({
    campaignId,
    memberId,
  });
  if (returnTo) params.set("returnTo", returnTo);
  return `/crm/contacts/${encodeURIComponent(contactId)}?${params.toString()}`;
}

export type StartOutreachResult =
  | { ok: true; message: string }
  | { ok: false; message: string; reason: "archived" | "composer_unavailable" };

/** Validates start-outreach UX; parent switches tab and focuses composer. */
export function resolveStartOutreach(opts: {
  isArchived: boolean;
  composerMounted: boolean;
}): StartOutreachResult {
  if (opts.isArchived) {
    return { ok: false, reason: "archived", message: "Archived contacts are read-only." };
  }
  if (!opts.composerMounted) {
    return {
      ok: false,
      reason: "composer_unavailable",
      message: "Note composer is not available. Switch to the Notes tab and try again.",
    };
  }
  return { ok: true, message: "Ready to log your first outreach note." };
}

export type WorkspacePhone = {
  id: string;
  type: string;
  numberRaw: string;
  isPrimary: boolean;
  lastDisposition?: string | null;
  lastDispositionAt?: string | null;
  lastDispositionChannel?: string | null;
};

export type WorkspacePhoneWithDisposition = WorkspacePhone;

export type DispositionChannel = "CALL" | "SMS" | "EMAIL" | "VOICEMAIL_DROP";

const DISPOSITION_CHANNEL_LABELS: Record<DispositionChannel, string> = {
  CALL: "Call",
  SMS: "SMS",
  EMAIL: "Email",
  VOICEMAIL_DROP: "VM Drop",
};

export function dispositionChannelLabel(channel: string | null | undefined): string {
  if (!channel) return "";
  return DISPOSITION_CHANNEL_LABELS[channel as DispositionChannel] ?? channel.replace(/_/g, " ");
}

export function phoneDispositionSummary(phone: WorkspacePhoneWithDisposition): string | null {
  if (!phone.lastDisposition) return null;
  const channel = dispositionChannelLabel(phone.lastDispositionChannel);
  return channel ? `${phone.lastDisposition} · ${channel}` : phone.lastDisposition;
}

/** Auto-select sole phone; otherwise require explicit selection. */
export function resolveActiveDispositionPhone(
  phones: WorkspacePhone[],
  explicitPhoneId: string | null,
): WorkspacePhone | null {
  const available = phones.filter((p) => p.numberRaw.trim().length > 0);
  if (available.length === 0) return null;
  if (explicitPhoneId) {
    return available.find((p) => p.id === explicitPhoneId) ?? null;
  }
  if (available.length === 1) return available[0]!;
  const primary = available.find((p) => p.isPrimary);
  return primary ?? null;
}

export function applyPhoneActionToDispositionTarget(opts: {
  phones: WorkspacePhone[];
  phone: WorkspacePhone;
  channel: DispositionChannel;
}): { phoneId: string; channel: DispositionChannel } {
  return { phoneId: opts.phone.id, channel: opts.channel };
}

export const CRM_PHONE_TYPE_OPTIONS = [
  "MOBILE",
  "OFFICE",
  "DIRECT",
  "MAIN",
  "BILLING",
  "HOME",
  "CELL",
  "WORK",
  "OTHER",
] as const;

const PHONE_TYPE_LABELS: Record<string, string> = {
  MOBILE: "Mobile",
  OFFICE: "Office",
  DIRECT: "Direct",
  MAIN: "Main",
  BILLING: "Billing",
  HOME: "Home",
  CELL: "Cell",
  WORK: "Work",
  OTHER: "Other",
};

export function phoneTypeLabel(type: string | null | undefined): string {
  if (!type) return "Phone";
  return PHONE_TYPE_LABELS[type.toUpperCase()] ?? titleCasePhoneType(type);
}

function titleCasePhoneType(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase()) || "Phone";
}

export function phoneSummaryLabel(phone: WorkspacePhone): string {
  return `${phoneTypeLabel(phone.type)}${phone.isPrimary ? " · Primary" : ""}`;
}

export function phonePickerDisplay(phone: WorkspacePhone): {
  label: string;
  number: string;
  isPrimary: boolean;
} {
  return {
    label: phoneTypeLabel(phone.type),
    number: phone.numberRaw,
    isPrimary: phone.isPrimary,
  };
}

export type PhoneActionResolution =
  | { kind: "disabled" }
  | { kind: "execute"; phone: WorkspacePhone }
  | { kind: "pick"; phones: WorkspacePhone[] };

export function resolvePhoneAction(phones: WorkspacePhone[]): PhoneActionResolution {
  const available = phones.filter((phone) => phone.numberRaw.trim().length > 0);
  if (available.length === 0) return { kind: "disabled" };
  if (available.length === 1) return { kind: "execute", phone: available[0]! };
  return {
    kind: "pick",
    phones: [...available].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary)),
  };
}
