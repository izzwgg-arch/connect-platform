"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, API_URL, ApiError, getAccessToken, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Icon, Skeleton, useToast } from "@/components/ui";
import "@/components/events/events.css";

type PersonCard = { id: string; username: string; name: string; avatarAssetId: string | null };
type OrgCard = { id: string; slug: string; displayName: string; logoAssetId?: string | null };

type EventDetail = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  mode: string;
  startsAt: string;
  endsAt: string;
  venue: string | null;
  address: string | null;
  onlineUrl: string | null;
  isFree: boolean;
  price: string | null;
  capacity: number | null;
  attendeeListVisibility: string;
  speakers: Array<{ name: string; title?: string }> | null;
  sponsors: Array<{ name: string; url?: string }> | null;
  chatThreadId: string | null;
  host: PersonCard | null;
  organization: OrgCard | null;
  group: { id: string; slug: string; name: string } | null;
  calendarNote: string | null;
  hostId: string;
};

type EventPublicRes = {
  event: EventDetail;
  myRsvp: { status: string; visible: boolean } | null;
  counts: { going: number; interested: number; spotsLeft: number | null };
  attendeeListVisible: boolean;
  attendees: Array<{ person: PersonCard; status: string }>;
  inYourNetwork: { count: number; people: PersonCard[] };
  calendar: { icsUrl: string; googleUrl: string };
};

