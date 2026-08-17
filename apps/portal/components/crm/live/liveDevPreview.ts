import type { CrmTask, TimelineEvent } from "../contact/contactTypes";
import type { QueueCounts, QueueMember, QueueOperationalStats } from "../queue/queueTypes";
import type { LiveContact, Script, ScriptSummary } from "./liveTypes";

export const DEV_PREVIEW_CONTACT_ID = "dev-preview-contact-1";

export type DevPreviewLiveContact = LiveContact & {
  location?: string | null;
  city?: string | null;
  state?: string | null;
  lastActivityAt?: string | null;
  lastDisposition?: string | null;
  leadScore?: number | null;
  assignedTo?: { id: string; displayName: string; email: string } | null;
};

const previewNow = Date.now();

export const DEV_PREVIEW_CONTACT: DevPreviewLiveContact = {
  id: DEV_PREVIEW_CONTACT_ID,
  displayName: "Jordan Martinez",
  firstName: "Jordan",
  lastName: "Martinez",
  company: "Loopcom Demo Co LLC",
  title: "Operations Manager",
  crmStage: "QUALIFIED",
  doNotCall: false,
  active: true,
  primaryPhone: { numberRaw: "+1 (512) 555-0142" },
  phones: [{ id: "dev-preview-phone-1", type: "MOBILE", numberRaw: "+1 (512) 555-0142", isPrimary: true }],
  primaryEmail: { email: "jordan.martinez@connectdemo.com" },
  emails: [
    { id: "dev-preview-email-1", type: "WORK", email: "jordan.martinez@connectdemo.com", isPrimary: true },
  ],
  location: "Austin, TX",
  city: "Austin",
  state: "TX",
  lastActivityAt: new Date(previewNow - 2 * 3600000).toISOString(),
  lastDisposition: "Callback",
  leadScore: 82,
  assignedTo: { id: "dev-preview-agent", displayName: "You", email: "agent@connect.com" },
};

export const DEV_PREVIEW_CAMPAIGN = {
  id: "dev-preview-campaign-1",
  name: "Spring outbound follow-up",
  scriptId: "dev-preview-script-1",
};

export const DEV_PREVIEW_SCRIPT_SUMMARIES: ScriptSummary[] = [
  {
    id: "dev-preview-script-1",
    name: "Outbound qualification",
    isActive: true,
    isDefault: true,
  },
  {
    id: "dev-preview-script-2",
    name: "Callback warm open",
    isActive: true,
  },
];

export const DEV_PREVIEW_SCRIPT: Script = {
  ...DEV_PREVIEW_SCRIPT_SUMMARIES[0],
  body: `Opening:
Hi Jordan, this is [Agent Name] from Loopcom. I'm reaching out about the follow-up you requested on your business phone plan.

Need Discovery:
Before I share options, can you tell me how your team currently handles outbound callbacks and voicemail follow-up?

Value Proposition:
Connect gives reps one live workspace for calls, scripts, notes, disposition, and timeline — so nothing gets lost between ring and wrap-up.`,
};

export const DEV_PREVIEW_TASKS: CrmTask[] = [
  {
    id: "dev-preview-task-1",
    title: "Send pricing one-pager",
    dueAt: new Date(previewNow + 86400000).toISOString(),
    priority: "HIGH",
    status: "OPEN",
  },
  {
    id: "dev-preview-task-2",
    title: "Confirm decision-maker availability",
    dueAt: new Date(previewNow + 3 * 86400000).toISOString(),
    priority: "MEDIUM",
    status: "OPEN",
  },
  {
    id: "dev-preview-task-3",
    title: "Log competitor notes from last call",
    dueAt: null,
    priority: "LOW",
    status: "IN_PROGRESS",
  },
];

