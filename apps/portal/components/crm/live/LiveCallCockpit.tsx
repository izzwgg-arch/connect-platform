"use client";

import Link from "next/link";
import type { RefObject, ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  FileText,
  FolderOpen,
  Mail,
  MessageSquare,
  Phone,
  Radio,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { ownerLabel, stageColor, stageLabel, formatTimeAgo, formatDate } from "../contact/contactFormatters";
import { LiveWorkspaceChecklistPanel } from "./LiveWorkspaceChecklistPanel";
import { LiveWorkspaceNotePanel } from "./LiveWorkspaceNotePanel";
import { LiveWorkspaceOutcomePanel } from "./LiveWorkspaceOutcomePanel";
import { LiveWorkspaceScriptPanel } from "./LiveWorkspaceScriptPanel";
import type {
  Checklist,
  CrmStage,
  CrmTask,
  LiveCallHistoryItem,
  LiveContact,
  LiveWorkspaceChecklistResponse,
  LiveWorkspaceContext,
  LiveWorkspaceDocument,
  LiveWorkspaceFormRequest,
  ScriptSummary,
  TimelineEvent,
} from "./liveTypes";

type PhoneStatus = {
  regState: string;
  callState: string;
};

type DailyReport = {
  dispositionsToday?: number;
  callsLinkedToday?: number;
  contactsCreatedToday?: number;
  activeCampaigns?: number;
  queueRemaining?: number;
};

export function LiveCallCockpit({
  contact,
  isArchived,
  primaryPhone,
  canCall,
  campaignName,
  memberId,
  linkedId,
  fromNumber,
  queueBackHref,
  noteRef,
  noteBody,
  setNoteBody,
  savingNote,
  noteSavedAt,
  onSaveNote,
  disposition,
  setDisposition,
  outcomeNote,
  setOutcomeNote,
  followUpOption,
  setFollowUpOption,
  followUpCustom,
  setFollowUpCustom,
  nextStage,
  setNextStage,
  savingOutcome,
  outcomeSaved,
  outcomeError,
  isPowerMode,
  onSaveOutcome,
  timeline,
  tasks,
  forms,
  documents,
  callHistory,
  checklists,
  recentChecklistResponses,
  defaultChecklistId,
  liveContext,
  scriptSummaries,
  campaignScriptId,
  queueMembers,
  queueCounts,
  opStats,
  dailyReport,
  phone,
  sipNotice,
  callerIdChecked,
  callerIdSelected,
  callerIdLoading,
  onCall,
  onOpenContact,
  onOpenEmail,
  onRefresh,
  isDevPreview = false,
}: {
  contact: LiveContact;
  isArchived: boolean;
  primaryPhone: string | null;
  canCall: boolean;
  campaignName: string | null;
  memberId: string | null;
  linkedId: string | null;
  fromNumber: string | null;
  queueBackHref: string | null;
  noteRef: RefObject<HTMLTextAreaElement>;
  noteBody: string;
  setNoteBody: (value: string) => void;
  savingNote: boolean;
  noteSavedAt: Date | null;
  onSaveNote: () => void;
  disposition: string;
  setDisposition: (value: string) => void;
  outcomeNote: string;
  setOutcomeNote: (value: string) => void;
  followUpOption: "" | "today" | "tomorrow" | "nextweek" | "custom";
  setFollowUpOption: (value: "" | "today" | "tomorrow" | "nextweek" | "custom") => void;
  followUpCustom: string;
  setFollowUpCustom: (value: string) => void;
  nextStage: CrmStage | "";
  setNextStage: (value: CrmStage | "") => void;
  savingOutcome: boolean;
  outcomeSaved: boolean;
  outcomeError: string;
  isPowerMode: boolean;
  onSaveOutcome: () => void;
  timeline: TimelineEvent[];
  tasks: CrmTask[];
  forms: LiveWorkspaceFormRequest[];
  documents: LiveWorkspaceDocument[];
  callHistory: LiveCallHistoryItem[];
  checklists: Checklist[];
  recentChecklistResponses: LiveWorkspaceChecklistResponse[];
  defaultChecklistId: string | null;
  liveContext: LiveWorkspaceContext | null;
  scriptSummaries: ScriptSummary[];
  campaignScriptId: string | null;
  queueMembers: Array<{ id: string; contactId: string; contact?: { displayName?: string | null; company?: string | null } | null; campaign?: { id: string; name?: string | null } | null; status?: string }>;
  queueCounts: { pending?: number; due?: number; overdue?: number; upcoming?: number } | null;
  opStats: { callsLinkedToday?: number; dispositionsToday?: number; queueRemaining?: number; myOpen?: number } | null;
  dailyReport: DailyReport | null;
  phone: PhoneStatus;
  sipNotice: string | null;
  callerIdChecked: boolean;
  callerIdSelected: string | null;
  callerIdLoading: boolean;
  onCall: () => void;
  onOpenContact: () => void;
  onOpenEmail: () => void;
  onRefresh?: () => void;
  isDevPreview?: boolean;
  previewScript?: unknown;
}) {
  const stage = (contact.crmStage ?? "LEAD") as CrmStage;
  const email = contact.primaryEmail?.email ?? contact.emails?.find((item) => item.isPrimary)?.email ?? null;
  const owner = contact.assignedTo
    ? ownerLabel({ ...contact.assignedTo, email: contact.assignedTo.email ?? "" }) ?? "Unassigned"
    : "Unassigned";
  const lastTouch = contact.lastActivityAt ? formatTimeAgo(contact.lastActivityAt) : "No activity yet";
  const lastDisposition = contact.lastDisposition ?? "Not set";
  const activeCall = phone.callState !== "idle" && phone.callState !== "ended";
  const callsToday = dailyReport?.callsLinkedToday ?? opStats?.callsLinkedToday ?? 0;
  const dispositionsToday = dailyReport?.dispositionsToday ?? opStats?.dispositionsToday ?? 0;
  const conversations = timeline.filter((event) => ["CDR_INBOUND", "CDR_OUTBOUND", "SMS_SENT", "SMS_RECEIVED", "EMAIL_SENT", "EMAIL_RECEIVED", "EMAIL_REPLY"].includes(event.type)).length;
  const relationshipHealth = deriveRelationshipHealth({ contact, tasks, forms, documents, timeline });
  const currentCall = liveContext?.currentCall ?? null;
  const defaultScriptId = campaignScriptId ?? liveContext?.scripts?.defaultScriptId ?? null;

  return (
    <div className="crm-live-cockpit flex flex-col gap-4">
      {isDevPreview ? (
        <div className="rounded-crm-lg border border-crm-accent/30 bg-crm-accent/10 px-4 py-2.5 text-sm text-crm-text">
          <strong className="font-semibold">Development preview</strong>
          <span className="text-crm-muted"> - populated layout for visual QA. Open a matched call/contact to use live data.</span>
        </div>
      ) : null}

      <section className="crm-live-hero overflow-hidden rounded-[1.4rem] border border-crm-border bg-crm-surface shadow-crm">
        <div className="relative p-4 sm:p-5 lg:p-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,rgba(56,189,248,0.12),transparent_34%),radial-gradient(circle_at_100%_0%,rgba(124,58,237,0.10),transparent_34%)]" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold", activeCall ? "bg-crm-success/15 text-crm-success" : "bg-crm-surface-2 text-crm-muted")}>
                  <span className={activeCall ? crm.statusDotLive : crm.statusDot} />
                  {activeCall ? "Active call" : "No active browser call"}
                </span>
                <span className="rounded-full px-2.5 py-1 text-xs font-bold" style={{ background: `${stageColor(stage)}22`, color: stageColor(stage) }}>
                  {stageLabel(stage)}
                </span>
                {campaignName ? <Pill icon={<BriefcaseBusiness className="h-3.5 w-3.5" />} label={campaignName} /> : null}
                {isArchived ? <Pill label="Archived" tone="danger" /> : null}
              </div>
              <h1 className="mt-3 text-2xl font-bold tracking-tight text-crm-text sm:text-3xl">{contact.displayName}</h1>
              <p className="mt-1 text-sm text-crm-muted">
                {[contact.title, contact.company].filter(Boolean).join(" · ") || "CRM contact"}
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-sm">
                <ContactChip icon={<Phone className="h-3.5 w-3.5" />} value={primaryPhone ?? fromNumber ?? "No phone"} mono />
                {email ? <ContactChip icon={<Mail className="h-3.5 w-3.5" />} value={email} /> : null}
                <ContactChip icon={<UserRound className="h-3.5 w-3.5" />} value={owner} />
                <ContactChip icon={<ShieldCheck className="h-3.5 w-3.5" />} value={relationshipHealth.label} tone={relationshipHealth.tone} />
              </div>
            </div>

            <div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:min-w-[12rem] lg:flex-col">
              <button type="button" onClick={onOpenContact} className={cn(crm.btnSecondary, "justify-center")}>
                Open contact
              </button>
              <button type="button" onClick={onOpenEmail} disabled={!email} className={cn(crm.btnGhost, "justify-center")}>
                Email history
              </button>
              {!activeCall && canCall ? (
                <button type="button" onClick={onCall} disabled={callerIdLoading || isArchived} className={cn(crm.btnPrimary, "justify-center")}>
                  {callerIdLoading ? "Preparing call..." : "Start call"}
                </button>
              ) : null}
            </div>
          </div>

          {sipNotice ? (
            <div className="relative mt-4 flex items-center gap-2 rounded-crm border border-crm-warning/35 bg-crm-warning/10 px-3 py-2 text-xs text-crm-warning">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {sipNotice}
            </div>
          ) : null}
          {callerIdChecked ? (
            <p className="relative mt-3 text-xs text-crm-muted">{callerIdSelected ? `Local presence: ${callerIdSelected}` : "Default caller ID"}</p>
          ) : null}
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiCard icon={<Radio className="h-4 w-4" />} label="Call status" value={activeCall ? "Live" : "Ready"} detail={currentCall?.linkedId ?? linkedId ?? "No linked id"} />
        <KpiCard icon={<Activity className="h-4 w-4" />} label="Calls today" value={String(callsToday)} detail="CRM linked" />
        <KpiCard icon={<CheckCircle2 className="h-4 w-4" />} label="Dispositions" value={String(dispositionsToday)} detail="Today" />
        <KpiCard icon={<MessageSquare className="h-4 w-4" />} label="Conversation" value={String(conversations)} detail="Timeline items" />
        <KpiCard icon={<ClipboardList className="h-4 w-4" />} label="Open items" value={String(tasks.length + forms.filter((f) => ["SENT", "OPENED"].includes(f.status)).length + documents.filter((d) => d.status !== "IMPORTED").length)} detail="Tasks/forms/files" />
        <KpiCard icon={<BarChart3 className="h-4 w-4" />} label="Last touch" value={lastTouch} detail={lastDisposition} />
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,430px)]">
        <main className="min-w-0 space-y-4">
          <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <ContactSnapshot contact={contact} stage={stage} owner={owner} lastTouch={lastTouch} lastDisposition={lastDisposition} campaignName={campaignName} relationshipHealth={relationshipHealth.label} currentCall={currentCall} memberId={memberId} />
            <OpenItemsCard tasks={tasks} forms={forms} documents={documents} recentChecklistResponses={recentChecklistResponses} defaultChecklistId={defaultChecklistId} />
          </div>

          <LiveWorkspaceNotePanel
            ref={noteRef}
            noteBody={noteBody}
            setNoteBody={setNoteBody}
            savingNote={savingNote}
            noteSavedAt={noteSavedAt}
            onSave={onSaveNote}
            disabled={isArchived}
          />

          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <TimelineCard timeline={timeline} />
            <CallHistoryCard callHistory={callHistory} timeline={timeline} />
          </div>

          <QueueCard queueMembers={queueMembers} queueCounts={queueCounts} queueBackHref={queueBackHref} />
        </main>

        <aside className="min-w-0 space-y-4">
          <LiveWorkspaceScriptPanel scriptSummaries={scriptSummaries} defaultScriptId={defaultScriptId} />
          <LiveWorkspaceChecklistPanel
            checklists={checklists}
            contactId={contact.id}
            linkedId={linkedId}
            defaultChecklistId={defaultChecklistId}
            onSaved={onRefresh ?? (() => window.dispatchEvent(new CustomEvent("crm:live-checklist-saved")))}
          />
          <LiveWorkspaceOutcomePanel
            contact={contact}
            disposition={disposition}
            setDisposition={setDisposition}
            outcomeNote={outcomeNote}
            setOutcomeNote={setOutcomeNote}
            followUpOption={followUpOption}
            setFollowUpOption={setFollowUpOption}
            followUpCustom={followUpCustom}
            setFollowUpCustom={setFollowUpCustom}
            nextStage={nextStage}
            setNextStage={setNextStage}
            savingOutcome={savingOutcome}
            outcomeSaved={outcomeSaved}
            outcomeError={outcomeError}
            isPowerMode={isPowerMode}
            onSave={onSaveOutcome}
            disabled={isArchived}
          />
          <AiCallIntelligenceCard context={liveContext} />
        </aside>
      </div>
    </div>
  );
}