function fmtRange(startsAt: string, endsAt: string) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const dateStr = s.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const startTime = s.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const endTime = e.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${dateStr} · ${startTime}–${endTime}`;
}

export default function EventDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [res, setRes] = useState<EventPublicRes | null>(null);
  const [notFound404, setNotFound404] = useState(false);
  const [rsvpBusy, setRsvpBusy] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(() => {
    api<EventPublicRes>(`/public/events/${slug}`)
      .then(setRes)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound404(true);
      });
  }, [slug]);

  useEffect(() => {
    setRes(null);
    setNotFound404(false);
    load();
  }, [load]);

  async function rsvp(status: "GOING" | "INTERESTED") {
    if (!res) return;
    if (!me) {
      router.push(`/login?next=${encodeURIComponent(`/events/${slug}`)}`);
      return;
    }
    setRsvpBusy(true);
    try {
      const r = await api<{ status: string }>(`/events/${res.event.id}/rsvp`, { method: "POST", body: { status }, idempotencyKey: newIdempotencyKey() });
      toast(r.status === "WAITLIST" ? "This event is full — you're on the waitlist." : "You're in.");
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't RSVP.", { kind: "err" });
    } finally {
      setRsvpBusy(false);
    }
  }

  async function cancelRsvp() {
    if (!res) return;
    try {
      await api(`/events/${res.event.id}/rsvp`, { method: "DELETE" });
      toast("Registration canceled.");
      load();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't cancel.", { kind: "err" });
    }
  }

  async function openChat() {
    if (!res) return;
    try {
      const r = await api<{ threadId: string }>(`/events/${res.event.id}/chat`);
      router.push(`/messages/${r.threadId}`);
    } catch (err) {
      toast((err as ApiError).message ?? "RSVP as going to open the chat.", { kind: "err" });
    }
  }

  async function addToCalendar() {
    if (!res) return;
    const token = getAccessToken();
    try {
      const resp = await fetch(`${API_URL}/events/${res.event.id}/ics`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!resp.ok) throw new Error("download failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${res.event.slug}.ics`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("Couldn't download the calendar file.", { kind: "err" });
    }
  }

  async function share() {
    if (!res) return;
    const url = `${window.location.origin}/events/${res.event.slug}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: res.event.title, url });
        return;
      } catch {
        /* user canceled */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Link copied.");
    } catch {
      toast(url);
    }
  }

  if (notFound404) {
    const body = <div className="col" style={{ gridColumn: "1/-1" }}><Empty title="That event doesn't exist" action={<Button href="/events">Back to events</Button>} /></div>;
    return me ? <AppShell title="Event not found">{body}</AppShell> : <div className="content">{body}</div>;
  }

  if (!res) {
    const body = <div className="col" style={{ gridColumn: "1/-1" }}><Skeleton h={220} /></div>;
    return me ? <AppShell title="Event">{body}</AppShell> : <div className="content">{body}</div>;
  }

  const { event } = res;
  const isHost = me?.person.id === event.hostId;
  const isGoing = res.myRsvp?.status === "GOING";
  const isWaitlist = res.myRsvp?.status === "WAITLIST";
  const isInterested = res.myRsvp?.status === "INTERESTED";

  const content = (
    <div className="col">
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div className="cover" />
        <div style={{ padding: "16px 18px", display: "grid", gap: 10 }}>
          <div className="row event-hero-chips">
            <Chip kind="ac" icon={event.mode === "ONLINE" ? "globe" : "cal"}>
              {event.mode === "ONLINE" ? "Online" : event.mode === "HYBRID" ? "Hybrid" : "In person"}
            </Chip>
            {isGoing ? <Chip kind="ok" icon="check">Registered</Chip> : isWaitlist ? <Chip kind="warn">Waitlisted</Chip> : isInterested ? <Chip>Interested</Chip> : null}
            <Chip>{event.isFree ? "Free" : `$${event.price}`}</Chip>
            <div className="event-hero-actions">
              <Button kind="g" small icon="cal" onClick={addToCalendar} data-testid="event-add-calendar">
                Add to calendar
              </Button>
              <a className="btn g s" href={res.calendar.googleUrl} target="_blank" rel="noreferrer" data-testid="event-google-calendar">
                Google Calendar
              </a>
              <Button kind="g" small icon="share" onClick={share} data-testid="event-share">
                Share
              </Button>
              {isHost ? (
                <Button kind="g" small icon="edit" href={`/events/${event.slug}/edit`} data-testid="event-edit">
                  Edit
                </Button>
              ) : null}
            </div>
          </div>
          <h1 style={{ fontSize: 20 }}>{event.title}</h1>
          <div className="row sm dim">
            <span><Icon name="clock" /> {fmtRange(event.startsAt, event.endsAt)}</span>
            {event.mode !== "ONLINE" && (event.venue || event.address) ? (
              <span><Icon name="pin" /> {[event.venue, event.address].filter(Boolean).join(", ")}</span>
            ) : null}
            {event.mode !== "IN_PERSON" && isGoing && event.onlineUrl ? (
              <a href={event.onlineUrl} target="_blank" rel="noreferrer"><Icon name="link" /> Join link</a>
            ) : null}
            <span>
              <Icon name="people" /> {res.counts.going} going{res.counts.spotsLeft != null ? ` · ${res.counts.spotsLeft} spots left` : ""}
            </span>
          </div>
          {event.calendarNote ? (
            <div className="why">
              <Icon name="cal" />
              <span>{event.calendarNote}</span>
            </div>
          ) : null}
          {event.description ? <p className="sm">{event.description}</p> : null}
          <div className="row">
            {isGoing || isWaitlist ? (
              <Button kind="g" small onClick={cancelRsvp} data-testid="event-cancel-rsvp">
                Cancel registration
              </Button>
            ) : (
              <>
                <Button kind="p" small loading={rsvpBusy} onClick={() => rsvp("GOING")} data-testid="event-rsvp-going">
                  {res.counts.spotsLeft === 0 ? "Join waitlist" : "I'm going"}
                </Button>
                <Button kind="g" small loading={rsvpBusy} onClick={() => rsvp("INTERESTED")} data-testid="event-rsvp-interested">
                  Interested
                </Button>
              </>
            )}
            <Button kind="g" small icon="people" onClick={() => setInviteOpen(true)} data-testid="event-invite">
              Invite connections
            </Button>
            {isGoing || isHost ? (
              <Button kind="g" small icon="chat" onClick={openChat} data-testid="event-chat">
                Event chat
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {event.speakers && event.speakers.length ? (
        <div className="card">
          <div className="ct">Speakers</div>
          <div className="event-speaker-grid">
            {event.speakers.map((s, i) => (
              <div className="li" key={i}>
                <Avatar name={s.name} size={40} />
                <div className="t">
                  <b>{s.name}</b>
                  <small>{s.title}</small>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {event.sponsors && event.sponsors.length ? (
        <div className="card">
          <div className="ct">Sponsors</div>
          <div className="pill-row">
            {event.sponsors.map((s, i) =>
              s.url ? (
                <a key={i} className="chip" href={s.url} target="_blank" rel="noreferrer">
                  {s.name}
                </a>
              ) : (
                <span key={i} className="chip">
                  {s.name}
                </span>
              ),
            )}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="ct">
          Who's going <span className="more">{res.counts.going}</span>
        </div>
        {!res.attendeeListVisible ? (
          <Empty title="The attendee list is private" text="Only the host can see who's going." />
        ) : res.attendees.length === 0 ? (
          <Empty title="Nobody has RSVP'd yet" />
        ) : (
          <>
            {res.inYourNetwork.count > 0 ? (
              <p className="sm dim" style={{ marginBottom: 8 }}>
                <b style={{ color: "var(--text)" }}>
                  {res.inYourNetwork.count} {res.inYourNetwork.count === 1 ? "person" : "people"} you know
                </b>{" "}
                {res.inYourNetwork.count === 1 ? "is" : "are"} going: {res.inYourNetwork.people.map((p) => p.name).join(", ")}.
              </p>
            ) : null}
            <div className="row">
              {res.attendees.slice(0, 20).map((a) => (
                <Avatar key={a.person.id} name={a.person.name} assetId={a.person.avatarAssetId} size={34} />
              ))}
              {res.attendees.length > 20 ? <span className="dim sm">+{res.attendees.length - 20}</span> : null}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const sidebar = (
    <div className="col">
      <div className="card">
        <div className="ct">Hosted by</div>
        <div className="li">
          <Avatar name={event.organization?.displayName ?? event.host?.name ?? "Host"} assetId={event.organization?.logoAssetId ?? event.host?.avatarAssetId} size={38} square={!!event.organization} />
          <div className="t">
            {event.organization ? (
              <Link href={`/companies/${event.organization.slug}`}>
                <b>{event.organization.displayName}</b>
              </Link>
            ) : event.host ? (
              <Link href={`/people/${event.host.username}`}>
                <b>{event.host.name}</b>
              </Link>
            ) : (
              <b>Host</b>
            )}
            {event.group ? (
              <small>
                Group event · <Link href={`/groups/${event.group.slug}`}>{event.group.name}</Link>
              </small>
            ) : null}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="ct">Host an event</div>
        <p className="sm dim">Online, in person or hybrid. Registration, capacity, reminders and chat included.</p>
        <div style={{ marginTop: 8 }}>
          <Button kind="p" wide icon="plus" href="/events/new" data-testid="event-sidebar-create">
            Create event
          </Button>
        </div>
      </div>
    </div>
  );

  const inviteDialog = <InviteConnectionsDialog eventId={event.id} open={inviteOpen} onClose={() => setInviteOpen(false)} />;

  if (me) {
    return (
      <AppShell cols="two" title={event.title}>
        {content}
        {sidebar}
        {inviteDialog}
      </AppShell>
    );
  }

  return (
    <div className="content two">
      {content}
      {sidebar}
      {inviteDialog}
    </div>
  );
}

function InviteConnectionsDialog({ eventId, open, onClose }: { eventId: string; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [connections, setConnections] = useState<PersonCard[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api<{ items: Array<{ person: PersonCard }> }>("/connections?limit=100")
      .then((r) => setConnections(r.items.map((i) => i.person)))
      .catch(() => setConnections([]));
  }, [open]);

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    if (!picked.size) return;
    setBusy(true);
    try {
      await api(`/events/${eventId}/invite`, { method: "POST", body: { personIds: [...picked] }, idempotencyKey: newIdempotencyKey() });
      toast("Invitations sent.");
      setPicked(new Set());
      onClose();
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send invites.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Invite connections">
      {connections === null ? (
        <Skeleton h={80} />
      ) : connections.length === 0 ? (
        <Empty title="No connections to invite yet" />
      ) : (
        <div className="list sm" style={{ maxHeight: 320, overflow: "auto" }}>
          {connections.map((c) => (
            <label className="li" key={c.id} style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} data-testid={`event-invite-pick-${c.id}`} />
              <Avatar name={c.name} assetId={c.avatarAssetId} size={30} />
              <div className="t">
                <b>{c.name}</b>
              </div>
            </label>
          ))}
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
        <Button kind="g" onClick={onClose}>
          Cancel
        </Button>
        <Button kind="p" loading={busy} disabled={!picked.size} onClick={submit} data-testid="event-invite-send">
          Send invites
        </Button>
      </div>
    </Dialog>
  );
}
