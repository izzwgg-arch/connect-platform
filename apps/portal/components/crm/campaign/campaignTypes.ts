/** Phase 19E — shared campaign workspace types (portal UI only). */

export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
export type CampaignPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type MemberStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "CONTACTED"
  | "CALLBACK"
  | "CONVERTED"
  | "SKIPPED"
  | "DO_NOT_CALL";

export type CampaignListItem = {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  priority: CampaignPriority;
  scriptId: string | null;
  checklistId: string | null;
  createdAt: string;
  updatedAt: string;
  script: { id: string; name: string } | null;
  checklist: { id: string; name: string } | null;
  memberCount?: number;
};

export type CampaignDetail = CampaignListItem & {
  memberCount: number;
  statusCounts: Record<string, number>;
};

export type CampaignReportRow = {
  id: string;
  name: string;
  status: CampaignStatus;
  total: number;
  pending: number;
  contacted: number;
  callbacks: number;
  converted: number;
  dnc: number;
  conversionRate: number;
  totalAttempts: number;
  lastActivityAt: string;
  createdAt: string;
};

export type CampaignMember = {
  id: string;
  contactId: string;
  queueWorkEligible?: boolean;
  contact: {
    id: string;
    displayName: string;
    active?: boolean;
    archivedAt?: string | null;
    primaryPhone: string | null;
    primaryEmail: string | null;
    crmStage: string | null;
    lastActivityAt: string | null;
    lastDisposition: string | null;
  } | null;
  assignedTo: { id: string; displayName: string; email: string } | null;
  assignedToUserId: string | null;
  status: MemberStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  callbackAt: string | null;
  callbackNote: string | null;
  sortOrder: number;
  createdAt: string;
};

export type WorkloadRow = {
  userId: string | null;
  displayName: string;
  pending: number;
  inProgress: number;
  callbacks: number;
  contacted: number;
  converted: number;
  skipped: number;
  dnc: number;
  total: number;
};

export type CampaignImportHistoryRow = {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: string;
  fileName: string;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  createdBy: { id: string; displayName: string } | null;
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  ARCHIVED: "Archived",
};

export const CAMPAIGN_PRIORITY_LABELS: Record<CampaignPriority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

/** Dark-theme status chips — restrained operational accents (19E.3). */
export const CAMPAIGN_STATUS_CHIP: Record<CampaignStatus, string> = {
  DRAFT: "bg-crm-surface-2/90 text-crm-muted border-crm-border/90",
  ACTIVE: "bg-crm-accent/12 text-crm-accent border-crm-accent/35",
  PAUSED: "bg-crm-warning/12 text-crm-warning border-crm-warning/35",
  COMPLETED: "bg-crm-success/12 text-crm-success border-crm-success/35",
  ARCHIVED: "bg-crm-surface-2/80 text-crm-muted/75 border-crm-border/70",
};

/** Index row — dot + thin border, no oversized pill (19E.3). */
export const CAMPAIGN_STATUS_INDEX_CHIP: Record<CampaignStatus, string> = {
  DRAFT: "border-crm-border/80 bg-crm-surface-2/60 text-crm-muted",
  ACTIVE: "border-crm-accent/40 bg-crm-accent/8 text-crm-accent",
  PAUSED: "border-crm-warning/35 bg-crm-warning/8 text-crm-warning",
  COMPLETED: "border-crm-success/35 bg-crm-success/8 text-crm-success",
  ARCHIVED: "border-crm-border/70 bg-crm-surface-2/50 text-crm-muted/80",
};

export const CAMPAIGN_STATUS_DOT: Record<CampaignStatus, string> = {
  DRAFT: "bg-crm-muted/60",
  ACTIVE: "bg-crm-accent shadow-[0_0_6px_rgba(56,189,248,0.55)]",
  PAUSED: "bg-crm-warning",
  COMPLETED: "bg-crm-success",
  ARCHIVED: "bg-crm-muted/50",
};

export const CAMPAIGN_PRIORITY_CHIP: Record<CampaignPriority, string> = {
  LOW: "bg-crm-surface-2 text-crm-muted border-crm-border",
  NORMAL: "bg-crm-surface-2 text-crm-muted border-crm-border",
  HIGH: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  URGENT: "bg-crm-danger/15 text-crm-danger border-crm-danger/35",
};

export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  CONTACTED: "Contacted",
  CALLBACK: "Callback",
  CONVERTED: "Converted",
  SKIPPED: "Skipped",
  DO_NOT_CALL: "DNC",
};

export const MEMBER_STATUS_CHIP: Record<MemberStatus, string> = {
  PENDING: "bg-crm-surface-2 text-crm-muted border-crm-border",
  IN_PROGRESS: "bg-crm-accent/15 text-crm-accent border-crm-accent/30",
  CONTACTED: "bg-purple-500/15 text-purple-300 border-purple-500/25",
  CALLBACK: "bg-crm-warning/15 text-crm-warning border-crm-warning/35",
  CONVERTED: "bg-crm-success/15 text-crm-success border-crm-success/30",
  SKIPPED: "bg-crm-surface-2 text-crm-muted border-crm-border",
  DO_NOT_CALL: "bg-crm-danger/15 text-crm-danger border-crm-danger/35",
};

export const CAMPAIGN_IMPORT_STATUS_CHIP: Record<string, string> = {
  PENDING: "bg-crm-surface-2 text-crm-muted border-crm-border",
  PROCESSING: "bg-crm-accent/15 text-crm-accent border-crm-accent/30",
  DONE: "bg-crm-success/15 text-crm-success border-crm-success/30",
  PARTIAL: "bg-crm-warning/15 text-crm-warning border-crm-warning/35",
  FAILED: "bg-crm-danger/15 text-crm-danger border-crm-danger/35",
};
