export type CrmStage = "LEAD" | "CONTACTED" | "QUALIFIED" | "CUSTOMER" | "CLOSED_LOST";

export type AssignedUser = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  email: string;
};

export type ContactPhone = { id: string; type: string; numberRaw: string; isPrimary: boolean };
export type ContactEmail = { id: string; type: string; email: string; isPrimary: boolean };
export type ContactAddress = {
  id: string;
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
};
export type ContactTag = { id: string; name: string; color?: string | null };

export type CrmContactDetail = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  notes?: string | null;
  phones: ContactPhone[];
  emails: ContactEmail[];
  addresses?: ContactAddress[];
  tags?: ContactTag[];
  crmStage?: CrmStage | null;
  assignedTo?: AssignedUser | null;
  doNotCall: boolean;
  doNotSms: boolean;
  lastActivityAt?: string | null;
  lastDisposition?: string | null;
  lastDispositionAt?: string | null;
  timezoneIana?: string | null;
  timezoneLabel?: string | null;
  timezoneOffsetMinutes?: number | null;
  timezoneResolvedAt?: string | null;
  timezoneResolutionStatus?: "RESOLVED" | "NEEDS_REVIEW" | "MISSING_LOCATION" | null;
  createdAt: string;
  updatedAt: string;
  active?: boolean;
  archivedAt?: string | null;
};

export type TimelineEventType =
  | "CONTACT_CREATED"
  | "STAGE_CHANGED"
  | "NOTE_ADDED"
  | "NOTE_EDITED"
  | "CDR_INBOUND"
  | "CDR_OUTBOUND"
  | "TASK_CREATED"
  | "TASK_COMPLETED"
  | "TASK_CANCELED"
  | "CHECKLIST_COMPLETED"
  | "DISPOSITION_SET"
  | "CONTACT_MERGED"
  | "ASSIGNED_TO_USER"
  | "SMS_SENT"
  | "SMS_RECEIVED"
  | "VOICEMAIL_DROP";

export type TimelineEventCreatedBy = { id: string; displayName: string };

export type TimelineEvent = {
  id: string;
  type: TimelineEventType | string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  linkedId?: string | null;
  createdAt: string;
  createdBy?: TimelineEventCreatedBy | null;
};

export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskStatus = "OPEN" | "IN_PROGRESS" | "DONE" | "CANCELED";

export type CrmTask = {
  id: string;
  title: string;
  dueAt?: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  completedAt?: string | null;
  assignedTo?: { id: string; displayName: string } | null;
};

export type DuplicateContact = {
  id: string;
  displayName: string;
  company: string | null;
  crmStage: CrmStage | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  matchReasons: string[];
};

export type QueueContextMember = {
  id: string;
  contactId: string;
  status: string;
  attemptCount: number;
  callbackAt: string | null;
  callbackNote: string | null;
  campaign: { id: string; name: string; priority: string } | null;
};

export type NextStep = {
  title: string;
  detail: string;
  actionLabel?: string;
  action: "none" | "add_phone" | "scroll_tasks" | "scroll_notes" | "scroll_sms";
};
