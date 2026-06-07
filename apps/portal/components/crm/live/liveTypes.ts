import type { CrmStage, CrmTask, TimelineEvent } from "../contact/contactTypes";

export type ScriptSummary = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault?: boolean;
};

export type Script = ScriptSummary & { body: string };

export type ChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  sortOrder: number;
};

export type Checklist = {
  id: string;
  name: string;
  isActive: boolean;
  isDefault?: boolean;
  items: ChecklistItem[];
};

export type LiveContact = {
  id: string;
  tenantId?: string | null;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  notes?: string | null;
  crmStage?: CrmStage | null;
  doNotCall?: boolean;
  doNotSms?: boolean;
  active?: boolean;
  archivedAt?: string | null;
  phones?: { id: string; type: string; numberRaw: string; isPrimary: boolean }[];
  emails?: { id: string; type: string; email: string; isPrimary: boolean }[];
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
  addresses?: { id?: string; street?: string | null; city?: string | null; state?: string | null; zip?: string | null; country?: string | null }[];
  tags?: { id: string; name: string; color?: string | null }[];
  assignedTo?: { id: string; firstName?: string | null; lastName?: string | null; displayName?: string | null; email?: string | null } | null;
  lastActivityAt?: string | null;
  lastDisposition?: string | null;
  lastDispositionAt?: string | null;
  timezoneLabel?: string | null;
  timezoneIana?: string | null;
  timezoneResolutionStatus?: string | null;
  isInCrm?: boolean;
};

export type LiveCallCurrentContext = {
  linkedId: string | null;
  fromNumber: string | null;
  fromName: string | null;
  toNumber: string | null;
  direction: string | null;
  disposition: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  durationSec: number | null;
  recordingAvailable: boolean;
};

export type LiveCallHistoryItem = {
  linkedId: string;
  fromNumber: string | null;
  fromName: string | null;
  toNumber: string | null;
  direction: string;
  disposition: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
  talkSec: number;
  recordingAvailable: boolean;
  summary: string | null;
  transcriptionSummary: string | null;
};

export type LiveWorkspaceFormRequest = {
  id: string;
  status: string;
  recipientEmail: string;
  expiresAt?: string | null;
  openedAt?: string | null;
  completedAt?: string | null;
  revokedAt?: string | null;
  createdAt: string;
  formTemplate?: { id: string; name: string; category?: string | null } | null;
};

export type LiveWorkspaceDocument = {
  id: string;
  originalFileName: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  status: string;
  matchConfidence?: string | null;
  importedAt?: string | null;
  textExtractionStatus?: string | null;
  textExtractedAt?: string | null;
  createdAt: string;
};

export type LiveWorkspaceChecklistResponse = {
  id: string;
  checklistId: string;
  checklistName: string;
  linkedId?: string | null;
  answers: Record<string, boolean>;
  createdAt: string;
};

export type LiveCallTranscript = {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED" | "UNAVAILABLE";
  provider: string;
  languageCode: string;
  transcript: string | null;
  summary: string | null;
  actionItems: Array<{ title: string; detail?: string | null; dueHint?: string | null }>;
  sentiment: string | null;
  intent: string | null;
  confidence: number | null;
  modelName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  updatedAt: string | null;
};

export type LiveWorkspaceContext = {
  matched: boolean;
  reason?: string;
  contact?: LiveContact;
  currentCall?: LiveCallCurrentContext;
  campaignContext?: {
    member: {
      id: string;
      status: string;
      attemptCount: number;
      lastAttemptAt?: string | null;
      callbackAt?: string | null;
      callbackNote?: string | null;
    };
    campaign: {
      id: string;
      name: string;
      status: string;
      priority?: string | null;
      scriptId?: string | null;
      checklistId?: string | null;
    };
  } | null;
  timeline?: TimelineEvent[];
  tasks?: CrmTask[];
  forms?: LiveWorkspaceFormRequest[];
  documents?: LiveWorkspaceDocument[];
  scripts?: { defaultScriptId: string | null; items: ScriptSummary[] };
  checklists?: { defaultChecklistId: string | null; items: Checklist[]; recentResponses: LiveWorkspaceChecklistResponse[] };
  callHistory?: LiveCallHistoryItem[];
  openItems?: {
    openTaskCount: number;
    pendingFormCount: number;
    pendingDocumentCount: number;
    latestChecklistResponse: LiveWorkspaceChecklistResponse | null;
  };
  aiCallIntelligence?: {
    transcriptionEnabled: boolean;
    transcriptAvailable: boolean;
    summaryAvailable: boolean;
    actionItemsAvailable: boolean;
    placeholder: string;
    transcript: LiveCallTranscript | null;
  };
};

export type { CrmStage, CrmTask, TimelineEvent };

export const DISPOSITION_OPTIONS = [
  "Answered",
  "No Answer",
  "Voicemail",
  "Callback",
  "Not Interested",
  "Closed",
] as const;
