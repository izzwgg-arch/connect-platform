"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Dialog, Empty, Field, Skeleton, useToast } from "@/components/ui";
import "@/components/events/events.css";

type EventDetail = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  venue: string | null;
  address: string | null;
  onlineUrl: string | null;
  capacity: number | null;
  hostId: string;
};

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditEventForm() {
  const { slug } = useParams<{ slug: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [event, setEvent] = useState<(EventDetail & { startsAt: string; endsAt: string }) | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [venue, setVenue] = useState("");
  const [address, setAddress] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [capacity, setCapacity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  useEffect(() => {
    api<{ event: any }>(`/public/events/${slug}`).then((r) => {
      const e = r.event;
      if (me && e.hostId !== me.person.id) {
        setForbidden(true);
        return;
      }
      setEvent(e);
      setTitle(e.title);
      setDescription(e.description ?? "");
      setVenue(e.venue ?? "");
      setAddress(e.address ?? "");
      setStartsAt(toLocalInputValue(new Date(e.startsAt)));
      setEndsAt(toLocalInputValue(new Date(e.endsAt)));
      setCapacity(e.capacity != null ? String(e.capacity) : "");
    });
  }, [slug, me]);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!event) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/events/${event.id}`, {
        method: "PATCH",
        body: {
          title: title.trim(),
          description: description || undefined,
          venue: venue || undefined,
          address: address || undefined,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          capacity: capacity ? Number(capacity) : null,
        },
      });
      toast("Event updated. Attendees were notified.");
      router.push(`/events/${slug}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't save changes.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelEvent() {
    if (!event) return;
    setCancelBusy(true);
    try {
      await api(`/events/${event.id}`, { method: "DELETE" });
      toast("Event canceled.");
      router.push("/events");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't cancel the event.", { kind: "err" });
    } finally {
      setCancelBusy(false);
    }
  }

  if (forbidden) return <Empty title="You can't edit this event" text="Only the host can make changes." action={<Button href={`/events/${slug}`}>Back to event</Button>} />;
  if (!event) return <Skeleton h={200} />;

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 720 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">Edit event</div>
        <Field label="Title" htmlFor="ee-title">
          <input id="ee-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="event-edit-title" />
        </Field>
        <Field label="Description" htmlFor="ee-desc">
          <textarea id="ee-desc" className="in" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={6000} data-testid="event-edit-description" />
        </Field>
        <div className="event-form-grid">
          <Field label="Starts" htmlFor="ee-start">
            <input id="ee-start" type="datetime-local" className="in" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required data-testid="event-edit-starts" />
          </Field>
          <Field label="Ends" htmlFor="ee-end">
            <input id="ee-end" type="datetime-local" className="in" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required data-testid="event-edit-ends" />
          </Field>
        </div>
        <div className="event-form-grid">
          <Field label="Venue" htmlFor="ee-venue">
            <input id="ee-venue" className="in" value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={200} data-testid="event-edit-venue" />
          </Field>
          <Field label="Address" htmlFor="ee-address">
            <input id="ee-address" className="in" value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} data-testid="event-edit-address" />
          </Field>
        </div>
        <Field label="Capacity" htmlFor="ee-cap" help="Leave blank for unlimited">
          <input id="ee-cap" type="number" min={1} className="in" value={capacity} onChange={(e) => setCapacity(e.target.value)} data-testid="event-edit-capacity" />
        </Field>
        {error ? <p className="error" role="alert">{error}</p> : null}
        <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <Button kind="d" type="button" onClick={() => setCancelOpen(true)} data-testid="event-edit-cancel-event">
            Cancel this event
          </Button>
          <div className="row">
            <Button kind="g" type="button" onClick={() => router.back()}>
              Back
            </Button>
            <Button kind="p" type="submit" loading={busy} data-testid="event-edit-save">
              Save changes
            </Button>
          </div>
        </div>
      </form>
      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel this event?"
        footer={
          <>
            <Button kind="g" onClick={() => setCancelOpen(false)}>Keep event</Button>
            <Button kind="d" loading={cancelBusy} onClick={cancelEvent} data-testid="event-edit-cancel-confirm">
              Cancel event
            </Button>
          </>
        }
      >
        <p className="sm">Everyone who RSVP'd will be notified. This can't be undone.</p>
      </Dialog>
    </div>
  );
}

export default function EditEventPage() {
  return (
    <RequireAuth>
      <AppShell title="Edit event">
        <EditEventForm />
      </AppShell>
    </RequireAuth>
  );
}
