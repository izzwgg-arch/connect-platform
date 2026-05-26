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
  type LiveContact,
  type ScriptSummary,
  type TimelineEvent,
} from "../../../../components/crm";
import { DISPOSITION_OPTIONS } from "../../../../components/crm/live";
import type { QueueCounts, QueueMember, QueueOperationalStats } from "../../../../components/crm/queue/queueTypes";
import { apiGet, apiPatch, apiPost } from "../../../../services/apiClient";
import { useSipPhone } from "../../../../hooks/useSipPhone";

const TIMELINE_LIMIT = 25;

type DailyReport = {
  dispositionsToday?: number;
  callsLinkedToday?: number;
  contactsCreatedToday?: number;
  activeCampaigns?: number;
  queueRemaining?: number;
};

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
      apiGet<{ scripts: ScriptSummary[] }>("/crm/scripts").catch(() => ({ scripts: [] as ScriptSummary[] })),
    ];
    if (campaignId) {
      fetches.push(
        apiGet<{ campaign: { name: string; scriptId: string | null } }>(
          `/crm/campaigns/${campaignId}`,
        ).catch(() => null),
      );
    }

    Promise.all(fetches)
      .then((results) => {
        const [contactRes, tasksRes, timelineRes, scriptsRes, campaignRes] = results as [
          { contact: LiveContact },
          { tasks: CrmTask[] },
          { events: TimelineEvent[] },
          { scripts: ScriptSummary[] },
          { campaign: { name: string; scriptId: string | null } } | null | undefined,
        ];
        const c = contactRes.contact ?? (contactRes as unknown as LiveContact);
        setContact(c);
        setTasks(tasksRes.tasks ?? []);
        setTimeline(timelineRes.events ?? []);
        setScriptSummaries(scriptsRes.scripts ?? []);
        if (campaignRes?.campaign) {
          setCampaignName(campaignRes.campaign.name);
          setCampaignScriptId(campaignRes.campaign.scriptId);
        }
      })
      .catch((err: unknown) => {
        setError(String((err as Error)?.message ?? "Failed to load contact"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

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
        <LiveWorkspaceIdle stats={idleStats} statsLoading={idleStatsLoading} />
      </CRMPageShell>
    );
  }

  return (
    <CRMPageShell innerClassName={`${crm.pageInnerLive} ${crm.liveWorkspace}`}>
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
        />
      ) : null}

      {!loading && !error && !contact ? (
        <div className="py-12 text-center text-sm text-crm-muted">Contact not found.</div>
      ) : null}
    </CRMPageShell>
  );
}
