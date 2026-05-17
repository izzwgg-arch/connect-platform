/** Phase 19K — CRM Reports Intelligence Workspace shared types */

export type DailyReport = {
  dispositionsToday: number;
  callsLinkedToday: number;
  contactsCreatedToday: number;
  tasksDueToday: number;
  overdueTasks: number;
  callbacksDueToday: number;
  overdueCallbacks: number;
  activeCampaigns: number;
  queueRemaining: number;
};

export type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total: number;
  pending: number;
  contacted: number;
  callbacks: number;
  converted: number;
  dnc: number;
  conversionRate: number;
  totalAttempts: number;
  lastActivityAt: string;
};

export type AgentRow = {
  userId: string;
  displayName: string;
  email: string;
  crmRole: string;
  assignedQueue: number;
  callbacksDueToday: number;
  dispositionsToday: number;
  convertedLast: number;
  openTasks: number;
  lookbackDays: number;
};

export type FollowUpMember = {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  campaign: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  callbackAt: string | null;
  callbackNote: string | null;
  attemptCount: number;
};

export type FollowUpTask = {
  id: string;
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  title: string;
  dueAt: string | null;
  priority: string;
  assignedTo: { id: string; name: string } | null;
};

export type FollowUpsReport = {
  callbacks: {
    overdue: { count: number; rows: FollowUpMember[] };
    dueToday: { count: number; rows: FollowUpMember[] };
    dueThisWeek: { count: number; rows: FollowUpMember[] };
  };
  tasks: {
    overdue: { count: number; rows: FollowUpTask[] };
    dueToday: { count: number; rows: FollowUpTask[] };
  };
};

export type ReportTab = "operations" | "campaigns" | "agents" | "follow-ups" | "intelligence";

export type HeroTone = "healthy" | "warn" | "danger" | "neutral";
