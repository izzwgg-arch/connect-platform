"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import {
  CRMPageShell,
  ContactSmsPanel,
  ContactTimeline,
  crm,
  LiveCallStatusBanner,
  LiveWorkspaceActionBar,
  LiveWorkspaceChecklistPanel,
  LiveWorkspaceContactHeader,
  LiveWorkspaceIdle,
  LiveWorkspaceNotePanel,
  LiveWorkspaceOutcomePanel,
  LiveWorkspaceScriptPanel,
  LiveWorkspaceSessionRail,
  LiveWorkspaceTasksPanel,
  type Checklist,
  type CrmStage,
  type CrmTask,
  type LiveContact,
  type ScriptSummary,
  type TimelineEvent,
} from "../../../../components/crm";
import type { QueueOperationalStats } from "../../../../components/crm/queue/queueTypes";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";
import { useSipPhone } from "../../../../hooks/useSipPhone";

const TIMELINE_LIMIT = 25;

function LiveCallPageFallback() {
  return <div className="py-24 text-center text-sm text-crm-muted">Loading workspace…</div>;
}

export default function LiveCallWorkspacePage() {
  return (
    <Suspense fallback={<LiveCallPageFallback />}>
      <LiveCallWorkspaceInner />
    </Suspense>
  );
}

function LiveCallWorkspaceInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user: appUser } = useAppContext();
  const phone = useSipPhone();

  const contactId = searchParams.get("contactId");
  const linkedId = searchParams.get("linkedId");
  const fromNumber = searchParams.get("from");
  const campaignId = searchParams.get("campaignId");
  const memberId = searchParams.get("memberId");
  const returnTo = searchParams.get("returnTo");
  const isPowerMode = searchParams.get("mode") === "power" && Boolean(memberId);
  const queueBackHref =
    returnTo && returnTo.startsWith("/crm/queue")
      ? returnTo
      : memberId
        ? isPowerMode
          ? "/crm/queue?mode=power"
          : "/crm/queue"
        : null;

  const [contact, setContact] = useState<LiveContact | null>(null);
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [idleStats, setIdleStats] = useState<QueueOperationalStats | null>(null);
  const [idleStatsLoading, setIdleStatsLoading] = useState(false);

  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [campaignScriptId, setCampaignScriptId] = useState<string | null>(null);
  const [campaignChecklistId, setCampaignChecklistId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);

  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  const [noteBody, setNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const smsPanelRef = useRef<HTMLDivElement>(null);

  const [smsPhone, setSmsPhone] = useState("");
  const [smsMessage, setSmsMessage] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [smsSuccess, setSmsSuccess] = useState(false);

  const [disposition, setDisposition] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [followUpOption, setFollowUpOption] = useState<"" | "today" | "tomorrow" | "nextweek" | "custom">("");
  const [followUpCustom, setFollowUpCustom] = useState("");
  const [nextStage, setNextStage] = useState<CrmStage | "">("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");

  const saveOutcomeRef = useRef<() => Promise<void>>(async () => {});

  const isArchived = Boolean(contact?.archivedAt || contact?.active === false);
  const primaryPhone =
    contact?.primaryPhone?.numberRaw ??
    contact?.phones?.find((p) => p.isPrimary)?.numberRaw ??
    contact?.phones?.[0]?.numberRaw ??
    null;
  const phones = contact?.phones ?? (primaryPhone ? [{ id: "p", type: "MOBILE", numberRaw: primaryPhone, isPrimary: true }] : []);
  const doNotSms = contact?.doNotSms ?? false;
  const canCall = Boolean(primaryPhone && !contact?.doNotCall && !isArchived);
  const canSms = Boolean(phones.length > 0 && !doNotSms && !isArchived);

  const smsEvents = useMemo(
    () =>
      timeline
        .filter((e) => e.type === "SMS_SENT" || e.type === "SMS_RECEIVED")
        .slice(0, 25),
    [timeline],
  );

  const sipNotice =
    phone.regState !== "registered" && primaryPhone
      ? phone.regState === "connecting" || phone.regState === "registering"
        ? "Phone connecting — call will dial once ready"
        : "Phone not registered — open the dialer to reconnect"
      : null;

  async function refreshAll() {
    if (!contactId) return;
    try {
      const [contactRes, tasksRes, timelineRes] = await Promise.all([
        apiGet<{ contact: LiveContact }>(`/crm/contacts/${contactId}`),
        apiGet<{ tasks: CrmTask[] }>(`/crm/contacts/${contactId}/tasks?status=open&limit=10`),
        apiGet<{ events: TimelineEvent[] }>(`/crm/contacts/${contactId}/timeline?limit=${TIMELINE_LIMIT}`),
      ]);
      setContact(contactRes.contact ?? (contactRes as unknown as LiveContact));
      setTasks(tasksRes.tasks ?? []);
      setTimeline(timelineRes.events ?? []);
    } catch {
      // non-critical
    }
  }

  async function refreshTimeline() {
    if (!contactId) return;
    try {
      const res = await apiGet<{ events: TimelineEvent[] }>(
        `/crm/contacts/${contactId}/timeline?limit=${TIMELINE_LIMIT}`,
      );
      setTimeline(res.events ?? []);
    } catch {
      // non-critical
    }
  }

  useEffect(() => {
    if (!contactId) {
      setLoading(false);
      setIdleStatsLoading(true);
      apiGet<QueueOperationalStats>("/crm/tasks/stats")
        .then(setIdleStats)
        .catch(() => setIdleStats(null))
        .finally(() => setIdleStatsLoading(false));
      return;
    }

    setLoading(true);
    const fetches: Promise<unknown>[] = [
      apiGet<{ contact: LiveContact }>(`/crm/contacts/${contactId}`),
      apiGet<{ tasks: CrmTask[] }>(`/crm/contacts/${contactId}/tasks?status=open&limit=10`),
      apiGet<{ events: TimelineEvent[] }>(`/crm/contacts/${contactId}/timeline?limit=${TIMELINE_LIMIT}`),
      apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts"),
      apiGet<{ checklists: Checklist[] }>("/crm/checklists"),
    ];
    if (campaignId) {
      fetches.push(
        apiGet<{ campaign: { name: string; scriptId: string | null; checklistId: string | null } }>(
          `/crm/campaigns/${campaignId}`,
        ).catch(() => null),
      );
    }

    Promise.all(fetches)
      .then((results) => {
        const [contactRes, tasksRes, timelineRes, scriptsRes, checklistsRes, campaignRes] = results as [
          { contact: LiveContact },
          { tasks: CrmTask[] },
          { events: TimelineEvent[] },
          { scripts: ScriptSummary[] },
          { checklists: Checklist[] },
          { campaign: { name: string; scriptId: string | null; checklistId: string | null } } | null | undefined,
        ];
        const c = contactRes.contact ?? (contactRes as unknown as LiveContact);
        setContact(c);
        setTasks(tasksRes.tasks ?? []);
        setTimeline(timelineRes.events ?? []);
        setScriptSummaries(scriptsRes.scripts ?? []);
        setChecklists(checklistsRes.checklists ?? []);
        const primary = c.primaryPhone?.numberRaw ?? c.phones?.find((p) => p.isPrimary)?.numberRaw ?? "";
        setSmsPhone(primary);
        if (campaignRes?.campaign) {
          setCampaignName(campaignRes.campaign.name);
          setCampaignScriptId(campaignRes.campaign.scriptId);
          setCampaignChecklistId(campaignRes.campaign.checklistId);
        }
      })
      .catch((err: unknown) => {
        setError(String((err as Error)?.message ?? "Failed to load contact"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  useEffect(() => {
    if (!isPowerMode) return;
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "o" || e.key === "O") && !savingOutcome && disposition) {
        e.preventDefault();
        void saveOutcomeRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isPowerMode, disposition, savingOutcome]);

  const handleCall = useCallback(async () => {
    if (!contact || !primaryPhone || !contactId) return;
    if (!callerIdChecked) {
      setCallerIdLoading(true);
      try {
        const res = await apiPost<{
          callerId: string | null;
          destination: string;
          selectedFromPool: boolean;
          localPresenceEnabled: boolean;
        }>("/crm/calls/originate", {
          destination: primaryPhone,
          contactId,
          memberId: memberId ?? undefined,
          campaignId: campaignId ?? undefined,
        });
        setCallerIdSelected(res.callerId);
      } catch {
        setCallerIdSelected(null);
      } finally {
        setCallerIdChecked(true);
        setCallerIdLoading(false);
      }
    }
    window.dispatchEvent(new CustomEvent("crm:dial", { detail: { target: primaryPhone } }));
  }, [callerIdChecked, campaignId, contact, contactId, memberId, primaryPhone]);

  async function saveNote() {
    if (!contactId || !noteBody.trim() || isArchived) return;
    setSavingNote(true);
    try {
      await apiPost(`/crm/contacts/${contactId}/notes`, { body: noteBody.trim() });
      setNoteBody("");
      setNoteSavedAt(new Date());
      await refreshTimeline();
    } catch {
      // user can retry
    } finally {
      setSavingNote(false);
    }
  }

  async function saveOutcome() {
    if (!contactId || !disposition || isArchived) return;
    setSavingOutcome(true);
    setOutcomeError("");

    let followUpAt: string | null = null;
    if (followUpOption === "today") {
      const d = new Date();
      d.setHours(17, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "nextweek") {
      const d = new Date();
      const day = d.getDay();
      const daysToMonday = day === 0 ? 1 : 8 - day;
      d.setDate(d.getDate() + daysToMonday);
      d.setHours(9, 0, 0, 0);
      followUpAt = d.toISOString();
    } else if (followUpOption === "custom" && followUpCustom) {
      followUpAt = new Date(followUpCustom).toISOString();
    }

    try {
      await apiPost(`/crm/contacts/${contactId}/disposition`, {
        disposition,
        note: outcomeNote.trim() || undefined,
        linkedId: linkedId ?? undefined,
        followUpAt: followUpAt ?? undefined,
        nextStage: nextStage || undefined,
        memberId: memberId ?? undefined,
      });
      setOutcomeSaved(true);
      setOutcomeNote("");
      setFollowUpOption("");
      setFollowUpCustom("");
      await refreshAll();

      if (memberId) {
        const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;
        apiPatch(`/crm/queue/${memberId}`, { action: "outcome", disposition }, token).catch(() => {});
      }

      if (isPowerMode && memberId) {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        router.push(queueBackHref ?? "/crm/queue?mode=power");
        return;
      }

      setTimeout(() => setOutcomeSaved(false), 4000);
    } catch {
      setOutcomeError("Save failed — please try again.");
    } finally {
      setSavingOutcome(false);
    }
  }

  useEffect(() => {
    saveOutcomeRef.current = saveOutcome;
  });

  async function sendSms() {
    if (!contactId || !smsMessage.trim() || smsSending || doNotSms || isArchived) return;
    setSmsSending(true);
    setSmsError(null);
    setSmsSuccess(false);
    try {
      await apiPost(`/crm/contacts/${contactId}/sms`, {
        message: smsMessage.trim(),
        ...(smsPhone ? { phone: smsPhone } : {}),
      });
      setSmsMessage("");
      setSmsSuccess(true);
      await refreshTimeline();
      setTimeout(() => setSmsSuccess(false), 3000);
    } catch (err: unknown) {
      const e = err as { message?: string };
      setSmsError(e?.message || "Failed to send SMS");
    } finally {
      setSmsSending(false);
    }
  }

  const scrollToNote = () => noteRef.current?.focus();
  const scrollToOutcome = () =>
    outcomeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  const scrollToSms = () =>
    smsPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  const scrollToTasks = () => {
    if (contactId) router.push(`/crm/contacts/${contactId}#tasks`);
  };

  if (!contactId) {
    return (
      <CRMPageShell innerClassName={crm.pageInnerLive}>
        <LiveWorkspaceIdle stats={idleStats} statsLoading={idleStatsLoading} />
      </CRMPageShell>
    );
  }

  return (
    <CRMPageShell innerClassName={crm.pageInnerLive}>
      {contact && !loading && !error ? (
        <LiveWorkspaceActionBar
          contactName={contact.displayName}
          isArchived={isArchived}
          canCall={canCall}
          canSms={canSms}
          hasDisposition={Boolean(disposition)}
          queueBackHref={queueBackHref}
          contactProfileHref={`/crm/contacts/${contact.id}`}
          onCall={() => void handleCall()}
          onSms={scrollToSms}
          onNote={scrollToNote}
          onTask={scrollToTasks}
          onDisposition={scrollToOutcome}
        />
      ) : null}

      {loading ? <LoadingSkeleton /> : null}

      {error ? (
        <div className="rounded-crm-lg border border-crm-danger/35 bg-crm-danger/10 px-4 py-3 text-sm text-crm-danger">
          {error}
        </div>
      ) : null}

      {!loading && !error && contact ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          <aside className="flex flex-col gap-4 xl:col-span-3 xl:order-1">
            <LiveWorkspaceSessionRail
              queueBackHref={queueBackHref}
              memberId={memberId}
              isPowerMode={isPowerMode}
              campaignId={campaignId}
              campaignName={campaignName}
              contactId={contactId}
              contactName={contact.displayName}
              onBack={() => {
                if (queueBackHref) router.push(queueBackHref);
                else router.back();
              }}
            />
          </aside>

          <main className="flex min-w-0 flex-col gap-4 xl:col-span-6 xl:order-2">
            <LiveCallStatusBanner linkedId={linkedId} fromNumber={fromNumber} />
            <LiveWorkspaceContactHeader
              contact={contact}
              isArchived={isArchived}
              callerIdChecked={callerIdChecked}
              callerIdSelected={callerIdSelected}
              callerIdLoading={callerIdLoading}
              sipNotice={sipNotice}
              onCall={() => void handleCall()}
              profileHref={`/crm/contacts/${contact.id}`}
            />
            <LiveWorkspaceNotePanel
              ref={noteRef}
              noteBody={noteBody}
              setNoteBody={setNoteBody}
              savingNote={savingNote}
              noteSavedAt={noteSavedAt}
              onSave={() => void saveNote()}
              disabled={isArchived}
            />
            {phones.length > 0 ? (
              <ContactSmsPanel
                ref={smsPanelRef}
                phones={phones}
                smsEvents={smsEvents}
                timelineLoading={loading}
                isArchived={isArchived}
                doNotSms={doNotSms}
                smsPhone={smsPhone}
                setSmsPhone={setSmsPhone}
                smsMessage={smsMessage}
                setSmsMessage={setSmsMessage}
                smsSending={smsSending}
                smsError={smsError}
                smsSuccess={smsSuccess}
                onSend={() => void sendSms()}
              />
            ) : null}
            <div ref={outcomeRef}>
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
                onSave={() => void saveOutcome()}
                disabled={isArchived}
              />
            </div>
            <ContactTimeline
              events={timeline}
              loading={loading}
              currentUserId={appUser?.id}
              editingNoteLinkedId={null}
              editingNoteText=""
              allowNoteMutations={false}
              onEditNote={() => {}}
              onDeleteNote={() => {}}
              isArchived={isArchived}
            />
          </main>

          <aside className="flex flex-col gap-4 xl:col-span-3 xl:order-3">
            <LiveWorkspaceScriptPanel
              scriptSummaries={scriptSummaries}
              defaultScriptId={campaignScriptId}
            />
            <LiveWorkspaceChecklistPanel
              checklists={checklists}
              contactId={contactId}
              linkedId={linkedId}
              defaultChecklistId={campaignChecklistId}
              onSaved={() => void refreshTimeline()}
            />
            <LiveWorkspaceTasksPanel tasks={tasks} contactId={contactId} />
          </aside>
        </div>
      ) : null}

      {!loading && !error && !contact ? (
        <div className="py-12 text-center text-sm text-crm-muted">Contact not found.</div>
      ) : null}
    </CRMPageShell>
  );
}
