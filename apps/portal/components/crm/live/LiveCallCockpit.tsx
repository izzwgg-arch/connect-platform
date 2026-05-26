"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  Activity,
  BarChart3,
  CheckCheck,
  ChevronDown,
  Clock,
  FileText,
  Headphones,
  History,
  Keyboard,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  Mic,
  MoreVertical,
  Pause,
  Phone,
  PhoneOff,
  Radio,
  Send,
  ShieldCheck,
  SquarePen,
  Timer,
  UserRound,
  Users,
} from "lucide-react";
import { apiGet } from "../../../services/apiClient";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { initials, ownerLabel, stageColor, stageLabel, formatTimeAgo } from "../contact/contactFormatters";
import type { QueueCounts, QueueMember, QueueOperationalStats } from "../queue/queueTypes";
import { MEMBER_STATUS_LABELS } from "../queue/queueUtils";
import { DISPOSITION_OPTIONS, type CrmStage, type LiveContact, type Script, type ScriptSummary, type TimelineEvent } from "./liveTypes";
import { STAGE_OPTIONS } from "../contact/contactFormatters";

type DailyReport = {
  dispositionsToday?: number;
  callsLinkedToday?: number;
  contactsCreatedToday?: number;
  activeCampaigns?: number;
  queueRemaining?: number;
};