export const DEV_PREVIEW_TIMELINE: TimelineEvent[] = [
  {
    id: "dev-preview-event-1",
    type: "CDR_OUTBOUND",
    title: "Outbound call — 4m 12s",
    body: "Left voicemail about spring promo.",
    createdAt: new Date(previewNow - 45 * 60000).toISOString(),
  },
  {
    id: "dev-preview-event-2",
    type: "NOTE_ADDED",
    title: "Note added",
    body: "Interested in bundled SMS — asked for Thursday callback.",
    createdAt: new Date(previewNow - 2 * 3600000).toISOString(),
    createdBy: { id: "dev-preview-agent", displayName: "You" },
  },
  {
    id: "dev-preview-event-3",
    type: "SMS_SENT",
    title: "SMS sent",
    body: "Thanks for your time — I'll call back Thursday at 2pm CT.",
    createdAt: new Date(previewNow - 26 * 3600000).toISOString(),
  },
  {
    id: "dev-preview-event-4",
    type: "STAGE_CHANGED",
    title: "Stage changed to Qualified",
    body: "Moved from Contacted after discovery call.",
    createdAt: new Date(previewNow - 3 * 86400000).toISOString(),
  },
  {
    id: "dev-preview-event-5",
    type: "CDR_INBOUND",
    title: "Inbound call — 6m 48s",
    body: "Answered pricing questions about seat count.",
    createdAt: new Date(previewNow - 5 * 86400000).toISOString(),
  },
];

const QUEUE_CONTACTS = [
  { name: "Avery Chen", phone: "+1 (737) 555-0198", campaign: "Spring outbound follow-up", status: "PENDING" as const },
  { name: "Morgan Blake", phone: "+1 (512) 555-0171", campaign: "Renewal callbacks", status: "CALLBACK" as const },
  { name: "Riley Santos", phone: "+1 (210) 555-0134", campaign: "Spring outbound follow-up", status: "IN_PROGRESS" as const },
  { name: "Casey Nguyen", phone: "+1 (469) 555-0160", campaign: "Win-back list", status: "PENDING" as const },
];

export const DEV_PREVIEW_QUEUE_MEMBERS: QueueMember[] = QUEUE_CONTACTS.map((row, index) => ({
  id: `dev-preview-member-${index + 1}`,
  contactId: `dev-preview-queue-contact-${index + 1}`,
  contact: {
    id: `dev-preview-queue-contact-${index + 1}`,
    displayName: row.name,
    primaryPhone: row.phone,
    primaryEmail: null,
    crmStage: "LEAD",
    lastActivityAt: new Date(previewNow - (index + 1) * 3600000).toISOString(),
    lastDisposition: null,
    lastDispositionAt: null,
  },
  campaign: {
    id: `dev-preview-campaign-${index + 1}`,
    name: row.campaign,
    priority: "NORMAL",
    scriptId: "dev-preview-script-1",
    checklistId: null,
  },
  status: row.status,
  attemptCount: index,
  lastAttemptAt: index > 0 ? new Date(previewNow - index * 7200000).toISOString() : null,
  callbackAt: row.status === "CALLBACK" ? new Date(previewNow + 3600000).toISOString() : null,
  callbackNote: row.status === "CALLBACK" ? "Asked for afternoon callback" : null,
  sortOrder: index,
}));

export const DEV_PREVIEW_QUEUE_COUNTS: QueueCounts = {
  pending: 18,
  due: 6,
  overdue: 2,
  upcoming: 4,
};

export const DEV_PREVIEW_OP_STATS: QueueOperationalStats = {
  dispositionsToday: 14,
  callsLinkedToday: 22,
  queueRemaining: 18,
  activeCampaigns: 3,
  myOverdueCallbacks: 2,
  myCallbacksDueToday: 6,
  myTasksOverdue: 1,
  myTasksDueToday: 4,
  myOpen: 9,
};

export const DEV_PREVIEW_DAILY_REPORT = {
  dispositionsToday: 14,
  callsLinkedToday: 22,
  contactsCreatedToday: 3,
  activeCampaigns: 3,
  queueRemaining: 18,
};

export const DEV_PREVIEW_NOTE =
  "Interested in the spring promo — requested callback Thursday afternoon. Wants bundled SMS pricing.";

export const DEV_PREVIEW_PHONE = {
  regState: "registered",
  callState: "connected",
  muted: false,
  onHold: false,
  setMute: () => {},
  toggleHold: () => {},
  hangup: () => {},
  sendDtmf: () => {},
  transfer: () => {},
};

export function isLiveWorkspaceDevPreview(contactId: string | null): boolean {
  return process.env.NODE_ENV === "development" && !contactId;
}