function ContactSnapshot({
  contact,
  stage,
  owner,
  lastTouch,
  lastDisposition,
  campaignName,
  relationshipHealth,
  currentCall,
  memberId,
}: {
  contact: LiveContact;
  stage: CrmStage;
  owner: string;
  lastTouch: string;
  lastDisposition: string;
  campaignName: string | null;
  relationshipHealth: string;
  currentCall: LiveWorkspaceContext["currentCall"] | null;
  memberId: string | null;
}) {
  const address = contact.addresses?.[0];
  const location = [address?.city, address?.state].filter(Boolean).join(", ") || contact.timezoneLabel || "Unknown";
  const source = campaignName ?? (memberId ? "Queue" : currentCall?.linkedId ? "Screen pop" : "Contact");
  return (
    <CRMCard padding="md">
      <CRMSection title="Contact snapshot" description="CRM context for this caller.">
        <dl className="grid grid-cols-2 gap-2">
          <SnapshotRow label="Company" value={contact.company ?? "Not set"} />
          <SnapshotRow label="Stage" value={stageLabel(stage)} />
          <SnapshotRow label="Owner" value={owner} />
          <SnapshotRow label="Campaign/source" value={source} />
          <SnapshotRow label="Relationship" value={relationshipHealth} />
          <SnapshotRow label="Last touch" value={lastTouch} />
          <SnapshotRow label="Last disposition" value={lastDisposition} />
          <SnapshotRow label="Location" value={location} />
        </dl>
      </CRMSection>
    </CRMCard>
  );
}