type PhoneControls = {
  regState: string;
  callState: string;
  muted: boolean;
  onHold: boolean;
  setMute: (mute: boolean) => void;
  toggleHold: () => void;
  hangup: () => void;
  sendDtmf: (digit: string) => void;
  transfer: (target: string) => void;
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
  noteRef: RefObject<HTMLTextAreaElement | null>;
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
  tasks: { id: string; title: string; dueAt?: string | null; priority: string; status: string }[];
  scriptSummaries: ScriptSummary[];
  campaignScriptId: string | null;
  queueMembers: QueueMember[];
  queueCounts: QueueCounts | null;
  opStats: QueueOperationalStats | null;
  dailyReport: DailyReport | null;
  phone: PhoneControls;
  sipNotice: string | null;
  callerIdChecked: boolean;
  callerIdSelected: string | null;
  callerIdLoading: boolean;
  onCall: () => void;
  onOpenContact: () => void;
}) {
  const [noteTab, setNoteTab] = useState<"notes" | "activity" | "history">("notes");
  const [queueTab, setQueueTab] = useState<"all" | "waiting" | "my" | "parked">("all");
  const [activityFilter, setActivityFilter] = useState("all");
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [selectedScriptId, setSelectedScriptId] = useState("");
  const [script, setScript] = useState<Script | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);

  const phoneActive = phone.callState !== "idle" && phone.callState !== "ended";
  const stage = (contact.crmStage ?? "LEAD") as CrmStage;
  const email = contact.primaryEmail?.email ?? contact.emails?.find((e) => e.isPrimary)?.email ?? null;
  const contactAny = contact as LiveContact & {
    assignedTo?: Parameters<typeof ownerLabel>[0];
    lastActivityAt?: string | null;
    lastDisposition?: string | null;
    city?: string | null;
    state?: string | null;
    location?: string | null;
    leadScore?: number | string | null;
  };
  const location = contactAny.location ?? ([contactAny.city, contactAny.state].filter(Boolean).join(", ") || null);
  const owner = ownerLabel(contactAny.assignedTo) ?? "You";
  const leadScore = contactAny.leadScore ?? null;
  const lastContact = contactAny.lastActivityAt ? formatTimeAgo(contactAny.lastActivityAt) : "No activity yet";

  const callsToday = dailyReport?.callsLinkedToday ?? opStats?.callsLinkedToday ?? 0;
  const contactsReached = dailyReport?.dispositionsToday ?? opStats?.dispositionsToday ?? 0;
  const conversations = timeline.filter((event) => ["CDR_INBOUND", "CDR_OUTBOUND", "SMS_SENT", "SMS_RECEIVED"].includes(event.type)).length;
  const dispositionRate = callsToday > 0 ? Math.round((contactsReached / callsToday) * 100) : 0;

  useEffect(() => {
    if (!phoneActive) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - started) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [phoneActive, linkedId]);

  useEffect(() => {
    if (!campaignScriptId || selectedScriptId || scriptSummaries.length === 0) return;
    if (scriptSummaries.some((item) => item.id === campaignScriptId)) setSelectedScriptId(campaignScriptId);
  }, [campaignScriptId, scriptSummaries, selectedScriptId]);

  useEffect(() => {
    if (!selectedScriptId) {
      setScript(null);
      return;
    }
    let cancelled = false;
    setScriptLoading(true);
    apiGet<{ script: Script }>(`/crm/scripts/${selectedScriptId}`)
      .then((res) => {
        if (!cancelled) setScript(res.script ?? null);
      })
      .catch(() => {
        if (!cancelled) setScript(null);
      })
      .finally(() => {
        if (!cancelled) setScriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScriptId]);

  const scriptSections = useMemo(() => buildScriptSections(script?.body ?? ""), [script?.body]);
  const filteredActivity = useMemo(() => {
    if (activityFilter === "notes") return timeline.filter((event) => event.type.includes("NOTE"));
    if (activityFilter === "calls") return timeline.filter((event) => event.type.includes("CDR"));
    if (activityFilter === "messages") return timeline.filter((event) => event.type.includes("SMS"));
    return timeline;
  }, [activityFilter, timeline]);

  const kpis = [
    { label: "Active Call", value: phoneActive ? "1" : "0", sub: phoneActive ? "In progress" : "Ready", icon: <Phone className="h-4 w-4" />, tone: "green" },
    { label: "Calls Today", value: callsToday.toLocaleString(), sub: opStats ? "CRM linked" : "Loaded from reports", icon: <Activity className="h-4 w-4" />, tone: "blue" },
    { label: "Contacts Reached", value: contactsReached.toLocaleString(), sub: "Dispositioned", icon: <Users className="h-4 w-4" />, tone: "violet" },
    { label: "Conversations", value: conversations.toLocaleString(), sub: "This contact", icon: <MessageSquare className="h-4 w-4" />, tone: "amber" },
    { label: "Avg. Call Duration", value: formatDuration(elapsed), sub: phoneActive ? "Current call" : "No live timer", icon: <Timer className="h-4 w-4" />, tone: "cyan" },
    { label: "Disposition Rate", value: `${dispositionRate}%`, sub: callsToday > 0 ? "Today" : "No calls yet", icon: <BarChart3 className="h-4 w-4" />, tone: "emerald" },
  ];

  function appendNote(label: string) {
    setNoteBody(noteBody ? noteBody + (noteBody.endsWith(" ") ? "" : " ") + label : label);
    noteRef.current?.focus();
  }

  function sendTransfer() {
    if (!phoneActive || !transferTarget.trim()) return;
    phone.transfer(transferTarget.trim());
    setTransferTarget("");
    setTransferOpen(false);
  }

  return (
    <div className="crm-live-workspace">
      <header className="crm-live-hero">
        <div className="flex min-w-0 items-center gap-4">
          <div className="crm-live-hero-icon">
            <Headphones className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="crm-live-title">Live Call Workspace</h1>
            <span className="sr-only">CRM</span>
            <p className="crm-live-subtitle">Real-time calling cockpit for active conversations and lead engagement.</p>
          </div>
        </div>
        <div className="crm-live-hero-actions">
          <span className={cn("crm-live-status-pill", phone.regState === "registered" && "is-online")}>
            <span className="h-2 w-2 rounded-full bg-current" />
            {phone.regState === "registered" ? "You're online" : phone.regState === "connecting" || phone.regState === "registering" ? "Connecting" : "Offline"}
          </span>
          <Link href="/crm/queue" className="crm-live-primary-action">
            Open Queue
          </Link>
          <button type="button" className="crm-live-icon-action" disabled aria-label="More options">
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      </header>

      <section className="crm-live-kpi-grid" aria-label="Live call metrics">
        {kpis.map((kpi) => (
          <MetricCard key={kpi.label} {...kpi} />
        ))}
      </section>

      <section className="crm-live-cockpit-grid">
        <div className="crm-live-main-stack">
          <ActiveCallCard
            contact={contact}
            stage={stage}
            primaryPhone={primaryPhone}
            campaignName={campaignName}
            memberId={memberId}
            fromNumber={fromNumber}
            linkedId={linkedId}
            phoneActive={phoneActive}
            phone={phone}
            elapsed={elapsed}
            canCall={canCall}
            isArchived={isArchived}
            sipNotice={sipNotice}
            callerIdChecked={callerIdChecked}
            callerIdSelected={callerIdSelected}
            callerIdLoading={callerIdLoading}
            onCall={onCall}
            onOpenContact={onOpenContact}
            onAddNote={() => noteRef.current?.focus()}
            keypadOpen={keypadOpen}
            setKeypadOpen={setKeypadOpen}
            transferOpen={transferOpen}
            setTransferOpen={setTransferOpen}
            transferTarget={transferTarget}
            setTransferTarget={setTransferTarget}
            onTransfer={sendTransfer}
          />

          <LiveQueueCard
            queueMembers={queueMembers}
            queueCounts={queueCounts}
            queueTab={queueTab}
            setQueueTab={setQueueTab}
          />
        </div>

        <div className="crm-live-center-stack">
          <NotesActivityCard
            noteTab={noteTab}
            setNoteTab={setNoteTab}
            noteRef={noteRef}
            noteBody={noteBody}
            setNoteBody={setNoteBody}
            savingNote={savingNote}
            noteSavedAt={noteSavedAt}
            onSaveNote={onSaveNote}
            disabled={isArchived}
            appendNote={appendNote}
            timeline={timeline}
            tasks={tasks}
          />

          <ContactSnapshotCard
            contact={contact}
            stage={stage}
            email={email}
            primaryPhone={primaryPhone}
            location={location}
            leadScore={leadScore}
            lastContact={lastContact}
            owner={owner}
            isArchived={isArchived}
            onOpenContact={onOpenContact}
          />
        </div>

        <div className="crm-live-side-stack">
          <CallScriptCard
            scriptSummaries={scriptSummaries}
            selectedScriptId={selectedScriptId}
            setSelectedScriptId={setSelectedScriptId}
            scriptLoading={scriptLoading}
            scriptSections={scriptSections}
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
            onSaveOutcome={onSaveOutcome}
            disabled={isArchived}
          />

          <RecentActivityCard
            timeline={filteredActivity}
            activityFilter={activityFilter}
            setActivityFilter={setActivityFilter}
          />
        </div>
      </section>

      <section className="crm-live-performance-bar">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-crm-text">Your Performance Today</p>
        </div>
        <PerformanceItem label="Calls Made" value={callsToday.toLocaleString()} delta="CRM linked" />
        <PerformanceItem label="Contacts Reached" value={contactsReached.toLocaleString()} delta="Dispositioned" />
        <PerformanceItem label="Conversations" value={conversations.toLocaleString()} delta="This contact" />
        <PerformanceItem label="Avg. Duration" value={formatDuration(elapsed)} delta={phoneActive ? "Current call" : "No live call"} />
        <PerformanceItem label="Disposition Rate" value={`${dispositionRate}%`} delta={callsToday > 0 ? "Today" : "No calls"} />
        <Link href="/crm/reports" className="crm-live-secondary-action ml-auto">
          View Full Reports
        </Link>
      </section>

      {queueBackHref ? (
        <Link href={queueBackHref} className="crm-live-back-link">
          Return to queue
        </Link>
      ) : null}
    </div>
  );
}

function MetricCard({ label, value, sub, icon, tone }: { label: string; value: string; sub: string; icon: ReactNode; tone: string }) {
  return (
    <div className={cn("crm-live-kpi-card", `tone-${tone}`)}>
      <div className="flex items-start justify-between gap-3">
        <div className="crm-live-kpi-icon">{icon}</div>
        <span className="crm-live-kpi-trend">{sub}</span>
      </div>
      <div>
        <p className="crm-live-kpi-label">{label}</p>
        <p className="crm-live-kpi-value">{value}</p>
      </div>
    </div>
  );
}

function ActiveCallCard({
  contact,
  stage,
  primaryPhone,
  campaignName,
  memberId,
  fromNumber,
  linkedId,
  phoneActive,
  phone,
  elapsed,
  canCall,
  isArchived,
  sipNotice,
  callerIdChecked,
  callerIdSelected,
  callerIdLoading,
  onCall,
  onOpenContact,
  onAddNote,
  keypadOpen,
  setKeypadOpen,
  transferOpen,
  setTransferOpen,
  transferTarget,
  setTransferTarget,
  onTransfer,
}: {
  contact: LiveContact;
  stage: CrmStage;
  primaryPhone: string | null;
  campaignName: string | null;
  memberId: string | null;
  fromNumber: string | null;
  linkedId: string | null;
  phoneActive: boolean;
  phone: PhoneControls;
  elapsed: number;
  canCall: boolean;
  isArchived: boolean;
  sipNotice: string | null;
  callerIdChecked: boolean;
  callerIdSelected: string | null;
  callerIdLoading: boolean;
  onCall: () => void;
  onOpenContact: () => void;
  onAddNote: () => void;
  keypadOpen: boolean;
  setKeypadOpen: (value: boolean) => void;
  transferOpen: boolean;
  setTransferOpen: (value: boolean) => void;
  transferTarget: string;
  setTransferTarget: (value: string) => void;
  onTransfer: () => void;
}) {
  const statusLabel = phoneActive
    ? phone.onHold
      ? "On hold"
      : phone.callState === "ringing"
        ? "Ringing"
        : phone.callState === "dialing"
          ? "Dialing"
          : "In progress"
    : linkedId || fromNumber
      ? "Call context"
      : "Ready";

  return (
    <article className="crm-live-card crm-live-active-card">
      <div className="crm-live-card-head">
        <div className="flex items-center gap-2">
          <span className={cn("crm-live-dot", phoneActive && "is-live")} />
          <span className="crm-live-section-label">Active Call</span>
        </div>
        <span className="crm-live-timer">{phoneActive ? formatDuration(elapsed) : "00:00"}</span>
      </div>

      <div className="crm-live-contact-hero">
        <div className="crm-live-avatar" style={{ background: stageColor(stage) }}>
          {initials(contact.displayName)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-bold text-crm-text">{contact.displayName}</h2>
            <span className="crm-live-stage-pill" style={{ color: stageColor(stage), backgroundColor: `${stageColor(stage)}1f` }}>
              {stageLabel(stage)}
            </span>
          </div>
          <p className="mt-1 font-mono text-sm tabular-nums text-crm-muted">{primaryPhone ?? fromNumber ?? "No phone on file"}</p>
        </div>
      </div>

      <div className="crm-live-detail-grid">
        <DetailPill label="Campaign" value={campaignName ?? "No campaign"} />
        <DetailPill label="Disposition" value={contactAnyValue(contact, "lastDisposition") ?? "Not set"} />
        <DetailPill label="Source" value={memberId ? "Queue" : linkedId ? "Screen pop" : "Contact"} />
      </div>

      <div className="crm-live-chip-row">
        <span className="crm-live-soft-chip">
          <MapPin className="h-3.5 w-3.5" />
          {contactAnyValue(contact, "location") ?? "Location not recorded"}
        </span>
        <span className="crm-live-soft-chip">
          <Clock className="h-3.5 w-3.5" />
          Local time {new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      </div>

      {sipNotice ? <div className="crm-live-warning">{sipNotice}</div> : null}
      {callerIdChecked ? (
        <p className="text-xs text-crm-muted">{callerIdSelected ? `Local presence: ${callerIdSelected}` : "Default caller ID"}</p>
      ) : null}

      <div className="crm-live-controls" aria-label="Call controls">
        <ControlButton icon={<Mic className="h-4 w-4" />} label={phone.muted ? "Unmute" : "Mute"} onClick={() => phone.setMute(!phone.muted)} disabled={!phoneActive} />
        <ControlButton icon={<Keyboard className="h-4 w-4" />} label="Keypad" onClick={() => setKeypadOpen(!keypadOpen)} disabled={!phoneActive} />
        <ControlButton icon={<Pause className="h-4 w-4" />} label={phone.onHold ? "Resume" : "Hold"} onClick={() => phone.toggleHold()} disabled={!phoneActive} />
        <ControlButton icon={<Send className="h-4 w-4" />} label="Transfer" onClick={() => setTransferOpen(!transferOpen)} disabled={!phoneActive} />
        <ControlButton icon={<SquarePen className="h-4 w-4" />} label="Add Note" onClick={onAddNote} disabled={isArchived} />
        <ControlButton icon={<PhoneOff className="h-4 w-4" />} label="End Call" onClick={() => phone.hangup()} disabled={!phoneActive} danger />
      </div>

      {keypadOpen && phoneActive ? (
        <div className="crm-live-keypad">
          {"123456789*0#".split("").map((digit) => (
            <button key={digit} type="button" onClick={() => phone.sendDtmf(digit)} className="crm-live-key">
              {digit}
            </button>
          ))}
        </div>
      ) : null}

      {transferOpen && phoneActive ? (
        <div className="crm-live-transfer">
          <input
            value={transferTarget}
            onChange={(event) => setTransferTarget(event.target.value)}
            placeholder="Extension or phone number"
            className="crm-live-input"
          />
          <button type="button" onClick={onTransfer} disabled={!transferTarget.trim()} className="crm-live-primary-action">
            Transfer
          </button>
        </div>
      ) : null}

      <div className="crm-live-card-footer">
        {canCall && !phoneActive ? (
          <button type="button" onClick={onCall} disabled={callerIdLoading || isArchived} className="crm-live-inline-link">
            {callerIdLoading ? "Selecting caller ID..." : "Start real call"}
          </button>
        ) : null}
        <button type="button" onClick={onOpenContact} className="crm-live-inline-link">
          View Contact
        </button>
      </div>
    </article>
  );
}

function ControlButton({ icon, label, onClick, disabled, strong, danger }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; strong?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn("crm-live-control", strong && "is-strong", danger && "is-danger")}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function NotesActivityCard({
  noteTab,
  setNoteTab,
  noteRef,
  noteBody,
  setNoteBody,
  savingNote,
  noteSavedAt,
  onSaveNote,
  disabled,
  appendNote,
  timeline,
  tasks,
}: {
  noteTab: "notes" | "activity" | "history";
  setNoteTab: (tab: "notes" | "activity" | "history") => void;
  noteRef: RefObject<HTMLTextAreaElement | null>;
  noteBody: string;
  setNoteBody: (value: string) => void;
  savingNote: boolean;
  noteSavedAt: Date | null;
  onSaveNote: () => void;
  disabled: boolean;
  appendNote: (label: string) => void;
  timeline: TimelineEvent[];
  tasks: { id: string; title: string; dueAt?: string | null; priority: string; status: string }[];
}) {
  return (
    <article className="crm-live-card crm-live-notes-card">
      <div className="crm-live-card-head">
        <span className="crm-live-section-title">Notes & Activity</span>
        <div className="crm-live-tabs">
          {(["notes", "activity", "history"] as const).map((tab) => (
            <button key={tab} type="button" onClick={() => setNoteTab(tab)} className={cn("crm-live-tab", noteTab === tab && "is-active")}>
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {noteTab === "notes" ? (
        <div className="flex flex-col gap-3">
          <textarea
            ref={noteRef}
            value={noteBody}
            onChange={(event) => setNoteBody(event.target.value)}
            placeholder="Add a note about this call..."
            rows={4}
            disabled={disabled}
            className="crm-live-textarea"
          />
          <div className="flex flex-wrap gap-1.5">
            {["Interested", "Requested callback", "Sent estimate", "Wrong number"].map((label) => (
              <button key={label} type="button" disabled={disabled} onClick={() => appendNote(label)} className="crm-live-mini-chip">
                + {label}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-crm-muted">
              {noteSavedAt ? `Saved at ${noteSavedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : "Saved notes appear in timeline."}
            </span>
            <button type="button" onClick={onSaveNote} disabled={!noteBody.trim() || savingNote || disabled} className="crm-live-primary-action">
              {savingNote ? "Saving..." : "Add Note"}
            </button>
          </div>
        </div>
      ) : null}

      {noteTab === "activity" ? (
        <ActivityRows events={timeline.slice(0, 4)} empty="No recent contact activity yet." />
      ) : null}

      {noteTab === "history" ? (
        <div className="flex flex-col gap-2">
          {tasks.slice(0, 3).map((task) => (
            <div key={task.id} className="crm-live-feed-row">
              <div className="crm-live-feed-icon">
                <CheckCheck className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-crm-text">{task.title}</p>
                <p className="text-xs text-crm-muted">{task.dueAt ? formatTimeAgo(task.dueAt) : task.priority}</p>
              </div>
            </div>
          ))}
          {tasks.length === 0 ? <p className="text-sm text-crm-muted">No open tasks for this contact.</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function CallScriptCard({
  scriptSummaries,
  selectedScriptId,
  setSelectedScriptId,
  scriptLoading,
  scriptSections,
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
  disabled,
}: {
  scriptSummaries: ScriptSummary[];
  selectedScriptId: string;
  setSelectedScriptId: (value: string) => void;
  scriptLoading: boolean;
  scriptSections: { title: string; body: string }[];
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
  disabled: boolean;
}) {
  return (
    <article className="crm-live-card crm-live-script-card">
      <div className="crm-live-card-head">
        <span className="crm-live-section-title">Call Script</span>
        <FileText className="h-4 w-4 text-crm-muted" />
      </div>

      {scriptSummaries.length > 0 ? (
        <div className="relative">
          <select value={selectedScriptId} onChange={(event) => setSelectedScriptId(event.target.value)} className="crm-live-select">
            <option value="">Select script</option>
            {scriptSummaries.map((summary) => (
              <option key={summary.id} value={summary.id}>
                {summary.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-crm-muted" />
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-crm-border px-3 py-3 text-sm text-crm-muted">
          No active scripts are available. Create one in Scripts to show guided talk tracks here.
        </p>
      )}

      <div className="crm-live-script-sections">
        {scriptLoading ? <p className="text-sm text-crm-muted">Loading script...</p> : null}
        {!scriptLoading && scriptSections.map((section) => (
          <section key={section.title} className="crm-live-script-section">
            <p className="crm-live-script-heading">{section.title}</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-crm-text">{section.body}</p>
          </section>
        ))}
        {!scriptLoading && selectedScriptId && scriptSections.length === 0 ? (
          <p className="text-sm text-crm-muted">This script has no body content yet.</p>
        ) : null}
      </div>

      <div className="crm-live-disposition-box">
        <p className="crm-live-section-label">Disposition</p>
        <select value={disposition} onChange={(event) => setDisposition(event.target.value)} disabled={disabled} className="crm-live-select">
          <option value="">Select disposition</option>
          {DISPOSITION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <textarea
          value={outcomeNote}
          onChange={(event) => setOutcomeNote(event.target.value)}
          placeholder="Outcome note (optional)"
          rows={2}
          disabled={disabled}
          className="crm-live-textarea"
        />
        <div className="grid grid-cols-2 gap-2">
          <select value={followUpOption} onChange={(event) => setFollowUpOption(event.target.value as "" | "today" | "tomorrow" | "nextweek" | "custom")} disabled={disabled} className="crm-live-select">
            <option value="">No follow-up</option>
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
            <option value="nextweek">Next week</option>
            <option value="custom">Custom</option>
          </select>
          <select value={nextStage} onChange={(event) => setNextStage(event.target.value as CrmStage | "")} disabled={disabled} className="crm-live-select">
            <option value="">No stage change</option>
            {STAGE_OPTIONS.map((stage) => (
              <option key={stage.value} value={stage.value}>
                {stage.label}
              </option>
            ))}
          </select>
        </div>
        {followUpOption === "custom" ? (
          <input type="datetime-local" value={followUpCustom} onChange={(event) => setFollowUpCustom(event.target.value)} disabled={disabled} className="crm-live-input" />
        ) : null}
        {outcomeError ? <p className="text-xs font-semibold text-crm-danger">{outcomeError}</p> : null}
        {outcomeSaved ? <p className="text-xs font-semibold text-crm-success">Disposition saved.</p> : null}
        <button type="button" onClick={onSaveOutcome} disabled={!disposition || savingOutcome || disabled} className="crm-live-primary-action w-full">
          {savingOutcome ? "Saving..." : isPowerMode ? "Save Disposition & Next" : "Save Disposition"}
        </button>
      </div>
    </article>
  );
}

function LiveQueueCard({
  queueMembers,
  queueCounts,
  queueTab,
  setQueueTab,
}: {
  queueMembers: QueueMember[];
  queueCounts: QueueCounts | null;
  queueTab: "all" | "waiting" | "my" | "parked";
  setQueueTab: (tab: "all" | "waiting" | "my" | "parked") => void;
}) {
  return (
    <article className="crm-live-card">
      <div className="crm-live-card-head">
        <span className="crm-live-section-title">Live Queue</span>
        <span className="text-xs font-semibold text-crm-muted">{queueCounts ? `${queueCounts.pending} pending` : "Loading"}</span>
      </div>
      <div className="crm-live-tabs">
        <button type="button" onClick={() => setQueueTab("all")} className={cn("crm-live-tab", queueTab === "all" && "is-active")}>All</button>
        <button type="button" disabled className="crm-live-tab">Waiting</button>
        <button type="button" disabled className="crm-live-tab">My Calls</button>
        <button type="button" disabled className="crm-live-tab">Parked</button>
      </div>
      <div className="flex flex-col gap-2">
        {queueMembers.slice(0, 4).map((member) => (
          <Link key={member.id} href={`/crm/live-call?contactId=${member.contactId}&memberId=${member.id}&campaignId=${member.campaign?.id ?? ""}&returnTo=/crm/queue`} className="crm-live-queue-row">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-crm-text">{member.contact?.displayName ?? "Unknown contact"}</p>
              <p className="font-mono text-xs tabular-nums text-crm-muted">{member.contact?.primaryPhone ?? "No phone"}</p>
            </div>
            <div className="min-w-0 text-right">
              <p className="truncate text-xs text-crm-muted">{member.campaign?.name ?? "No campaign"}</p>
              <span className="crm-live-queue-status">{MEMBER_STATUS_LABELS[member.status]}</span>
            </div>
          </Link>
        ))}
        {queueMembers.length === 0 ? <p className="text-sm text-crm-muted">No queue rows available.</p> : null}
      </div>
      <Link href="/crm/queue" className="crm-live-card-link">
        View full queue
      </Link>
    </article>
  );
}

function ContactSnapshotCard({ contact, stage, email, primaryPhone, location, leadScore, lastContact, owner, isArchived, onOpenContact }: { contact: LiveContact; stage: CrmStage; email: string | null; primaryPhone: string | null; location: string | null; leadScore: string | number | null; lastContact: string; owner: string; isArchived: boolean; onOpenContact: () => void }) {
  return (
    <article className="crm-live-card">
      <div className="crm-live-card-head">
        <span className="crm-live-section-title">Contact Snapshot</span>
        <button type="button" onClick={onOpenContact} className="text-xs font-bold text-crm-accent">View Contact</button>
      </div>
      <div className="flex items-center gap-3">
        <div className="crm-live-avatar small" style={{ background: stageColor(stage) }}>{initials(contact.displayName)}</div>
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-crm-text">{contact.displayName}</p>
          <p className="font-mono text-xs text-crm-muted">{primaryPhone ?? "No phone"}</p>
          <span className="crm-live-stage-pill mt-1" style={{ color: stageColor(stage), backgroundColor: `${stageColor(stage)}1f` }}>{stageLabel(stage)}</span>
        </div>
      </div>
      <div className="crm-live-quick-actions">
        {email ? <a href={`mailto:${email}`} className="crm-live-icon-mini"><Mail className="h-4 w-4" /><span>Email</span></a> : null}
        <button type="button" onClick={onOpenContact} className="crm-live-icon-mini"><UserRound className="h-4 w-4" /><span>Profile</span></button>
        {isArchived ? <span className="crm-live-icon-mini is-disabled"><ShieldCheck className="h-4 w-4" /><span>Archived</span></span> : null}
      </div>
      <div className="crm-live-snapshot-list">
        <SnapshotRow icon={<Mail className="h-4 w-4" />} label="Email" value={email ?? "Not recorded"} />
        <SnapshotRow icon={<MapPin className="h-4 w-4" />} label="Location" value={location ?? "Not recorded"} />
        <SnapshotRow icon={<BarChart3 className="h-4 w-4" />} label="Lead Score" value={leadScore === null ? "Not scored" : String(leadScore)} />
        <SnapshotRow icon={<History className="h-4 w-4" />} label="Last Contact" value={lastContact} />
        <SnapshotRow icon={<UserRound className="h-4 w-4" />} label="Owner" value={owner} />
      </div>
    </article>
  );
}

function RecentActivityCard({ timeline, activityFilter, setActivityFilter }: { timeline: TimelineEvent[]; activityFilter: string; setActivityFilter: (value: string) => void }) {
  return (
    <article className="crm-live-card">
      <div className="crm-live-card-head">
        <span className="crm-live-section-title">Recent Activity</span>
        <select value={activityFilter} onChange={(event) => setActivityFilter(event.target.value)} className="crm-live-filter-select">
          <option value="all">All Activity</option>
          <option value="notes">Notes</option>
          <option value="calls">Calls</option>
          <option value="messages">Messages</option>
        </select>
      </div>
      <ActivityRows events={timeline.slice(0, 5)} empty="No recent activity." />
      <Link href="/crm/reports" className="crm-live-card-link">
        View all activity
      </Link>
    </article>
  );
}

function ActivityRows({ events, empty }: { events: TimelineEvent[]; empty: string }) {
  if (events.length === 0) return <p className="text-sm text-crm-muted">{empty}</p>;
  return (
    <div className="flex flex-col gap-2">
      {events.map((event) => (
        <div key={event.id} className="crm-live-feed-row">
          <div className="crm-live-feed-icon">
            {event.type.includes("SMS") ? <MessageSquare className="h-3.5 w-3.5" /> : event.type.includes("CDR") ? <Phone className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-crm-text">{event.title}</p>
            {event.body ? <p className="line-clamp-2 text-xs text-crm-muted">{event.body}</p> : null}
          </div>
          <span className="shrink-0 text-xs text-crm-muted">{formatTimeAgo(event.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-live-detail-pill">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function SnapshotRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="crm-live-snapshot-row">
      <span>{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PerformanceItem({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="crm-live-performance-item">
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{delta}</span>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  return `${minutes.toString().padStart(2, "0")}:${remaining.toString().padStart(2, "0")}`;
}

function buildScriptSections(body: string): { title: string; body: string }[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const wanted = ["Opening", "Need Discovery", "Value Proposition"];
  const sections = wanted.map((title) => ({ title, body: extractSection(trimmed, title) })).filter((section) => section.body);
  if (sections.length > 0) return sections;
  return [{ title: "Opening", body: trimmed }];
}

function extractSection(body: string, title: string): string {
  const pattern = new RegExp(`(?:^|\\n)#{0,3}\\s*${title}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{0,3}\\s*(Opening|Need Discovery|Value Proposition|Disposition)\\s*:?\\s*\\n|$)`, "i");
  return pattern.exec(body)?.[1]?.trim() ?? "";
}

function contactAnyValue(contact: LiveContact, key: string): string | null {
  const value = (contact as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : null;
}
