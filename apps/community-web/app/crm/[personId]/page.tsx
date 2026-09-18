"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, Empty, Skeleton, useToast } from "@/components/ui";
import { NoteEditor } from "@/components/crm/NoteEditor";
import type { PersonCard } from "@/components/graph/types";
import "@/components/crm/crm.css";

type Reminder = { id: string; title: string; dueAt: string; doneAt: string | null };
type TimelineItem = { kind: string; at: string; title: string; href: string };

export default function CrmContactPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const params = useParams<{ personId: string }>();
  const personId = Array.isArray(params.personId) ? params.personId[0] : params.personId;
  const { me } = useAuth();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [person, setPerson] = useState<PersonCard | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [pushing, setPushing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, rem, tl] = await Promise.all([
        api<{ person: PersonCard }>(`/crm/contacts/${personId}`),
        api<{ items: Reminder[] }>(`/crm/reminders?due=all&personId=${personId}`),
        api<{ items: TimelineItem[] }>(`/crm/timeline?personId=${personId}`),
      ]);
      setPerson(p.person);
      setReminders(rem.items);
      setTimeline(tl.items);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load that contact.", { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [personId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addReminder() {
    if (!title.trim() || !dueAt) return;
    setSaving(true);
    try {
      await api("/crm/reminders", { method: "POST", body: { targetPersonId: personId, title: title.trim(), dueAt: new Date(dueAt).toISOString() } });
      setTitle("");
      setDueAt("");
      toast("Reminder set.");
      await load();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't set that reminder.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  async function toggleReminder(id: string, done: boolean) {
    setReminders((s) => s.map((r) => (r.id === id ? { ...r, doneAt: done ? new Date().toISOString() : null } : r)));
    try {
      await api(`/crm/reminders/${id}`, { method: "PATCH", body: { done } });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't update that reminder.", { kind: "err" });
      await load();
    }
  }

  async function pushToLoopcom() {
    setPushing(true);
    try {
      const r = await api<{ queued: boolean; reason?: string }>("/crm/push-to-loopcom", { method: "POST", body: { personId } });
      toast(r.queued ? "Sent to Loopcom." : (r.reason ?? "Not sent yet."));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't push that to Loopcom.", { kind: "err" });
    } finally {
      setPushing(false);
    }
  }

  if (loading) {
    return (
      <AppShell title="Contact">
        <Skeleton h={160} />
      </AppShell>
    );
  }
  if (!person) {
    return (
      <AppShell title="Contact">
        <Empty title="Not found" />
      </AppShell>
    );
  }

  return (
    <AppShell cols="two" title={person.name}>
      <div className="col">
        <div className="card">
          <div className="row" style={{ alignItems: "center" }}>
            <Link href={`/people/${person.username}`}>
              <Avatar name={person.name} assetId={person.avatarAssetId} size={56} />
            </Link>
            <div className="t">
              <b style={{ fontSize: 18 }}>{person.name}</b>
              <small>{[person.headline, person.primaryOrg?.displayName].filter(Boolean).join(" · ")}</small>
            </div>
            {me?.person.loopcomLinked ? (
              <Button small loading={pushing} onClick={pushToLoopcom} data-testid="crm-contact-push-loopcom">
                Push to Loopcom
              </Button>
            ) : null}
          </div>
        </div>

        <div className="card">
          <div className="ct">Private notes · Only you</div>
          <NoteEditor targetPersonId={personId} />
        </div>
      </div>

      <div className="col">
        <div className="card">
          <div className="ct">Reminders</div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="in" placeholder="Remind me to…" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} data-testid="crm-contact-reminder-title" />
            <input className="in" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} data-testid="crm-contact-reminder-due" />
            <Button small kind="p" loading={saving} disabled={!title.trim() || !dueAt} onClick={addReminder} data-testid="crm-contact-reminder-save">
              Add
            </Button>
          </div>
          {reminders.length === 0 ? (
            <p className="sm dim">No reminders for this contact.</p>
          ) : (
            <div className="list sm" data-testid="crm-contact-reminders-list">
              {reminders.map((r) => (
                <div className="li" key={r.id}>
                  <input type="checkbox" checked={!!r.doneAt} onChange={(e) => toggleReminder(r.id, e.target.checked)} data-testid={`crm-contact-reminder-done-${r.id}`} />
                  <div className="t">
                    <b style={{ textDecoration: r.doneAt ? "line-through" : undefined }}>{r.title}</b>
                    <small>{new Date(r.dueAt).toLocaleString()}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="ct">Timeline</div>
          {timeline.length === 0 ? (
            <Empty title="Nothing yet" text="Notes, reminders, messages and more between you will show up here." />
          ) : (
            <div data-testid="crm-contact-timeline">
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
        </div>
      </div>
    </AppShell>
  );
}