function OpenItemsCard({
  tasks,
  forms,
  documents,
  recentChecklistResponses,
  defaultChecklistId,
}: {
  tasks: CrmTask[];
  forms: LiveWorkspaceFormRequest[];
  documents: LiveWorkspaceDocument[];
  recentChecklistResponses: LiveWorkspaceChecklistResponse[];
  defaultChecklistId: string | null;
}) {
  const pendingForms = forms.filter((form) => ["SENT", "OPENED"].includes(form.status));
  const pendingDocuments = documents.filter((doc) => doc.status !== "IMPORTED" && doc.status !== "REJECTED");
  const checklist = defaultChecklistId
    ? recentChecklistResponses.find((response) => response.checklistId === defaultChecklistId)
    : recentChecklistResponses[0];
  return (
    <CRMCard padding="md">
      <CRMSection title="Open items" description="Work still attached to this contact.">
        <div className="grid grid-cols-2 gap-2">
          <MiniMetric icon={<CalendarClock className="h-4 w-4" />} label="Open tasks" value={tasks.length} />
          <MiniMetric icon={<FileText className="h-4 w-4" />} label="Pending forms" value={pendingForms.length} />
          <MiniMetric icon={<FolderOpen className="h-4 w-4" />} label="Pending files" value={pendingDocuments.length} />
          <MiniMetric icon={<ClipboardList className="h-4 w-4" />} label="Checklist" value={checklist ? checkedCount(checklist.answers) : 0} suffix={checklist ? " checked" : " none"} />
        </div>
        <div className="mt-3 space-y-2">
          {tasks.slice(0, 3).map((task) => (
            <div key={task.id} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/50 px-3 py-2">
              <p className="truncate text-sm font-semibold text-crm-text">{task.title}</p>
              <p className="text-xs text-crm-muted">{task.dueAt ? `Due ${formatDate(task.dueAt)}` : task.priority}</p>
            </div>
          ))}
          {pendingForms.slice(0, 2).map((form) => (
            <div key={form.id} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/50 px-3 py-2 text-sm text-crm-text">
              {form.formTemplate?.name ?? "Form request"} <span className="text-xs text-crm-muted">({form.status})</span>
            </div>
          ))}
        </div>
      </CRMSection>
    </CRMCard>
  );
}

