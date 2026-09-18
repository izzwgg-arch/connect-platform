"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Button, Chip, Empty, Icon, Skeleton, fmtDate } from "@/components/ui";
import "@/components/events/events.css";

type EventRow = {
  id: string;
  slug: string;
  title: string;
  mode: string;
  startsAt: string;
  endsAt: string;
  venue: string | null;
  onlineUrl: string | null;
  rsvpCount: number;
  capacity: number | null;
};

type MyEventRow = EventRow & { relation: "HOST" | "GOING" | "INTERESTED" | "WAITLIST" };

function fmtWhen(startsAt: string) {
  const d = new Date(startsAt);
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function EventRowItem({ e }: { e: EventRow }) {
  return (
    <Link className="li" href={`/events/${e.slug}`} data-testid={`events-row-${e.slug}`}>
      <Icon name="cal" />
      <div className="t">
        <b>{e.title}</b>
        <small>
          {fmtWhen(e.startsAt)} · {e.mode === "ONLINE" ? "Online" : e.venue ?? (e.mode === "HYBRID" ? "Hybrid" : "In person")}
        </small>
      </div>
      <span className="dim sm">
        <Icon name="people" /> {e.rsvpCount}
        {e.capacity ? `/${e.capacity}` : ""}
      </span>
    </Link>
  );
}

function EventsBody() {
  const [when, setWhen] = useState<"upcoming" | "past">("upcoming");
  const [mode, setMode] = useState<"" | "ONLINE" | "IN_PERSON" | "HYBRID">("");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<EventRow[] | null>(null);
  const [mine, setMine] = useState<MyEventRow[] | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ when });
    if (mode) params.set("mode", mode);
    if (q.trim()) params.set("q", q.trim());
    api<{ items: EventRow[] }>(`/events?${params.toString()}`).then((r) => setItems(r.items));
  }, [when, mode, q]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    api<{ items: MyEventRow[] }>("/me/events").then((r) => setMine(r.items));
  }, []);

  return (
    <>
      <div className="col">
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <div className="tabs">
              <button className={when === "upcoming" ? "on" : ""} onClick={() => setWhen("upcoming")} data-testid="events-tab-upcoming">
                Upcoming
              </button>
              <button className={when === "past" ? "on" : ""} onClick={() => setWhen("past")} data-testid="events-tab-past">
                Past
              </button>
            </div>
            <Button kind="p" icon="plus" href="/events/new" data-testid="events-create">
              Create event
            </Button>
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input className="in" placeholder="Search events…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} data-testid="events-search" />
            <div className="pill-row">
              {(["", "ONLINE", "IN_PERSON", "HYBRID"] as const).map((m) => (
                <Chip key={m || "all"} kind={mode === m ? "sel" : ""} onClick={() => setMode(m)} testId={`events-mode-${m || "all"}`}>
                  {m === "" ? "All" : m === "ONLINE" ? "Online" : m === "IN_PERSON" ? "In person" : "Hybrid"}
                </Chip>
              ))}
            </div>
          </div>
          {items === null ? (
            <Skeleton h={100} />
          ) : items.length === 0 ? (
            <Empty title="No events found" text="Try a different filter, or host your own." />
          ) : (
            <div className="list sm">
              {items.map((e) => (
                <EventRowItem key={e.id} e={e} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="col">
        <div className="card">
          <div className="ct">Your events {mine ? <span className="more">{mine.length}</span> : null}</div>
          {mine === null ? (
            <Skeleton h={60} />
          ) : mine.length === 0 ? (
            <Empty title="You're not hosting or attending anything yet" />
          ) : (
            <div className="list sm">
              {mine.map((e) => (
                <div className="li" key={e.id} data-testid={`events-mine-${e.slug}`}>
                  <Icon name="cal" />
                  <div className="t">
                    <Link href={`/events/${e.slug}`}>
                      <b>{e.title}</b>
                    </Link>
                    <small>{fmtDate(e.startsAt)}</small>
                  </div>
                  <Chip kind={e.relation === "HOST" ? "ac" : e.relation === "GOING" ? "ok" : e.relation === "WAITLIST" ? "warn" : ""}>{e.relation === "HOST" ? "Hosting" : e.relation}</Chip>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="ct">Host an event</div>
          <p className="sm dim">Online, in person or hybrid. Registration, capacity, reminders, chat and a calendar-aware note are included.</p>
          <div style={{ marginTop: 8 }}>
            <Button kind="p" wide icon="plus" href="/events/new" data-testid="events-host">
              Create event
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function EventsPage() {
  return (
    <RequireAuth>
      <AppShell cols="two" title="Events">
        <EventsBody />
      </AppShell>
    </RequireAuth>
  );
}
