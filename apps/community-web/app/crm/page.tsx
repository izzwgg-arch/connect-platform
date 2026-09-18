"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { API_URL, api, getAccessToken } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Chip, Dialog, Empty, Skeleton, useToast } from "@/components/ui";
import type { PersonCard } from "@/components/graph/types";
import type { Note } from "@/components/crm/NoteEditor";
import "@/components/crm/crm.css";

type Contact = { person: PersonCard; lastContactAt: string | null };
type Reminder = { id: string; title: string; dueAt: string; doneAt: string | null; targetPerson: PersonCard | null; targetOrg: { id: string; displayName: string } | null };
type PipelineGroup = { tag: string; count: number; dealValue: string; items: Note[] };
type TimelineItem = { kind: string; at: string; title: string; href: string };

const TABS = ["contacts", "notes", "reminders", "pipeline"] as const;
type Tab = (typeof TABS)[number];

export default function CrmPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function who(row: { targetPerson: PersonCard | null; targetOrg: { displayName: string } | null }) {
  return row.targetPerson?.name ?? row.targetOrg?.displayName ?? "—";
}

function Inner() {
  const { me } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("contacts");
  const [loading, setLoading] = useState(true);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [dueFilter, setDueFilter] = useState<"today" | "week" | "all">("today");
  const [pipeline, setPipeline] = useState<PipelineGroup[]>([]);

  const [timelineFor, setTimelineFor] = useState<Contact | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [quickNote, setQuickNote] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (which: Tab) => {
      setLoading(true);
      try {
        if (which === "contacts") setContacts((await api<{ items: Contact[] }>("/crm/contacts")).items);
        else if (which === "notes") setNotes((await api<{ items: Note[] }>("/crm/notes")).items);
        else if (which === "reminders") setReminders((await api<{ items: Reminder[] }>(`/crm/reminders?due=${dueFilter}`)).items);
        else if (which === "pipeline") setPipeline((await api<{ groups: PipelineGroup[] }>("/crm/pipeline")).groups);
      } catch (e: any) {
        toast(e?.message ?? "Couldn't load your CRM.", { kind: "err" });
      } finally {
        setLoading(false);
      }
    },
    [dueFilter, toast],
  );

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function openTimeline(c: Contact) {
    setTimelineFor(c);
    setTimeline(null);
    try {
      const r = await api<{ items: TimelineItem[] }>(`/crm/timeline?personId=${c.person.id}`);
      setTimeline(r.items);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load that timeline.", { kind: "err" });
      setTimeline([]);
    }
  }

  async function saveQuickNote(personId: string) {
    const text = (quickNote[personId] ?? "").trim();
    if (!text) return;
    setBusyId(personId);
    try {
      await api("/crm/notes", { method: "POST", body: { targetPersonId: personId, body: text } });
      setQuickNote((q) => ({ ...q, [personId]: "" }));
      toast("Note saved.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that note.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function pushToLoopcom(personId: string) {
    setBusyId(personId);
    try {
      const r = await api<{ queued: boolean; reason?: string }>("/crm/push-to-loopcom", { method: "POST", body: { personId } });
      toast(r.queued ? "Sent to Loopcom." : (r.reason ?? "Not sent yet."));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't push that to Loopcom.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function toggleReminder(id: string, done: boolean) {
    setReminders((s) => s.map((r) => (r.id === id ? { ...r, doneAt: done ? new Date().toISOString() : null } : r)));
    try {
      await api(`/crm/reminders/${id}`, { method: "PATCH", body: { done } });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't update that reminder.", { kind: "err" });
      await load("reminders");
    }
  }

  async function deleteNote(id: string) {
    setNotes((s) => s.filter((n) => n.id !== id));
    try {
      await api(`/crm/notes/${id}`, { method: "DELETE" });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't delete that note.", { kind: "err" });
      await load("notes");
    }
  }

  async function exportCsv() {
    try {
      const token = getAccessToken();
      const res = await fetch(`${API_URL}/crm/export.csv`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "crm-export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't export your CRM.", { kind: "err" });
    }
  }

  return (
    <AppShell title="My CRM">
      <div className="card" style={{ gridColumn: "1/-1" }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} type="button" className={tab === t ? "on" : ""} onClick={() => setTab(t)} data-testid={`crm-tab-${t}`}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          <Button small icon="dl" onClick={exportCsv} data-testid="crm-export">
            Export CSV
          </Button>
        </div>

        {loading ? (
          <div className="list">
            <Skeleton h={56} />
            <Skeleton h={56} />
          </div>
        ) : tab === "contacts" ? (
          contacts.length === 0 ? (
            <Empty title="No contacts yet" text="Connect with people, or add a note about someone, and they'll show up here." />
          ) : (
            <div className="list" data-testid="crm-contacts-list">
              {contacts.map((c) => (
                <div className="li" key={c.person.id}>
                  <Link href={`/people/${c.person.username}`}>
                    <Avatar name={c.person.name} assetId={c.person.avatarAssetId} size={40} />
                  </Link>
                  <div className="t">
                    <Link href={`/crm/${c.person.id}`} data-testid={`crm-open-${c.person.id}`}>
                      <b>{c.person.name}</b>
                    </Link>
                    <small>{[c.person.headline, c.lastContactAt ? `last contact ${new Date(c.lastContactAt).toLocaleDateString()}` : null].filter(Boolean).join(" · ")}</small>
                  </div>
                  <input
                    className="in"
                    placeholder="Quick note…"
                    value={quickNote[c.person.id] ?? ""}
                    onChange={(e) => setQuickNote((q) => ({ ...q, [c.person.id]: e.target.value }))}
                    style={{ maxWidth: 180 }}
                    data-testid={`crm-quicknote-${c.person.id}`}
                  />
                  <Button small loading={busyId === c.person.id} onClick={() => saveQuickNote(c.person.id)} data-testid={`crm-quicknote-save-${c.person.id}`}>
                    Save
                  </Button>
                  <Button small onClick={() => openTimeline(c)} data-testid={`crm-timeline-${c.person.id}`}>
                    Timeline
                  </Button>
                  {me?.person.loopcomLinked ? (
                    <Button small loading={busyId === c.person.id} onClick={() => pushToLoopcom(c.person.id)} data-testid={`crm-push-loopcom-${c.person.id}`}>
                      Push to Loopcom
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )
        ) : tab === "notes" ? (
          notes.length === 0 ? (
            <Empty title="No notes yet" text="Notes you add about people or businesses show up here." />
          ) : (
            <div className="list" data-testid="crm-notes-list">
              {notes.map((n) => (
                <div className="li" key={n.id} style={{ alignItems: "flex-start" }}>
                  <div className="t">
                    <div>{n.body}</div>
                    <div className="row" style={{ marginTop: 4 }}>
                      {n.tags.map((t) => (
                        <Chip key={t}>{t}</Chip>
                      ))}
                    </div>
                    <small className="dim">{new Date(n.createdAt).toLocaleDateString()}</small>
                  </div>
                  <button type="button" className="ib" aria-label="Delete note" onClick={() => deleteNote(n.id)} data-testid={`crm-note-delete-${n.id}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )
        ) : tab === "reminders" ? (
          <>
            <div className="crm-due-filters">
              {(["today", "week", "all"] as const).map((d) => (
                <Button key={d} small kind={dueFilter === d ? "p" : ""} onClick={() => setDueFilter(d)} data-testid={`crm-due-${d}`}>
                  {d[0].toUpperCase() + d.slice(1)}
                </Button>
              ))}
            </div>
            {reminders.length === 0 ? (
              <Empty title="No reminders" text="Set a reminder on a contact's page and it'll show up here." />
            ) : (
              <div className="list" data-testid="crm-reminders-list">
                {reminders.map((r) => (
                  <div className="li" key={r.id}>
                    <input type="checkbox" checked={!!r.doneAt} onChange={(e) => toggleReminder(r.id, e.target.checked)} data-testid={`crm-reminder-done-${r.id}`} />
                    <div className="t">
                      <b style={{ textDecoration: r.doneAt ? "line-through" : undefined }}>{r.title}</b>
                      <small>
                        {who(r)} · {new Date(r.dueAt).toLocaleDateString()}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : pipeline.length === 0 ? (
          <Empty title="No pipeline yet" text="Tag notes (e.g. 'hot', 'customer') and a deal value to build your pipeline." />
        ) : (
          <div data-testid="crm-pipeline-list">
            {pipeline.map((g) => (
              <div className="crm-pipeline-row" key={g.tag}>
                <div>
                  <Chip>{g.tag}</Chip> <small className="dim">{g.count} note{g.count === 1 ? "" : "s"}</small>
                </div>
                <b>${g.dealValue}</b>
                <span />
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={!!timelineFor} onClose={() => setTimelineFor(null)} title={timelineFor ? `Timeline — ${timelineFor.person.name}` : "Timeline"} wide>
        {timeline === null ? (
          <Skeleton h={80} />
        ) : timeline.length === 0 ? (
          <Empty title="Nothing yet" text="Notes, reminders, messages and more between you will show up here." />
        ) : (
          <div data-testid="crm-timeline-list">
            {timeline.map((t, i) => (
              <div className="crm-timeline-item" key={i}>
                <div className="crm-timeline-kind">{t.kind}</div>
                <div>
                  <Link href={t.href}>{t.title}</Link>
                  <div>
                    <small className="dim">{new Date(t.at).toLocaleString()}</small>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </AppShell>
  );
}