function TimelineCard({ timeline }: { timeline: TimelineEvent[] }) {
  return (
    <CRMCard padding="md">
      <CRMSection title="Recent activity" description="Calls, SMS, email, forms, notes, files, and tasks.">
        {timeline.length === 0 ? (
          <p className="text-sm text-crm-muted">No CRM activity yet.</p>
        ) : (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {timeline.slice(0, 16).map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </div>
        )}
      </CRMSection>
    </CRMCard>
  );
}

function CallHistoryCard({ callHistory, timeline }: { callHistory: LiveCallHistoryItem[]; timeline: TimelineEvent[] }) {
  const timelineCalls = timeline.filter((event) => event.type === "CDR_INBOUND" || event.type === "CDR_OUTBOUND");
  return (
    <CRMCard padding="md">
      <CRMSection title="Call history" description="Previous calls and outcomes for this contact.">
        {callHistory.length === 0 && timelineCalls.length === 0 ? (
          <p className="text-sm text-crm-muted">No previous call history found.</p>
        ) : (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
            {callHistory.slice(0, 8).map((call) => (
              <div key={call.linkedId} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-crm-text">{call.direction === "outgoing" ? "Outbound" : "Inbound"} · {call.disposition}</p>
                  <span className="text-xs text-crm-muted">{formatDuration(call.durationSec)}</span>
                </div>
                <p className="mt-1 text-xs text-crm-muted">{formatDate(call.startedAt)} · {call.fromNumber ?? "Unknown"}{" -> "}{call.toNumber ?? "Unknown"}</p>
                <p className="mt-1 text-xs text-crm-muted">{call.transcriptionSummary ?? call.summary ?? "No transcript summary available."}</p>
              </div>
            ))}
            {callHistory.length === 0 && timelineCalls.slice(0, 8).map((event) => <ActivityRow key={event.id} event={event} />)}
          </div>
        )}
      </CRMSection>
    </CRMCard>
  );
}

function QueueCard({
  queueMembers,
  queueCounts,
  queueBackHref,
}: {
  queueMembers: Array<{ id: string; contactId: string; contact?: { displayName?: string | null; company?: string | null } | null; campaign?: { id: string; name?: string | null } | null; status?: string }>;
  queueCounts: { pending?: number; due?: number; overdue?: number; upcoming?: number } | null;
  queueBackHref: string | null;
}) {
  return (
    <CRMCard padding="md">
      <CRMSection title="Compact queue" description="Nearby leads and callbacks without leaving the call.">
        <div className="mb-3 flex flex-wrap gap-2">
          <Pill label={`Pending ${queueCounts?.pending ?? 0}`} />
          <Pill label={`Due ${queueCounts?.due ?? 0}`} />
          <Pill label={`Overdue ${queueCounts?.overdue ?? 0}`} tone={(queueCounts?.overdue ?? 0) > 0 ? "danger" : "default"} />
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {queueMembers.slice(0, 4).map((member) => (
            <Link key={member.id} href={`/crm/live-call?contactId=${member.contactId}&memberId=${member.id}&campaignId=${member.campaign?.id ?? ""}&returnTo=/crm/queue`} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2 hover:border-crm-accent/35">
              <p className="truncate text-sm font-semibold text-crm-text">{member.contact?.displayName ?? "Contact"}</p>
              <p className="truncate text-xs text-crm-muted">{member.contact?.company ?? member.campaign?.name ?? member.status ?? "Queue"}</p>
            </Link>
          ))}
        </div>
        {queueBackHref ? (
          <Link href={queueBackHref} className={cn(crm.btnGhost, "mt-3 w-full justify-center text-xs")}>
            Return to queue
          </Link>
        ) : null}
      </CRMSection>
    </CRMCard>
  );
}

function AiCallIntelligenceCard({ context }: { context: LiveWorkspaceContext | null }) {
  const ai = context?.aiCallIntelligence;
  const transcript = ai?.transcript ?? null;
  const status = transcript?.status ?? (ai?.transcriptionEnabled ? "WAITING" : "DISABLED");
  const statusLabel =
    status === "COMPLETED"
      ? "Transcript ready"
      : status === "PROCESSING"
        ? "Processing recording"
        : status === "QUEUED"
          ? "Queued"
          : status === "FAILED"
            ? "Transcription failed"
            : status === "UNAVAILABLE"
              ? "Transcript unavailable"
              : ai?.transcriptionEnabled
                ? "Waiting for recording"
                : "Transcription not enabled";
  return (
    <CRMCard padding="md">
      <CRMSection title="AI call intelligence" description="Transcript, summary, actions, sentiment, and intent when supported.">
        <div className="space-y-3">
          <div className="rounded-crm border border-crm-border bg-crm-surface-2/45 px-3 py-3 text-sm text-crm-muted">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 font-semibold text-crm-text">
                <Sparkles className="h-4 w-4 text-crm-accent" />
                {statusLabel}
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", status === "COMPLETED" ? "bg-crm-success/15 text-crm-success" : status === "FAILED" || status === "UNAVAILABLE" ? "bg-crm-danger/10 text-crm-danger" : "bg-crm-accent/10 text-crm-accent")}>
                {status}
              </span>
            </div>
            <p>{transcript?.errorMessage ?? ai?.placeholder ?? "Transcript will appear here after the recorded call is processed."}</p>
            {transcript?.updatedAt ? (
              <p className="mt-2 text-xs text-crm-muted">Updated {formatTimeAgo(transcript.updatedAt)}</p>
            ) : null}
          </div>

          {transcript?.summary ? (
            <div className="rounded-crm border border-crm-border bg-crm-surface px-3 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-crm-muted">Summary</p>
              <p className="mt-1 text-sm leading-relaxed text-crm-text">{transcript.summary}</p>
            </div>
          ) : null}

          {transcript?.actionItems?.length ? (
            <div className="rounded-crm border border-crm-border bg-crm-surface px-3 py-3">
              <p className="text-xs font-bold uppercase tracking-wider text-crm-muted">Action items</p>
              <ul className="mt-2 space-y-2">
                {transcript.actionItems.map((item, index) => (
                  <li key={`${item.title}-${index}`} className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-2.5 py-2">
                    <p className="text-sm font-semibold text-crm-text">{item.title}</p>
                    {item.detail || item.dueHint ? (
                      <p className="mt-1 text-xs text-crm-muted">{[item.detail, item.dueHint].filter(Boolean).join(" · ")}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {transcript?.transcript ? (
            <details className="rounded-crm border border-crm-border bg-crm-surface px-3 py-3">
              <summary className="cursor-pointer text-sm font-semibold text-crm-text">Transcript</summary>
              <pre className="mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-crm-muted">
                {transcript.transcript}
              </pre>
            </details>
          ) : null}
        </div>
      </CRMSection>
    </CRMCard>
  );
}

function KpiCard({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-crm-lg border border-crm-border bg-crm-surface px-3 py-3 shadow-crm">
      <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-crm-muted">
        {icon}
        {label}
      </div>
      <p className="mt-2 truncate text-xl font-bold text-crm-text">{value}</p>
      <p className="mt-1 truncate text-xs text-crm-muted">{detail}</p>
    </div>
  );
}

function SnapshotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2">
      <dt className="text-[10px] font-bold uppercase tracking-wider text-crm-muted">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-crm-text">{value}</dd>
    </div>
  );
}

function MiniMetric({ icon, label, value, suffix = "" }: { icon: ReactNode; label: string; value: number; suffix?: string }) {
  return (
    <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-crm-muted">{icon}{label}</div>
      <p className="mt-1 text-lg font-bold text-crm-text">{value}<span className="text-xs font-medium text-crm-muted">{suffix}</span></p>
    </div>
  );
}

function ActivityRow({ event }: { event: TimelineEvent }) {
  return (
    <div className="rounded-crm border border-crm-border/70 bg-crm-surface-2/45 px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-crm-text">{event.title}</p>
        <span className="shrink-0 text-xs text-crm-muted">{formatTimeAgo(event.createdAt)}</span>
      </div>
      <p className="mt-1 text-[11px] font-bold uppercase tracking-wider text-crm-muted">{event.type.replaceAll("_", " ")}</p>
      {event.body ? <p className="mt-1 line-clamp-2 text-xs text-crm-muted">{event.body}</p> : null}
    </div>
  );
}

function Pill({ icon, label, tone = "default" }: { icon?: ReactNode; label: string; tone?: "default" | "danger" }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", tone === "danger" ? "border-crm-danger/35 bg-crm-danger/10 text-crm-danger" : "border-crm-border bg-crm-surface-2 text-crm-muted")}>
      {icon}
      {label}
    </span>
  );
}

function ContactChip({ icon, value, mono, tone }: { icon: ReactNode; value: string; mono?: boolean; tone?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border border-crm-border/70 bg-crm-surface-2/60 px-2.5 py-1 text-crm-text", mono && "font-mono tabular-nums", tone)}>
      <span className="shrink-0 text-crm-muted">{icon}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

function deriveRelationshipHealth({
  contact,
  tasks,
  forms,
  documents,
  timeline,
}: {
  contact: LiveContact;
  tasks: CrmTask[];
  forms: LiveWorkspaceFormRequest[];
  documents: LiveWorkspaceDocument[];
  timeline: TimelineEvent[];
}) {
  if (contact.doNotCall) return { label: "Do not call", tone: "text-crm-danger" };
  if (tasks.some((task) => task.dueAt && new Date(task.dueAt).getTime() < Date.now())) return { label: "Needs follow-up", tone: "text-crm-warning" };
  if (forms.some((form) => ["SENT", "OPENED"].includes(form.status))) return { label: "Forms pending", tone: "text-crm-warning" };
  if (documents.some((doc) => doc.status === "IMPORT_FAILED" || doc.status === "FAILED")) return { label: "File attention", tone: "text-crm-warning" };
  if (timeline.some((event) => event.type === "DISPOSITION_SET" && event.createdAt && Date.now() - new Date(event.createdAt).getTime() < 7 * 86400000)) {
    return { label: "Recently engaged", tone: "text-crm-success" };
  }
  return { label: "Stable", tone: "text-crm-success" };
}

function checkedCount(answers: Record<string, boolean>) {
  return Object.values(answers).filter(Boolean).length;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}
