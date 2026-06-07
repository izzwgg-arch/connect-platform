"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { LoadingSkeleton } from "../../../../components/LoadingSkeleton";
import {
  CRMPageShell,
  crm,
  LiveCallCockpit,
  LiveWorkspaceIdle,
  type CrmStage,
  type CrmTask,
  type Checklist,
  type LiveCallHistoryItem,
  type LiveContact,
  type LiveWorkspaceContext,
  type LiveWorkspaceDocument,
  type LiveWorkspaceFormRequest,
  type LiveWorkspaceChecklistResponse,
  type ScriptSummary,
  type TimelineEvent,
} from "../../../../components/crm";
import { DISPOSITION_OPTIONS } from "../../../../components/crm/live";
import type { QueueCounts, QueueMember, QueueOperationalStats } from "../../../../components/crm/queue/queueTypes";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useSipPhone } from "../../../../hooks/useSipPhone";
import { useTelephony } from "../../../../contexts/TelephonyContext";
import { PermissionGate } from "../../../../components/PermissionGate";
import { buildCrmContactWorkspaceHref } from "../../../../lib/crmInboundCallDisplay";

const TIMELINE_LIMIT = 25;

type DailyReport = {
  dispositionsToday?: number;
  callsLinkedToday?: number;
  contactsCreatedToday?: number;
  activeCampaigns?: number;
  queueRemaining?: number;
};

type RecentLiveContactWorkspace = {
  href: string;
  name: string;
};

type SimulatedContactListResponse = {
  rows: Array<{
    id: string;
    displayName: string;
    primaryPhone?: { numberRaw: string } | null;
  }>;
};

function LiveCallPageFallback() {
  return <div className="py-24 text-center text-sm text-crm-muted">Loading workspace…</div>;
}

export default function LiveCallWorkspacePage() {
  return (
    <PermissionGate permission="can_view_crm_live_call" fallback={<div className="state-box">You do not have Live Call Workspace access.</div>}>
      <Suspense fallback={<LiveCallPageFallback />}>
        <LiveCallWorkspaceInner />
      </Suspense>
    </PermissionGate>
  );
}

function LiveCallWorkspaceInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const phone = useSipPhone();
  const telephony = useTelephony();
  const linkedCallSeenRef = useRef(false);

  const contactId = searchParams.get("contactId");
  const linkedId = searchParams.get("linkedId");
  const fromNumber = searchParams.get("from");
  const isSimulatedCall = linkedId?.startsWith("sim-") ?? false;
  const canSimulateLiveCall = process.env.NODE_ENV !== "production";
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
  const [liveContext, setLiveContext] = useState<LiveWorkspaceContext | null>(null);
  const [forms, setForms] = useState<LiveWorkspaceFormRequest[]>([]);
  const [documents, setDocuments] = useState<LiveWorkspaceDocument[]>([]);
  const [callHistory, setCallHistory] = useState<LiveCallHistoryItem[]>([]);
  const [checklists, setChecklists] = useState<Checklist[]>([]);
  const [recentChecklistResponses, setRecentChecklistResponses] = useState<LiveWorkspaceChecklistResponse[]>([]);
  const [defaultChecklistId, setDefaultChecklistId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recentWorkspace, setRecentWorkspace] = useState<RecentLiveContactWorkspace | null>(null);
  const [simulationLoading, setSimulationLoading] = useState(false);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [idleStats, setIdleStats] = useState<QueueOperationalStats | null>(null);
  const [idleStatsLoading, setIdleStatsLoading] = useState(false);
  const [opStats, setOpStats] = useState<QueueOperationalStats | null>(null);
  const [dailyReport, setDailyReport] = useState<DailyReport | null>(null);
  const [queueMembers, setQueueMembers] = useState<QueueMember[]>([]);
  const [queueCounts, setQueueCounts] = useState<QueueCounts | null>(null);

  const [scriptSummaries, setScriptSummaries] = useState<ScriptSummary[]>([]);
  const [campaignScriptId, setCampaignScriptId] = useState<string | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);

  const [callerIdSelected, setCallerIdSelected] = useState<string | null>(null);
  const [callerIdChecked, setCallerIdChecked] = useState(false);
  const [callerIdLoading, setCallerIdLoading] = useState(false);

  const contactWorkspaceHref = contactId
    ? buildCrmContactWorkspaceHref({
        crmContactId: contactId,
        linkedId: linkedId && !isSimulatedCall ? linkedId : undefined,
      })
    : null;

  const [noteBody, setNoteBody] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [noteSavedAt, setNoteSavedAt] = useState<Date | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const [disposition, setDisposition] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [followUpOption, setFollowUpOption] = useState<"" | "today" | "tomorrow" | "nextweek" | "custom">("");
  const [followUpCustom, setFollowUpCustom] = useState("");
  const [nextStage, setNextStage] = useState<CrmStage | "">("");
  const [savingOutcome, setSavingOutcome] = useState(false);
  const [outcomeSaved, setOutcomeSaved] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");

  const saveOutcomeRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!linkedId) {
      linkedCallSeenRef.current = false;
      return;
    }
    if (isSimulatedCall) {
      linkedCallSeenRef.current = true;
      return;
    }

    const linkedCallActive = telephony.activeCalls.some(
      (call) => call.linkedId === linkedId || call.id === linkedId,
    );
    if (linkedCallActive) {
      linkedCallSeenRef.current = true;
      return;
    }

    if (
      linkedCallSeenRef.current ||
      phone.callState === "idle" ||
      phone.callState === "ended"
    ) {
      linkedCallSeenRef.current = false;
      router.replace("/crm/live-call");
    }
  }, [isSimulatedCall, linkedId, phone.callState, router, telephony.activeCalls]);

  useEffect(() => {
    if (!contactWorkspaceHref) return;
    router.replace(contactWorkspaceHref);
  }, [contactWorkspaceHref, router]);

  // ── Draft note autosave ───────────────────────────────────────────────────
  const draftKey = contactId ? `crm:live:note:${contactId}` : null;
  useEffect(() => {
    if (!contactId || noteBody) return;
    try {
      const v = localStorage.getItem(`crm:live:note:${contactId}`);
      if (v) setNoteBody(v);
    } catch {}
  }, [contactId]);
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (noteBody) localStorage.setItem(draftKey, noteBody);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, noteBody]);

  const isArchived = Boolean(contact?.archivedAt || contact?.active === false);
  const primaryPhone =
    contact?.primaryPhone?.numberRaw ??
    contact?.phones?.find((p) => p.isPrimary)?.numberRaw ??
    contact?.phones?.[0]?.numberRaw ??
    null;
  const canCall = Boolean(primaryPhone && !contact?.doNotCall && !isArchived);

  const sipNotice =
    phone.regState !== "registered" && primaryPhone
      ? phone.regState === "connecting" || phone.regState === "registering"
        ? "Phone connecting — call will dial once ready"
        : "Phone not registered — open the dialer to reconnect"
      : null;

  async function refreshAll() {
    if (!contactId) return;
    try {
      const res = await apiGet<LiveWorkspaceContext>(buildContextPath());
      applyLiveContext(res);
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
    apiGet<LiveWorkspaceContext>(buildContextPath())
      .then(applyLiveContext)
      .catch((err: unknown) => {
        setError(String((err as Error)?.message ?? "Failed to load contact"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, linkedId, fromNumber, memberId, campaignId]);

  function buildContextPath() {
    const params = new URLSearchParams();
    if (contactId) params.set("contactId", contactId);
    if (linkedId && !isSimulatedCall) params.set("linkedId", linkedId);
    if (fromNumber) params.set("phone", fromNumber);
    if (memberId) params.set("memberId", memberId);
    if (campaignId) params.set("campaignId", campaignId);
    return `/crm/live-call/context?${params.toString()}`;
  }

  function applyLiveContext(res: LiveWorkspaceContext) {
    setLiveContext(res);
    if (!res.matched || !res.contact) {
      setContact(null);
      setTasks([]);
      setTimeline([]);
      setForms([]);
      setDocuments([]);
      setCallHistory([]);
      setChecklists([]);
      setRecentChecklistResponses([]);
      setDefaultChecklistId(null);
      setScriptSummaries([]);
      setCampaignScriptId(null);
      setCampaignName(null);
      return;
    }
    setContact(res.contact);
    const recentHref = buildCrmContactWorkspaceHref({
      crmContactId: res.contact.id,
      linkedId: linkedId ?? undefined,
    });
    if (recentHref) {
      setRecentWorkspace({
        href: recentHref,
        name: res.contact.displayName,
      });
    }
    setTasks(res.tasks ?? []);
    setTimeline(res.timeline ?? []);
    setForms(res.forms ?? []);
    setDocuments(res.documents ?? []);
    setCallHistory(res.callHistory ?? []);
    setChecklists(res.checklists?.items ?? []);
    setRecentChecklistResponses(res.checklists?.recentResponses ?? []);
    setDefaultChecklistId(res.checklists?.defaultChecklistId ?? null);
    setScriptSummaries(res.scripts?.items ?? []);
    setCampaignScriptId(res.scripts?.defaultScriptId ?? null);
    setCampaignName(res.campaignContext?.campaign?.name ?? null);
  }

  const startSimulatedIncomingCall = useCallback(async () => {
    if (!canSimulateLiveCall || simulationLoading) return;
    setSimulationLoading(true);
    setSimulationError(null);
    try {
      const res = await apiGet<SimulatedContactListResponse>("/crm/contacts?limit=12");
      const simulatedContact = res.rows.find((row) => row.primaryPhone?.numberRaw) ?? res.rows[0];
      if (!simulatedContact) {
        setSimulationError("No CRM contacts are available to simulate.");
        return;
      }

      const params = new URLSearchParams({
        contactId: simulatedContact.id,
        linkedId: `sim-${Date.now()}`,
      });
      if (simulatedContact.primaryPhone?.numberRaw) {
        params.set("from", simulatedContact.primaryPhone.numberRaw);
      }
      const recentHref = buildCrmContactWorkspaceHref({
        crmContactId: simulatedContact.id,
      });
      if (recentHref) {
        setRecentWorkspace({
          href: recentHref,
          name: simulatedContact.displayName,
        });
      }
      router.push(`/crm/live-call?${params.toString()}`);
    } catch {
      setSimulationError("Could not load a CRM contact to simulate.");
    } finally {
      setSimulationLoading(false);
    }
  }, [canSimulateLiveCall, router, simulationLoading]);

  const hangUpSimulatedIncomingCall = useCallback(() => {
    if (!contact) {
      router.replace("/crm/live-call");
      return;
    }

    const recentHref = buildCrmContactWorkspaceHref({
      crmContactId: contact.id,
      linkedId: linkedId ?? undefined,
    });
    if (recentHref) {
      setRecentWorkspace({
        href: recentHref,
        name: contact.displayName,
      });
    }
    linkedCallSeenRef.current = false;
    router.replace("/crm/live-call");
  }, [contact, linkedId, router]);

  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") ?? undefined : undefined;

    apiGet<QueueOperationalStats>("/crm/tasks/stats", token)
      .then(setOpStats)
      .catch(() => setOpStats(null));

    apiGet<DailyReport>("/crm/reports/daily", token)
      .then(setDailyReport)
      .catch(() => setDailyReport(null));

    const params = new URLSearchParams({ filter: "pending", sort: "smart", limit: "4" });
    if (campaignId) params.set("campaignId", campaignId);
    apiGet<{ queue: QueueMember[]; counts: QueueCounts }>(`/crm/queue?${params.toString()}`, token)
      .then((res) => {
        setQueueMembers(res.queue ?? []);
        setQueueCounts(res.counts ?? null);
      })
      .catch(() => {
        setQueueMembers([]);
        setQueueCounts(null);
      });
  }, [campaignId]);

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

  // Keyboard shortcuts: 1–6 set disposition, Enter to save, Shift+Enter save+next (power)
  useEffect(() => {
    function onAnyKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName)) return;
      if (tgt.getAttribute("contenteditable") === "true") return;
      // number keys map to dispositions
      if (!savingOutcome && !disabledOutcome()) {
        if (e.key >= "1" && e.key <= "6") {
          const idx = parseInt(e.key, 10) - 1;
          const d = (DISPOSITION_OPTIONS as readonly string[])[idx];
          if (d) {
            e.preventDefault();
            setDisposition(d);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (!savingOutcome && disposition) {
          e.preventDefault();
          void saveOutcomeRef.current();
        }
      } else if (e.key === "Enter" && e.shiftKey) {
        if (isPowerMode && !savingOutcome && disposition) {
          e.preventDefault();
          void saveOutcomeRef.current();
        }
      }
    }
    window.addEventListener("keydown", onAnyKey);
    return () => window.removeEventListener("keydown", onAnyKey);
  }, [isPowerMode, disposition, savingOutcome]);

  function disabledOutcome() {
    return !contactId || isArchived;
  }

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

  if (!contactId) {
    return (
      <CRMPageShell innerClassName={`${crm.pageInnerLive} ${crm.liveWorkspace}`}>
        <LiveWorkspaceIdle
          stats={idleStats}
          statsLoading={idleStatsLoading}
          recentContactHref={recentWorkspace?.href ?? null}
          recentContactName={recentWorkspace?.name ?? null}
          canSimulateCall={canSimulateLiveCall}
          simulationLoading={simulationLoading}
          simulationError={simulationError}
          onSimulateIncomingCall={startSimulatedIncomingCall}
        />
      </CRMPageShell>
    );
  }

  if (contactWorkspaceHref) {
    return (
      <CRMPageShell innerClassName={`${crm.pageInnerLive} ${crm.liveWorkspace}`}>
        <div className="py-24 text-center text-sm text-crm-muted">Opening contact workspace…</div>
      </CRMPageShell>
    );
  }

  return (
    <CRMPageShell innerClassName={`${crm.pageInnerLive} ${crm.liveWorkspace}`}>
      {canSimulateLiveCall && isSimulatedCall ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-crm-lg border border-crm-accent/20 bg-crm-surface/80 px-4 py-3 text-sm shadow-crm">
          <div>
            <p className="font-semibold text-crm-text">Simulated incoming CRM call</p>
            <p className="text-xs text-crm-muted">Use hang up to return to idle and keep the last-call workspace shortcut.</p>
          </div>
          <button type="button" className="tasks-primary-action" onClick={hangUpSimulatedIncomingCall}>
            Hang up simulation
          </button>
        </div>
      ) : null}

      {loading ? <LoadingSkeleton /> : null}

      {error ? (
        <div className="rounded-crm-lg border border-crm-danger/35 bg-crm-danger/10 px-4 py-3 text-sm text-crm-danger">
          {error}
        </div>
      ) : null}

      {!loading && !error && contact ? (
        <LiveCallCockpit
          contact={contact}
          isArchived={isArchived}
          primaryPhone={primaryPhone}
          canCall={canCall}
          campaignName={campaignName}
          memberId={memberId}
          linkedId={linkedId}
          fromNumber={fromNumber}
          queueBackHref={queueBackHref}
          noteRef={noteRef}
          noteBody={noteBody}
          setNoteBody={setNoteBody}
          savingNote={savingNote}
          noteSavedAt={noteSavedAt}
          onSaveNote={() => void saveNote()}
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
          onSaveOutcome={() => void saveOutcome()}
          timeline={timeline}
          tasks={tasks}
          forms={forms}
          documents={documents}
          callHistory={callHistory}
          checklists={checklists}
          recentChecklistResponses={recentChecklistResponses}
          defaultChecklistId={defaultChecklistId}
          liveContext={liveContext}
          scriptSummaries={scriptSummaries}
          campaignScriptId={campaignScriptId}
          queueMembers={queueMembers}
          queueCounts={queueCounts}
          opStats={opStats}
          dailyReport={dailyReport}
          phone={phone}
          sipNotice={sipNotice}
          callerIdChecked={callerIdChecked}
          callerIdSelected={callerIdSelected}
          callerIdLoading={callerIdLoading}
          onCall={() => void handleCall()}
          onOpenContact={() => router.push(`/crm/contacts/${contact.id}`)}
          onOpenEmail={() => router.push(`/crm/contacts/${contact.id}?workspace=email&returnTo=/crm/live-call`)}
          onRefresh={() => void refreshAll()}
        />
      ) : null}

      {!loading && !error && !contact ? (
        <div className="rounded-crm-lg border border-dashed border-crm-border bg-crm-surface px-6 py-12 text-center text-sm text-crm-muted shadow-crm">
          {liveContext?.reason === "matched_contact_not_in_crm"
            ? "Matched contact is not enabled for CRM."
            : "No CRM contact matched for this call."}
        </div>
      ) : null}
    </CRMPageShell>
  );
}
