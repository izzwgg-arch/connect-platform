export type MemberStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "CONTACTED"
  | "CALLBACK"
  | "CONVERTED"
  | "SKIPPED"
  | "DO_NOT_CALL";

export type QueueMember = {
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
    lastDispositionAt: string | null;
  } | null;
  campaign: {
    id: string;
    name: string;
    priority: string;
    scriptId: string | null;
    checklistId: string | null;
  } | null;
  status: MemberStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  callbackAt: string | null;
  callbackNote: string | null;
  sortOrder: number;
  createdAt?: string;
};

export type QueueCounts = {
  pending: number;
  due: number;
  overdue: number;
  upcoming: number;
};

export type QueueFilter = "pending" | "due" | "overdue" | "upcoming";

export type SortMode = "smart" | "original";

export type CampaignOption = { id: string; name: string; memberCount?: number };

export type QueueOperationalStats = {
  dispositionsToday: number;
  callsLinkedToday: number;
  queueRemaining: number;
  activeCampaigns: number;
  myOverdueCallbacks: number;
  myCallbacksDueToday: number;
  myTasksOverdue: number;
  myTasksDueToday: number;
  myOpen: number;
};
