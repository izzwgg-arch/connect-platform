import type { CrmStage, CrmTask, TimelineEvent } from "../contact/contactTypes";

export type ScriptSummary = {
  id: string;
  name: string;
  isActive: boolean;
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
  items: ChecklistItem[];
};

export type LiveContact = {
  id: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  title?: string | null;
  crmStage?: CrmStage | null;
  doNotCall?: boolean;
  doNotSms?: boolean;
  active?: boolean;
  archivedAt?: string | null;
  phones?: { id: string; type: string; numberRaw: string; isPrimary: boolean }[];
  emails?: { id: string; type: string; email: string; isPrimary: boolean }[];
  primaryPhone?: { numberRaw: string } | null;
  primaryEmail?: { email: string } | null;
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
